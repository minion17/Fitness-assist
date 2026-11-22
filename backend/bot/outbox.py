"""Sends what the API queued in `outbox` (friend joined, duel news, share cards) and closes finished duels."""
import asyncio
import logging
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert

from backend.api.challenges import finish_challenges
from backend.api.leagues import finish_leagues
from backend.api.monthly import finish_months
from backend.api.social import finish_duels, name, pending_messages, reward_invites, week_numbers
from backend.bot import cards
from backend.core import alerts, clock
from backend.database.db import SessionLocal
from backend.database.models import User

log = logging.getLogger("outbox")


async def share_card(session, user: User) -> bytes:
    clock.use_tz(user.device_tz)
    w = await week_numbers(session, user)
    clock.use_tz(None)
    theme = user.theme if user.theme in cards.THEMES else None
    return await asyncio.to_thread(cards.share, name(user), w["streak"], w["week_xp"], w["workouts"], w["level"], theme, user.accent)


async def send_report(bot, session, m) -> None:
    from aiogram.types import BufferedInputFile

    from backend.api.report import gather
    from backend.bot.report import render

    user = await session.get(User, m.user_id)
    clock.use_tz(user.device_tz)
    try:
        data = await gather(session, user, int(m.text))
    finally:
        clock.use_tz(None)
    pdf = await asyncio.to_thread(render, data)
    await bot.send_document(m.telegram_id, BufferedInputFile(pdf, f"setly-report-{data['since']:%Y-%m-%d}-{data['until']:%Y-%m-%d}.pdf"),
                            caption=f"📄 Отчёт за {m.text} дней для врача, диетолога или тренера: масса тела и обхваты с ориентирами, "
                                    "нормы и реальный расход, питание по дням и дневник за последние 2 недели, тренировки, вода и сон. "
                                    "Перешли этот файл специалисту.")


async def send_export(bot, session, m) -> None:
    from aiogram.types import BufferedInputFile

    from backend.api.feedback import build_export

    user = await session.get(User, m.user_id)
    clock.use_tz(user.device_tz)
    try:
        data = await build_export(session, user)
    finally:
        clock.use_tz(None)
    await bot.send_document(m.telegram_id, BufferedInputFile(data, f"setly-{clock.today():%Y-%m-%d}.zip"),
                            caption="📦 Все твои записи: питание, вес и замеры, вода, тренировки — в таблицах CSV (открываются в Excel и Google Таблицах).")


async def send_plan(bot, session, m) -> None:
    """Right after the first questionnaire: the plan in numbers, and the chat's quick-action keyboard."""
    from backend.api.daily import water_goal
    from backend.api.main import recommended_program
    from backend.api.stats import targets
    from backend.bot import chat
    from backend.database.models import Profile, Program, ReminderSent

    user = await session.get(User, m.user_id)
    profile = await session.get(Profile, m.user_id)
    if profile is None:
        return
    goal = targets(profile)
    program_id = user.program_id or ((await recommended_program(session, profile)) or {}).get("program_id")
    program = program_id and await session.get(Program, program_id)
    days = ", ".join(chat.DAYS[d] for d in sorted(profile.training_days or []))
    lines = ["🎯 <b>Твой план готов</b>\n",
             f"Калории: <b>{chat.n(goal['calories'])} ккал</b> в день",
             f"Белки {chat.n(goal['protein'])} г · Жиры {chat.n(goal['fat'])} г · Углеводы {chat.n(goal['carbs'])} г",
             f"Вода: {chat.liters(water_goal(profile))} л"]
    if program or days:
        lines.append("Тренировки: " + " — ".join(x for x in (days, program and f"«{program.name}»") if x))
    lines.append(f"\nЕду можно писать мне прямо сюда, например {chat.EXAMPLE}, — посчитаю и запишу. "
                 "Или пришли фото тарелки. Быстрые действия — на кнопках внизу 👇")
    await bot.send_message(m.telegram_id, "\n".join(lines), parse_mode="HTML", reply_markup=chat.KEYBOARD)
    await session.execute(insert(ReminderSent).values(user_id=user.id, key="onb:kb").on_conflict_do_nothing())  # they have the keyboard: no "кнопки внизу" on the next /start
    await session.commit()


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
                    await bot.send_message(m.telegram_id, "☝️ Перешли карточку другу — по ссылке в подписи он сразу попадёт к тебе в друзья.")
                elif m.kind == "report" and m.user_id:
                    await send_report(bot, session, m)
                elif m.kind == "export" and m.user_id:
                    await send_export(bot, session, m)
                elif m.kind == "plan" and m.user_id:
                    await send_plan(bot, session, m)
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
                    await finish_leagues(session)
                    await finish_challenges(session)
                    await finish_months(session)
            await send_pending(bot, keyboard)
        except Exception as e:
            log.warning("outbox loop failed, retrying", exc_info=True)
            await alerts.report("бот: очередь сообщений", alerts.describe(e))
        tick += 1
        await asyncio.sleep(5)
