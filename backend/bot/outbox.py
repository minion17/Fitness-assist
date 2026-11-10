"""Sends what the API queued in `outbox` (friend joined, duel news, share cards) and closes finished duels."""
import asyncio
import logging
from datetime import timedelta

from sqlalchemy import func, select

from backend.api.daily import streak_state
from backend.api.social import finish_duels, name, pending_messages, reward_invites
from backend.bot import cards
from backend.core import alerts, clock
from backend.core.gamification import level_progress
from backend.database.db import SessionLocal
from backend.database.models import User, WorkoutLog, XpEvent

log = logging.getLogger("outbox")


async def share_card(session, user: User) -> bytes:
    clock.use_tz(user.device_tz)
    today = clock.today()
    monday = clock.local_start(today - timedelta(days=today.weekday()))
    week_xp = await session.scalar(select(func.coalesce(func.sum(XpEvent.xp), 0)).where(XpEvent.user_id == user.id, XpEvent.created_at >= monday))
    workouts = await session.scalar(select(func.count(WorkoutLog.id)).where(WorkoutLog.user_id == user.id, WorkoutLog.completed_at >= monday))
    streak, _ = await streak_state(session, user, today)
    clock.use_tz(None)
    theme = user.theme if user.theme in cards.THEMES else None
    return await asyncio.to_thread(cards.share, name(user), streak, int(week_xp), workouts or 0, level_progress(user.xp)["level"], theme, user.accent)


async def send_pending(bot, keyboard) -> None:
    from aiogram.exceptions import TelegramForbiddenError
    from aiogram.types import BufferedInputFile

    async with SessionLocal() as session:
        for m in await pending_messages(session):
            m.sent_at = func.now()  # marked even if sending fails: a broken message must not block the queue
            await session.commit()
            try:
                if m.kind == "share" and m.user_id:
                    png = await share_card(session, await session.get(User, m.user_id))
                    await bot.send_photo(m.telegram_id, BufferedInputFile(png, "setly.png"), caption=m.text)
                    await bot.send_message(m.telegram_id, "☝️ Перешлите карточку другу — по ссылке в подписи он сразу попадёт к вам в друзья.")
                elif m.kind == "alert":  # for the owner: plain text, no "open the app" button
                    await bot.send_message(m.telegram_id, m.text)
                else:
                    await bot.send_message(m.telegram_id, m.text, reply_markup=keyboard())
            except TelegramForbiddenError:
                log.info("user %s blocked the bot", m.telegram_id)
            except Exception:
                log.warning("outbox message %s failed", m.id, exc_info=True)
            await asyncio.sleep(0.05)


async def run(bot, keyboard) -> None:
    """Every few seconds: send queued messages; once a minute: close finished duels (their results are queued too)."""
    tick = 0
    while True:
        try:
            if tick % 12 == 0:
                async with SessionLocal() as session:
                    await finish_duels(session)
                    await reward_invites(session)
            await send_pending(bot, keyboard)
        except Exception as e:
            log.warning("outbox loop failed, retrying", exc_info=True)
            await alerts.report("бот: очередь сообщений", alerts.describe(e))
        tick += 1
        await asyncio.sleep(5)
