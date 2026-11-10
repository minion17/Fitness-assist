"""Bot reminders: missed meals, water behind schedule, a streak about to break, habits at their time, Sunday summary.

`collect` decides what to send (pure DB logic, tested); `run` is the bot's background loop that sends it.
Reminder times are in each user's own timezone (the phone's).
"""
import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from functools import partial

from backend.api.daily import is_active, local_start, streak_state, water_goal
from backend.bot import cards
from backend.core import alerts, clock
from backend.core.nutrition import daily_targets
from backend.database.db import SessionLocal
from backend.database.models import (
    BodyMeasurement, FoodLog, Habit, HabitCheck, Product, Profile, ReminderSent, ReminderSettings, User, WaterIntake,
)

log = logging.getLogger("reminders")

MEALS = {"breakfast": "завтрак", "lunch": "обед", "dinner": "ужин"}
Render = partial  # a deferred card drawing: called in a worker thread just before sending
NO_CARD = Render(lambda: None)  # text-only message
# Extra buttons above "Открыть": (text, "cb:<callback data>") or (text, "app:<query>") — the Mini App opened with ?<query>
Buttons = list[tuple[str, str]] | None
# (time, share of the daily goal that should be drunk by then)
WATER_CHECKS = (("12:00", 0.35), ("16:00", 0.6), ("19:00", 0.85))
WINDOW = timedelta(minutes=45)  # a reminder missed by a restart is still sent within this window, not hours later


def liters(ml: float) -> str:
    return f"{ml / 1000:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def due(at: str, now: datetime) -> bool:
    h, m = map(int, at.split(":"))
    start = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return start <= now < start + WINDOW


async def eaten_today(session, user: User, start: datetime) -> tuple[set[str], dict[str, float]]:
    """Meal types logged today and totals (kcal, protein, fat, carbs)."""
    rows = (await session.execute(
        select(FoodLog.meal_type, FoodLog.amount_g, Product.kcal, Product.protein_g, Product.fat_g, Product.carbs_g)
        .join(Product, Product.id == FoodLog.product_id)
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= start)
    )).all()
    totals = {k: sum(r[i + 2] * r[1] / 100 for r in rows) for i, k in enumerate(("kcal", "protein", "fat", "carbs"))}
    return {r[0] for r in rows}, totals


async def weekly_summary(session, user: User, today, look: dict) -> tuple[str, str, Render, Buttons]:
    from backend.api.ai import weekly_tip
    from backend.api.stats import daily_series, targets

    days = await daily_series(session, user, today - timedelta(days=6), today)
    goal = targets(await session.get(Profile, user.id))
    n, _ = await streak_state(session, user, today)
    weights = list(await session.scalars(
        select(BodyMeasurement.weight_kg).where(
            BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None),
            BodyMeasurement.measured_on >= today - timedelta(days=13),
        ).order_by(BodyMeasurement.measured_on)
    ))
    delta = round(weights[-1] - weights[0], 1) if len(weights) > 1 else None
    logged = [d for d in days if d["kcal"] > 0]
    in_norm = sum(1 for d in logged if goal and abs(d["kcal"] - goal["calories"]) <= 0.1 * goal["calories"])
    water = [d["water_ml"] for d in days if d["water_ml"] > 0]
    workouts = sum(d["workouts"] for d in days)
    text = (f"📊 Итоги недели: {in_norm} из 7 дней в норме"
            + (f", в среднем {round(sum(d['kcal'] for d in logged) / len(logged))} ккал" if logged else "")
            + f", тренировок — {workouts}.")
    ticks = await session.scalar(select(func.count()).where(HabitCheck.user_id == user.id, HabitCheck.day > today - timedelta(days=7)))
    if ticks:
        text += f" Привычки отмечены {ticks} раз."
    tip = await weekly_tip(session, user)
    if tip:
        text = f"{text}\n\n{tip}"[:1000]  # Telegram photo captions are limited to 1024 characters
    card = Render(cards.weekly, [{"date": d["date"], "kcal": d["kcal"]} for d in days], goal and goal["calories"], n,
                  workouts, sum(water) / len(water) if water else 0, delta, **look)
    return f"{today}:weekly", text, card, [("📸 Неделя в историю", "app:open=story")]


