"""Sends what the API queued in `outbox` (friend joined, duel news, share cards) and closes finished duels."""
import asyncio
import logging
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.challenges import finish_challenges
from backend.api.leagues import finish_leagues
from backend.api.coach import weekly_summaries
from backend.api.groups import group_posts
from backend.api.monthly import finish_months
from backend.api.social import finish_duels, name, pending_messages, reward_invites, week_numbers
from backend.bot import cards
from backend.core import alerts, barcode_misses, clock
from backend.database.db import SessionLocal
from backend.database.models import User

log = logging.getLogger("outbox")


async def share_card(session, user: User) -> bytes:
    clock.use_tz(user.device_tz)
    w = await week_numbers(session, user)
    clock.use_tz(None)
    theme = user.theme if user.theme in cards.THEMES else None
    return await asyncio.to_thread(cards.share, name(user), w["streak"], w["week_xp"], w["workouts"], w["level"], theme, user.accent)


async def month_card(session, user: User) -> bytes:
    """The challenge-of-the-month card (the same picture as for Stories): for desktop, where Stories don't exist."""
    from backend.api.monthly import story_numbers
    from backend.api.social import bot_username

    m = await story_numbers(session, user)
    theme = user.theme if user.theme in cards.THEMES else None
    return await asyncio.to_thread(cards.story_month, name(user), m, bot_username(), theme, user.accent)


def shopping_markup(rows):
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

    return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows])


async def send_shopping(bot, session, m) -> None:
    from backend.api.shopping import render
    from backend.database.models import ShoppingList

    sl = await session.get(ShoppingList, int(m.text))
    if sl is None:
        return
    text, rows = render(sl, name(await session.get(User, sl.user_id)))
    sent = await bot.send_message(m.telegram_id, text, parse_mode="HTML", reply_markup=shopping_markup(rows))
    sl.message_id = sent.message_id
    await session.commit()


async def send_group(bot, session, m) -> None:
    from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

    from backend.api.groups import join_link
    from backend.database.models import GroupChat

    g = await session.scalar(select(GroupChat).where(GroupChat.chat_id == m.telegram_id))
    link = g and join_link(g)
    markup = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="Открыть Setly", url=link)]]) if link else None
    try:
        await bot.send_message(m.telegram_id, m.text, reply_markup=markup)
    except (TelegramForbiddenError, TelegramBadRequest) as e:  # removed from the chat, or the chat is gone
        log.info("group %s unreachable: %s", m.telegram_id, e)
        if g:
            g.active = False
            await session.commit()


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
                elif m.kind in ("month_card", "month_end") and m.user_id:
                    try:
                        png = await month_card(session, await session.get(User, m.user_id))
                    except Exception:  # no card (they left the challenge?): the final still arrives as text
                        log.warning("month card for %s failed", m.user_id, exc_info=True)
                        await bot.send_message(m.telegram_id, m.text, reply_markup=keyboard())
                        continue
                    await bot.send_photo(m.telegram_id, BufferedInputFile(png, "setly-month.png"), caption=m.text[:1024],
                                         reply_markup=keyboard() if m.kind == "month_end" else None)
                    if m.kind == "month_card":
                        await bot.send_message(m.telegram_id, "☝️ Перешли карточку другу или сохрани и выложи в истории.")
                elif m.kind == "coach":  # the coach's Monday summary: opens the clients screen
                    from backend.bot.chat import app_button, kb
                    await bot.send_message(m.telegram_id, m.text, reply_markup=kb([app_button("📋 Мои клиенты", "open=coach")]))
                elif m.kind == "shoptip":  # the family-plan tip: opens the saved plan
                    from backend.bot.chat import app_button, kb
                    button = app_button("🛒 Открыть рацион", "open=plan")
                    await bot.send_message(m.telegram_id, m.text, reply_markup=kb([button]) if button else None)
                elif m.kind == "shoplist":  # a shopping list with a button per item; its message id is kept to redraw it
                    await send_shopping(bot, session, m)
                elif m.kind == "group":  # a group chat: no Mini App buttons there, a link to the bot instead
                    await send_group(bot, session, m)
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
                    await group_posts(session)
                    await barcode_misses.weekly_report(session)
                    await weekly_summaries(session)
            await send_pending(bot, keyboard)
        except Exception as e:
            log.warning("outbox loop failed, retrying", exc_info=True)
            await alerts.report("бот: очередь сообщений", alerts.describe(e))
        tick += 1
        await asyncio.sleep(5)
