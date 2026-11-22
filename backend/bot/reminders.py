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

from backend.api import fasting
from backend.api.daily import is_active, local_start, streak_state, water_goal
from backend.api.kitchen import usual_for
from backend.bot import cards
from backend.core import alerts, clock
from backend.api.stats import today_targets
from backend.database.db import SessionLocal
from backend.database.models import (
    BodyMeasurement, DailyCheckin, FastingPlan, FoodLog, Habit, HabitCheck, Product, Profile, ReminderSent, ReminderSettings, User, WaterIntake,
    WorkoutLog,
)

log = logging.getLogger("reminders")

MEALS = {"breakfast": "завтрак", "lunch": "обед", "dinner": "ужин"}
Render = partial  # a deferred card drawing: called in a worker thread just before sending
NO_CARD = Render(lambda: None)  # text-only message
# Extra buttons above "Открыть": (text, "cb:<callback data>") or (text, "app:<query>") — the Mini App opened with ?<query>
Buttons = list[tuple[str, str]] | None
# (time, share of the daily goal that should be drunk by then)
WATER_CHECKS = (("12:00", 0.35), ("16:00", 0.6), ("19:00", 0.85))
PROTEIN_CHECK = "16:30"  # the afternoon protein check (meal reminders on)
WINDOW = timedelta(minutes=45)  # a reminder missed by a restart is still sent within this window, not hours later


def liters(ml: float) -> str:
    return f"{ml / 1000:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def due(at: str, now: datetime) -> bool:
    h, m = map(int, at.split(":"))
    start = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return start <= now < start + WINDOW


async def eaten_today(session, user: User, start: datetime, until: datetime | None = None) -> tuple[set[str], dict[str, float]]:
    """Meal types logged since `start` (until `until`) and totals (kcal, protein, fat, carbs)."""
    rows = (await session.execute(
        select(FoodLog.meal_type, FoodLog.amount_g, Product.kcal, Product.protein_g, Product.fat_g, Product.carbs_g)
        .join(Product, Product.id == FoodLog.product_id)
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= start, *([FoodLog.logged_at < until] if until else []))
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
    from backend.api.energy import plateau

    buttons: list = [("📸 Неделя в историю", "app:open=story")]
    stuck = await plateau(session, user, await session.get(Profile, user.id))
    if stuck["plateau"]:  # more useful than a general tip this week
        text += "\n\n⚖️ Вес стоит две недели. " + " ".join(stuck["plateau_tips"][:2])
        if stuck["plateau_kcal"]:
            buttons.insert(0, (f"Сделать норму {stuck['plateau_kcal']} ккал", f"cb:kc:{stuck['plateau_kcal']}"))
    elif tip := await weekly_tip(session, user):
        text = f"{text}\n\n{tip}"
    text = text[:1000]  # Telegram photo captions are limited to 1024 characters
    card = Render(cards.weekly, [{"date": d["date"], "kcal": d["kcal"]} for d in days], goal and goal["calories"], n,
                  workouts, sum(water) / len(water) if water else 0, delta, **look)
    return f"{today}:weekly", text, card, buttons


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
            out.append((f"{today}:habits{at}", f"⏰ Время привычки: {names}. Отметь прямо здесь — серия продлится.",
                        NO_CARD, [(f"✓ {h.emoji} {h.title}"[:60], f"cb:hb:{h.id}") for h in todo]))
    return out


async def day_one(session, user: User, today) -> tuple[str, str, Render, Buttons]:
    """The evening of the first day: what got logged, and one small step for tomorrow."""
    eaten, t = await eaten_today(session, user, local_start(today))
    ml = await session.scalar(select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)) or 0
    if eaten or ml:
        parts = [f"записано приёмов пищи: {len(eaten)}, {round(t['kcal'])} ккал" if eaten else "", f"воды {liters(ml)} л" if ml else ""]
        text = f"🌙 Первый день с Setly: {', '.join(p for p in parts if p)}. Отличный старт — завтра будет ещё проще."
    else:
        text = ("🌙 Первый день позади. Завтра начни с малого: напиши сюда завтрак, например «овсянка 60 г, банан», — "
                "я посчитаю и запишу. Это 10 секунд.")
    return "onb:day1", text, NO_CARD, None