async def habit_reminders(session, user: User, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """Habits whose reminder time has come and that aren't ticked today: one message per time, a ✓ button each."""
    today = now.date()
    habits = list(await session.scalars(select(Habit).where(Habit.user_id == user.id, Habit.archived.is_(False),
                                                           Habit.remind_at.is_not(None)).order_by(Habit.id)))
    due_now = [h for h in habits if due(h.remind_at, now)]
    if not due_now:
        return []
    done = set(await session.scalars(select(HabitCheck.habit_id).where(HabitCheck.user_id == user.id, HabitCheck.day == today)))
    out = []
    for at in sorted({h.remind_at for h in due_now}):
        todo = [h for h in due_now if h.remind_at == at and h.id not in done]
        if todo:
            names = ", ".join(f"{h.emoji} {h.title}" for h in todo)
            out.append((f"{today}:habits{at}", f"⏰ Время привычки: {names}. Отметьте прямо здесь — серия продлится.",
                        NO_CARD, [(f"✓ {h.emoji} {h.title}"[:60], f"cb:hb:{h.id}") for h in todo]))
    return out


async def candidates(session, user: User, cfg: ReminderSettings, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """(key, caption, card, buttons) of reminders that are due for this user right now and still make sense."""
    today = now.date()
    look = {"theme": user.theme if user.theme in cards.THEMES else None, "accent": user.accent}
    out = []
    if cfg.meals:
        todo = [m for m in MEALS if due(getattr(cfg, f"{m}_at"), now)]
        if todo:
            eaten, t = await eaten_today(session, user, local_start(today))
            p = await session.get(Profile, user.id)
            goal = daily_targets(p.sex, p.birth_year, p.height_cm, p.weight_kg, p.activity, p.goal)
            macros = {"Белки": (t["protein"], goal["protein"]), "Жиры": (t["fat"], goal["fat"]), "Углеводы": (t["carbs"], goal["carbs"])}
            out += [(f"{today}:{m}", f"🍽 Не забудьте записать {MEALS[m]} — так норма КБЖУ будет честной.",
                     Render(cards.meal, MEALS[m].capitalize(), t["kcal"], goal["calories"], macros, **look), None)
                    for m in todo if m not in eaten]
    if cfg.water:
        for at, share in WATER_CHECKS:
            if due(at, now):
                goal = water_goal(await session.get(Profile, user.id))
                ml = await session.scalar(
                    select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)
                ) or 0
                if ml < goal * share:
                    out.append((f"{today}:water{at}", f"💧 Выпито {liters(ml)} л из {liters(goal)} л. Стакан воды сейчас — самое время.",
                                Render(cards.water, ml, goal, at, **look), None))
    if getattr(cfg, "weekly", True) and now.weekday() == 6 and due(cfg.weekly_at or "19:00", now):
        out.append(await weekly_summary(session, user, today, look))
    if cfg.streak and due(cfg.streak_at, now):
        n, days = await streak_state(session, user, today)
        if n > 0 and not (today in days and is_active(days[today])):
            week = [today - timedelta(days=i) in days and is_active(days[today - timedelta(days=i)]) for i in range(6, -1, -1)]
            out.append((f"{today}:streak", f"🔥 Серия {n} дн. подряд сгорит сегодня — запишите хоть что-нибудь: еду, воду или тренировку.",
                        Render(cards.streak, n, week, **look), None))
    out += await habit_reminders(session, user, now)
    return out


async def collect(session, now: datetime) -> list[tuple[int, str, Render, Buttons]]:
    """(telegram_id, caption, card, buttons) to send now. Each reminder is recorded first, so it is sent at most once."""
    rows = await session.execute(
        select(User, ReminderSettings).join(Profile, Profile.user_id == User.id)  # registered users only
        .outerjoin(ReminderSettings, ReminderSettings.user_id == User.id)
    )
    messages = []
    for user, cfg in rows.all():
        clock.use_tz(user.device_tz)
        cfg = cfg or ReminderSettings(meals=True, water=True, streak=True, weekly=True, breakfast_at="10:00",
                                      lunch_at="14:00", dinner_at="20:00", streak_at="21:00", weekly_at="19:00")
        for key, text, card, buttons in await candidates(session, user, cfg, clock.local(now)):
            fresh = await session.scalar(
                insert(ReminderSent).values(user_id=user.id, key=key).on_conflict_do_nothing().returning(ReminderSent.key)
            )
            if fresh:
                messages.append((user.telegram_id, text, card, buttons))
    clock.use_tz(None)
    await session.commit()
    return messages


def markup(buttons: Buttons, keyboard, app_url: str):
    """Extra buttons (one per row) above the usual "Открыть" keyboard."""
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

    rows = []
    for text, action in buttons or []:
        kind, _, value = action.partition(":")
        if kind == "cb":
            rows.append([InlineKeyboardButton(text=text, callback_data=value)])
        elif app_url.startswith("https://"):
            rows.append([InlineKeyboardButton(text=text, web_app=WebAppInfo(url=f"{app_url}{'&' if '?' in app_url else '?'}{value}"))])
    base = keyboard()
    rows += base.inline_keyboard if base else []
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


async def run(bot, keyboard, app_url=lambda: "") -> None:
    """Check once a minute; never let one failure stop the loop."""
    from aiogram.exceptions import TelegramForbiddenError
    from aiogram.types import BufferedInputFile

    while True:
        try:
            async with SessionLocal() as session:
                batch = await collect(session, datetime.now().astimezone())
            for chat_id, text, card, buttons in batch:
                try:
                    try:
                        png = await asyncio.to_thread(card)  # ~0.3 s of drawing: keep it off the event loop
                    except Exception:
                        log.warning("card for %s failed, sending text only", chat_id, exc_info=True)
                        png = None
                    kb = markup(buttons, keyboard, app_url())
                    if png:
                        await bot.send_photo(chat_id, BufferedInputFile(png, "card.png"), caption=text, reply_markup=kb)
                    else:
                        await bot.send_message(chat_id, text, reply_markup=kb)
                except TelegramForbiddenError:
                    log.info("user %s blocked the bot", chat_id)  # nothing to do; they can /start again
                except Exception:
                    log.warning("reminder to %s failed", chat_id, exc_info=True)
                await asyncio.sleep(0.05)  # stay far below Telegram's 30 msg/s limit
        except Exception as e:
            log.exception("reminder loop failed")
            await alerts.report("бот: напоминания", alerts.describe(e))
        await asyncio.sleep(60)


