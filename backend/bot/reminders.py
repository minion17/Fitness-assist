"""Bot reminders: missed meals, water behind schedule, a streak about to break.

`collect` decides what to send (pure DB logic, tested); `run` is the bot's background loop that sends it.
shortcut: times are the server's local time, same as the diary; store each user's timezone when users span zones.
"""
import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from backend.api.daily import active_days, local_start, streak, water_goal
from backend.database.db import SessionLocal
from backend.database.models import FoodLog, Profile, ReminderSent, ReminderSettings, User, WaterIntake

log = logging.getLogger("reminders")

MEALS = {"breakfast": "завтрак", "lunch": "обед", "dinner": "ужин"}
# (time, share of the daily goal that should be drunk by then)
WATER_CHECKS = (("12:00", 0.35), ("16:00", 0.6), ("19:00", 0.85))
WINDOW = timedelta(minutes=45)  # a reminder missed by a restart is still sent within this window, not hours later


def liters(ml: float) -> str:
    return f"{ml / 1000:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def due(at: str, now: datetime) -> bool:
    h, m = map(int, at.split(":"))
    start = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return start <= now < start + WINDOW


async def candidates(session, user: User, cfg: ReminderSettings, now: datetime) -> list[tuple[str, str]]:
    """(key, text) of reminders that are due for this user right now and still make sense."""
    today = now.date()
    out = []
    if cfg.meals:
        todo = [m for m in MEALS if due(getattr(cfg, f"{m}_at"), now)]
        if todo:
            start = local_start(today)
            eaten = set(await session.scalars(
                select(FoodLog.meal_type).where(FoodLog.user_id == user.id, FoodLog.logged_at >= start)
            ))
            out += [(f"{today}:{m}", f"🍽 Не забудьте записать {MEALS[m]} — так норма КБЖУ будет честной.")
                    for m in todo if m not in eaten]
    if cfg.water:
        for at, share in WATER_CHECKS:
            if due(at, now):
                goal = water_goal(await session.get(Profile, user.id))
                ml = await session.scalar(
                    select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)
                ) or 0
                if ml < goal * share:
                    out.append((f"{today}:water{at}", f"💧 Выпито {liters(ml)} л из {liters(goal)} л. Стакан воды сейчас — самое время."))
    if cfg.streak and due(cfg.streak_at, now):
        days = await active_days(session, user, today - timedelta(days=365))
        n = streak(days, today)
        if n > 0 and today not in days:
            out.append((f"{today}:streak", f"🔥 Серия {n} дн. подряд сгорит сегодня — запишите хоть что-нибудь: еду, воду или тренировку."))
    return out


async def collect(session, now: datetime) -> list[tuple[int, str]]:
    """(telegram_id, text) to send now. Each reminder is recorded first, so it is sent at most once."""
    rows = await session.execute(
        select(User, ReminderSettings).join(Profile, Profile.user_id == User.id)  # registered users only
        .outerjoin(ReminderSettings, ReminderSettings.user_id == User.id)
    )
    messages = []
    for user, cfg in rows.all():
        cfg = cfg or ReminderSettings(meals=True, water=True, streak=True, breakfast_at="10:00",
                                      lunch_at="14:00", dinner_at="20:00", streak_at="21:00")
        for key, text in await candidates(session, user, cfg, now):
            fresh = await session.scalar(
                insert(ReminderSent).values(user_id=user.id, key=key).on_conflict_do_nothing().returning(ReminderSent.key)
            )
            if fresh:
                messages.append((user.telegram_id, text))
    await session.commit()
    return messages


async def run(bot, keyboard) -> None:
    """Check once a minute; never let one failure stop the loop."""
    from aiogram.exceptions import TelegramForbiddenError

    while True:
        try:
            async with SessionLocal() as session:
                batch = await collect(session, datetime.now().astimezone())
            for chat_id, text in batch:
                try:
                    await bot.send_message(chat_id, text, reply_markup=keyboard())
                except TelegramForbiddenError:
                    log.info("user %s blocked the bot", chat_id)  # nothing to do; they can /start again
                except Exception:
                    log.warning("reminder to %s failed", chat_id, exc_info=True)
                await asyncio.sleep(0.05)  # stay far below Telegram's 30 msg/s limit
        except Exception:
            log.exception("reminder loop failed")
        await asyncio.sleep(60)