async def day_close(session, user: User, today) -> tuple[str, str, Render, Buttons] | None:
    """Evening of a day with entries: where the day landed and the one thing worth fixing (protein, water, dinner)."""
    p = await session.get(Profile, user.id)
    eaten, t = await eaten_today(session, user, local_start(today))
    if not eaten:
        return None  # water or a workout only: the streak is safe, nothing to sum up
    goal = (await today_targets(session, user, p))
    kcal, norm = round(t["kcal"]), goal["calories"]
    text = f"🌙 Итог дня: {kcal:,} из {norm:,} ккал".replace(",", " ")
    if kcal > norm * 1.1:
        text += " — чуть выше нормы. Ничего страшного, завтра новый день."
    elif kcal >= norm * 0.9:
        text += " — в норме 👌"
    else:
        text += "."
    short = goal["protein"] - t["protein"]
    picks: Buttons = None
    if short >= goal["protein"] * 0.15:
        line, picks = await protein_offer(session, user, short, norm - t["kcal"], "s")
        text += f" Белка не хватает {round(short)} г{line}"
    ml = await session.scalar(select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)) or 0
    if ml < water_goal(p) * 0.7:
        text += f" Воды {liters(ml)} из {liters(water_goal(p))} л."
    buttons = [("🍽 Записать ужин", "cb:ask:d"), ("Что поесть?", "cbr:eat")] if "dinner" not in eaten else None
    return f"{today}:close", text, NO_CARD, (picks or []) + (buttons or []) or None


async def protein_offer(session, user: User, short: float, kcal_left: float, meal: str) -> tuple[str, Buttons]:
    """" — из твоего: творог 5% 200 г (+34 г)…" and a one-tap button for each; generic advice without a diary yet."""
    from backend.api.kitchen import protein_picks
    from backend.bot.chat import _b36

    picks = await protein_picks(session, user, kcal_left)
    if not picks:
        return " — творог, яйца или курица закроют.", None
    line = " — из того, что ты обычно ешь: " + ", ".join(f"{p['name'].lower()} {p['amount_g']} г (+{p['protein']} г)" for p in picks) + "."
    return line, [(f"+ {p['name']} {p['amount_g']} г · {p['protein']} г белка", f"cb:ea:{meal}:{_b36(p['product_id'])}x{p['amount_g']}")
                  for p in picks]


async def protein_check(session, user: User, now: datetime) -> tuple[str, str, Render, Buttons] | None:
    """Afternoon: they've eaten a good part of the day, but protein lags — offer it from their own diary while it's
    still easy to fit in (in the evening it's a big catch-up)."""
    today = now.date()
    p = await session.get(Profile, user.id)
    eaten, t = await eaten_today(session, user, local_start(today))
    goal = await today_targets(session, user, p)
    if not eaten or t["kcal"] < goal["calories"] * 0.35 or t["protein"] >= goal["protein"] * 0.4:
        return None
    short = goal["protein"] - t["protein"]
    line, picks = await protein_offer(session, user, short, goal["calories"] - t["kcal"], "s")
    return (f"{today}:protein", f"🥩 Белка пока {round(t['protein'])} из {goal['protein']} г, а день уже на середине. "
            f"Добрать {round(short)} г проще сейчас, чем вечером{line}", NO_CARD, picks)


async def day_three_tip(session, user: User) -> tuple[str, str, Render, Buttons]:
    """Day 3: one feature they haven't tried yet."""
    from backend.database.models import AiRequest, Friendship

    if not await session.scalar(select(AiRequest.id).where(AiRequest.user_id == user.id, AiRequest.kind == "meal_photo").limit(1)):
        text = "📸 Совет: еду можно не писать, а сфотографировать. Пришли сюда фото тарелки — я распознаю блюда и посчитаю калории."
    elif not await session.scalar(select(FoodLog.id).join(Product, Product.id == FoodLog.product_id)
                                  .where(FoodLog.user_id == user.id, Product.barcode.is_not(None)).limit(1)):
        text = "🏷 Совет: продукты из магазина быстрее всего записывать по штрихкоду — в приложении: Питание → сканер."
    elif not await session.scalar(select(Friendship.user_id).where(Friendship.user_id == user.id).limit(1)):
        text = "🤝 Совет: с другом держаться проще. Пригласи его — в приложении: Прогресс → Друзья, там же недельный рейтинг и дуэли."
    else:
        text = "💡 Совет: напиши /today — и я покажу, сколько съедено и сколько осталось на сегодня."
    return "onb:tip3", text, NO_CARD, None


async def nudges(session, now: datetime) -> list[tuple[User, str, str]]:
    """Started the bot but no questionnaire yet: a reminder after 3 hours and a last one the next day. Then silence."""
    rows = await session.scalars(select(User).outerjoin(Profile, Profile.user_id == User.id)
                                 .where(Profile.user_id.is_(None), User.created_at > now - timedelta(hours=48)))
    out = []
    for user in rows:
        clock.use_tz(user.device_tz)
        local, age = clock.local(now), now - user.created_at
        if timedelta(hours=3) <= age < timedelta(hours=20) and 9 <= local.hour < 21:
            out.append((user, "onb:n1", "Осталась пара вопросов — и твой план готов: норма КБЖУ, вода и программа тренировок. "
                                        "Это 2 минуты 🙂"))
        elif age >= timedelta(hours=20) and 12 <= local.hour < 20:
            out.append((user, "onb:n2", "Последнее напоминание, обещаю: анкета займёт 2 минуты, а дальше я сам буду считать "
                                        "калории по фото и тексту. Если неинтересно — просто не отвечай, больше не напишу."))
    clock.use_tz(None)
    return out


async def fasting_reminders(session, user: User, plan: FastingPlan, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """The window opens: how long the fast was; 30 minutes before it closes: protein still to eat."""
    today, out = now.date(), []
    if due(plan.eat_from, now):
        st = fasting.state(plan, await fasting.last_meal(session, user.id), now)
        out.append((f"{today}:fast_open", f"🍽 Окно питания открылось (до {fasting.eat_to(plan)}). "
                    + (f"Голод {st['fasted_h']:g} ч позади. " if st["fasted_h"] >= 10 else "") + "Начни с белка.",
                    NO_CARD, [("🍽 Что поесть?", "cb:eat")]))
    close = (datetime.strptime(fasting.eat_to(plan), "%H:%M") - timedelta(minutes=30)).strftime("%H:%M")
    if due(close, now):
        _, t = await eaten_today(session, user, local_start(today))
        p = await session.get(Profile, user.id)
        left = (await today_targets(session, user, p))["protein"] - t["protein"]
        out.append((f"{today}:fast_close", f"⏳ Через 30 минут, в {fasting.eat_to(plan)}, окно питания закрывается. "
                    + (f"Белка осталось ~{round(left / 5) * 5} г — успей добрать." if left >= 20 else "Норма белка на сегодня почти добрана 👍"),
                    NO_CARD, None))
    return out


async def candidates(session, user: User, cfg: ReminderSettings, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """(key, caption, card, buttons) of reminders that are due for this user right now and still make sense."""
    today = now.date()
    look = {"theme": user.theme if user.theme in cards.THEMES else None, "accent": user.accent}
    out = []
    fast = await session.get(FastingPlan, user.id)
    if fast and fast.remind:
        out += await fasting_reminders(session, user, fast, now)
    if cfg.meals and due(PROTEIN_CHECK, now) and (not fast or fasting.in_window(fast, now)):
        offer = await protein_check(session, user, now)
        if offer:
            out.append(offer)
    if cfg.meals:
        todo = [m for m in MEALS if due(getattr(cfg, f"{m}_at"), now)]
        if fast:  # no "запиши завтрак" at 10:00 when the window opens at 12:00
            todo = [m for m in todo if fasting.in_window(fast, now)]
        if todo:
            eaten, t = await eaten_today(session, user, local_start(today))
            p = await session.get(Profile, user.id)
            goal = (await today_targets(session, user, p))
            macros = {"Белки": (t["protein"], goal["protein"]), "Жиры": (t["fat"], goal["fat"]), "Углеводы": (t["carbs"], goal["carbs"])}
            yesterday, _ = await eaten_today(session, user, local_start(today - timedelta(days=1)), local_start(today))
            for m in todo:
                if m in eaten:
                    continue
                usual = await usual_for(session, user, m)  # "Как обычно" beats "Как вчера": it's what they really eat
                buttons = [(f"↻ Как обычно · {round(usual['kcal'])} ккал", f"cb:us:{m[0]}")] if usual else \
                    [("↻ Как вчера", f"cb:rep:{m[0]}")] if m in yesterday else None
                out.append((f"{today}:{m}", f"🍽 Не забудь записать {MEALS[m]} — напиши его сюда, например «омлет из 2 яиц, кофе».",
                            Render(cards.meal, MEALS[m].capitalize(), t["kcal"], goal["calories"], macros, **look), buttons))
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
    if due(cfg.weekly_at or "19:00", now):  # the norm from their own data, once a week (energy.recalc keeps the pace)
        # shortcut: users without enough data are re-measured each minute of the window; cache the miss if users grow to thousands
        from backend.api.energy import recalc, recalc_text

        p = await session.get(Profile, user.id)
        had = p.kcal_override
        changed = await recalc(session, user, p)
        if changed:
            out.append((f"{today}:norm", recalc_text(changed), NO_CARD, [(f"Вернуть {changed['old']} ккал", f"cb:ka:{had or 0}")]))
    if getattr(cfg, "weekly", True) and now.weekday() == 6 and due(cfg.weekly_at or "19:00", now):
        out.append(await weekly_summary(session, user, today, look))
    first_day = clock.local(user.created_at).date() == today
    if due(cfg.streak_at, now) and first_day:
        out.append(await day_one(session, user, today))
    elif cfg.streak and due(cfg.streak_at, now):
        n, days = await streak_state(session, user, today)
        if today in days and is_active(days[today]):
            close = await day_close(session, user, today)
            if close:
                out.append(close)
        elif n > 0:
            week = [today - timedelta(days=i) in days and is_active(days[today - timedelta(days=i)]) for i in range(6, -1, -1)]
            out.append((f"{today}:streak", f"🔥 Ты {n} дн. подряд с Setly. Одна запись — еда, вода или тренировка — и серия продолжится. Пропустить день тоже нормально.",
                        Render(cards.streak, n, week, **look), None))
    if getattr(cfg, "workout", True) and due(cfg.workout_at or "09:00", now):
        p = await session.get(Profile, user.id)
        if p and p.training_days and now.weekday() in p.training_days:
            trained = await session.scalar(select(WorkoutLog.id).where(
                WorkoutLog.user_id == user.id, WorkoutLog.started_at >= local_start(today)).limit(1))
            if not trained:
                out.append((f"{today}:workout", "🏋️ Сегодня день тренировки. Открывай приложение — план уже ждёт, веса подставим с прошлого раза.",
                            NO_CARD, None))
    if getattr(cfg, "checkin", False) and due(cfg.checkin_at or "09:00", now) and \
            not await session.get(DailyCheckin, (user.id, today)):
        out.append((f"{today}:checkin", "☀️ Доброе утро! Как спалось?", NO_CARD,
                    [("<6 ч", "cb:sl:1"), ("6–7", "cbr:sl:2"), ("7–8", "cbr:sl:3"), ("8+", "cbr:sl:4")]))
    if clock.local(user.created_at).date() == today - timedelta(days=2) and due("13:00", now):
        out.append(await day_three_tip(session, user))
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
        cfg = cfg or ReminderSettings(meals=True, water=True, streak=True, weekly=True, workout=True, breakfast_at="10:00",
                                      lunch_at="14:00", dinner_at="20:00", streak_at="21:00", weekly_at="19:00", workout_at="09:00")
        for key, text, card, buttons in await candidates(session, user, cfg, clock.local(now)):
            fresh = await session.scalar(
                insert(ReminderSent).values(user_id=user.id, key=key).on_conflict_do_nothing().returning(ReminderSent.key)
            )
            if fresh:
                messages.append((user.telegram_id, text, card, buttons))
    clock.use_tz(None)
    for user, key, text in await nudges(session, now):
        fresh = await session.scalar(
            insert(ReminderSent).values(user_id=user.id, key=key).on_conflict_do_nothing().returning(ReminderSent.key))
        if fresh:
            messages.append((user.telegram_id, text, NO_CARD, None))
    await session.commit()
    return messages


def markup(buttons: Buttons, keyboard, app_url: str):
    """Extra buttons (one per row; "cbr:" joins the previous row) above the usual "Открыть" keyboard."""
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

    rows = []
    for text, action in buttons or []:
        kind, _, value = action.partition(":")
        if kind == "cbr" and rows:
            rows[-1].append(InlineKeyboardButton(text=text, callback_data=value))
        elif kind in ("cb", "cbr"):
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


