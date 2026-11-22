import asyncio
import html
import logging
import unicodedata

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.exceptions import TelegramNetworkError
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    CallbackQuery,
    ErrorEvent,
    BufferedInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonDefault,
    MenuButtonWebApp,
    Message,
    BotCommand,
    WebAppInfo,
)

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from backend.api.account import delete_account
from backend.api.habits import tick_from_bot
from backend.api.social import USERNAME_FILE, befriend, name
from backend.bot import admin, cards, chat, groups, outbox, profile, reminders
from backend.core import alerts
from backend.database.db import SessionLocal
from backend.database.models import ReminderSent, User
from backend.core.config import Settings, settings

log = logging.getLogger("bot")
router = Router()
router.message.filter(F.chat.type == "private")  # group chats: backend.bot.groups

WELCOME = (
    "Привет, {name}! 👋\n\n"
    "Я Setly — дневник питания и тренер прямо в Telegram.\n\n"
    "Пишешь «гречка 150 г, курица» или присылаешь фото тарелки — я считаю калории. "
    "Даю программу тренировок и напоминаю про воду, без занудства.\n\n"
    "Начнём с анкеты: 2 минуты, и у тебя своя норма КБЖУ и план."
)
UNFINISHED = "Привет, {name}! 👋\n\nАнкета ещё ждёт — осталось пару минут, и твой план готов: норма КБЖУ, вода и программа тренировок."
COMMANDS = [("today", "Сегодня: калории, вода, тренировка"), ("eat", "Что поесть сейчас"), ("workout", "Тренировка на сегодня"),
            ("water", "+250 мл воды"), ("fast", "Интервальное голодание"), ("month", "Челлендж месяца"), ("weight", "Записать вес"), ("help", "Что я умею")]


def clean_name(first_name: str | None) -> str:
    """"Егор" for the greeting, HTML-escaped; "друг" when the name is empty or made only of invisible characters."""
    name = "".join(ch for ch in (first_name or "") if unicodedata.category(ch)[0] not in "CZ" or ch == " ").strip()
    return html.escape(name) if name else "друг"


async def first_time(user_id: int, key: str) -> bool:
    """True once per (user, key): a one-off message is recorded before it is sent."""
    async with SessionLocal() as s:
        fresh = await s.scalar(insert(ReminderSent).values(user_id=user_id, key=key).on_conflict_do_nothing().returning(ReminderSent.key))
        await s.commit()
        return fresh is not None


def current_webapp_url() -> str:
    # Re-read .env each time: the tunnel script rewrites WEBAPP_URL when the tunnel reconnects.
    return Settings().webapp_url


def open_app_keyboard(url: str, text: str = "Открыть приложение") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=text, web_app=WebAppInfo(url=url))]])


@router.message(CommandStart())
async def start(message: Message, command: CommandObject | None = None) -> None:
    await welcome(message, command)


@router.message(Command("welcome"))
async def welcome_preview(message: Message) -> None:
    """The greeting a new user gets, for anyone who already has an account (the team, curious users):
    it only shows messages, changes and reveals nothing."""
    await welcome(message, None, as_new=True)


async def welcome(message: Message, command: CommandObject | None, as_new: bool = False) -> None:
    """New user: what the bot does and the questionnaire. Questionnaire not finished: a nudge to finish it.
    Has a plan: their actual day (calories, water, streak, today's workout)."""
    url = current_webapp_url()
    friend = None
    if message.from_user and command and command.args and command.args.startswith("f"):  # invite link t.me/<bot>?start=f<code>
        async with SessionLocal() as s:
            friend = await befriend(s, command.args[1:64], message.from_user.id, message.from_user.first_name)
    hello_name = clean_name(message.from_user.first_name)
    group = None
    async with SessionLocal() as s:  # the account exists from the first /start: the onboarding messages need it
        existed = await s.scalar(select(User.id).where(User.telegram_id == message.from_user.id))
        user, prof = await chat.me(s, message.from_user)
        if command and command.args and command.args.startswith("g"):  # "Открыть Setly" in a group chat: t.me/<bot>?start=g<code>
            group = await join_by_code(s, command.args[1:13], user)
        day = await chat.day_greeting(s, user, prof, hello_name) if prof and not as_new else None
    theme, accent = user.theme, user.accent
    if day:
        caption, card, workout_due = day
        keyboard = chat.kb([chat.app_button("💪 Начать тренировку", "open=workout") if workout_due else None],
                           [chat.app_button("Открыть Setly")]) or open_app_keyboard(url, "Открыть Setly")
        render = lambda: cards.today(**card, theme=theme, accent=accent)  # noqa: E731
    else:
        unfinished = existed and not prof and not as_new and not friend
        caption = (UNFINISHED if unfinished else WELCOME).format(name=hello_name)
        keyboard = open_app_keyboard(url, "Продолжить анкету →" if unfinished else "Начать — 2 минуты")
        keyboard.inline_keyboard.append([InlineKeyboardButton(text="Что ты умеешь?", callback_data="tour")])
        render = lambda: cards.welcome(theme, accent)  # noqa: E731
    try:
        png = await asyncio.to_thread(render)
        await message.answer_photo(BufferedInputFile(png, "welcome.png"), caption=caption, reply_markup=keyboard, parse_mode="HTML")
    except Exception:
        log.warning("welcome card failed, sending text", exc_info=True)
        await message.answer(caption, reply_markup=keyboard, parse_mode="HTML")
    if day and await first_time(user.id, "onb:kb"):  # the quick-action keyboard, once for users from before it existed
        await message.answer(f"Быстрые действия теперь на кнопках внизу 👇 А еду можно просто написать сюда, например {chat.EXAMPLE}.",
                             reply_markup=chat.KEYBOARD)
    if group:
        await message.answer(f"✋ Ты в рейтинге чата «{html.escape(group.title)}». Очки — XP за тренировки, еду, воду и привычки; "
                             "итоги — по понедельникам прямо в чате.")
    if friend:
        await message.answer(f"🤝 Вы с {html.escape(name(friend))} теперь друзья! Рейтинг недели и дуэли — в приложении: Прогресс → Друзья.", parse_mode="HTML")


async def join_by_code(s, code: str, user: User):
    """The group behind the code with this user in its rating (and a hello in the chat); None for a stale code."""
    from backend.api import groups as group_api
    from backend.database.models import GroupChat

    g = await s.scalar(select(GroupChat).where(GroupChat.code == code, GroupChat.active.is_(True)))
    if g is None:
        return None
    if await group_api.join(s, g, user):
        group_api.post(s, g, f"✋ {name(user)} присоединяется к рейтингу чата!")
    await s.commit()
    return g


@router.message(Command("stats"))
async def stats(message: Message) -> None:
    uid = message.from_user and message.from_user.id
    admins = {int(x) for x in settings.admin_ids.replace(" ", "").split(",") if x.isdigit()}
    if uid not in admins:
        # not secret: the owner needs their id to put it into .env
        await message.answer(f"Статистика доступна только владельцу. Твой Telegram ID: <code>{uid}</code>.\n"
                             "Если это ты — допиши в .env строку ADMIN_IDS=этот_номер и перезапусти бота.", parse_mode="HTML")
        return
    async with SessionLocal() as s:
        await message.answer(await admin.summary(s), parse_mode="HTML")


_drafts: dict[int, str] = {}  # owner's chat id -> broadcast text waiting for "Отправить"


@router.message(Command("broadcast"))
async def broadcast(message: Message, command: CommandObject) -> None:
    uid = message.from_user and message.from_user.id
    if uid not in alerts.admin_ids():
        await message.answer("Эта команда только для владельца бота.")
        return
    text = (command.args or "").strip()
    if not text:
        await message.answer("Напиши текст после команды, например:\n/broadcast Новое в Setly: задания недели 🏆")
        return
    _drafts[uid] = text
    async with SessionLocal() as s:
        n = await admin.broadcast_size(s)
    await message.answer(text)  # exactly what people will see
    await message.answer(f"☝️ Так увидят сообщение. Отправить {n} пользователям?", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=f"Отправить ({n})", callback_data="bc:send"), InlineKeyboardButton(text="Отмена", callback_data="bc:cancel")]]))


@router.callback_query(F.data.startswith("bc:"))
async def broadcast_answer(call: CallbackQuery) -> None:
    uid = call.from_user.id
    text = _drafts.pop(uid, None) if uid in alerts.admin_ids() else None
    if call.data == "bc:send" and text:
        async with SessionLocal() as s:
            n = await admin.queue_broadcast(s, text)
        await call.message.edit_text(f"✅ Рассылка поставлена в очередь: {n} получателей. Уйдёт за пару минут.")
    else:
        await call.message.edit_text("Рассылка отменена." if text or call.data == "bc:cancel" else "Этот черновик уже неактуален.")
    await call.answer()


@router.message(Command("delete"))
async def delete_cmd(message: Message) -> None:
    await message.answer(
        "Удалить аккаунт Setly и все данные — анкету, дневник, тренировки, замеры, друзей и XP? "
        "Это нельзя отменить. Из резервных копий данные исчезнут в течение 14 дней.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="Удалить всё", callback_data="del:yes"), InlineKeyboardButton(text="Отмена", callback_data="del:no")]]))


@router.callback_query(F.data.startswith("del:"))
async def delete_answer(call: CallbackQuery) -> None:
    if call.data == "del:yes":
        async with SessionLocal() as s:
            gone = await delete_account(s, call.from_user.id)
        await call.message.edit_text("Готово: аккаунт и данные удалены. Если вернёшься — нажми /start, начнём с чистого листа."
                                     if gone else "Аккаунта уже нет — удалять нечего.")
    else:
        await call.message.edit_text("Удаление отменено, всё на месте.")
    await call.answer()


@router.callback_query(F.data.startswith("hb:"))
async def habit_tick(call: CallbackQuery) -> None:
    """✓ under a habit reminder: tick it without opening the app, and drop that button."""
    habit_id = int(call.data[3:]) if call.data[3:].isdigit() else 0
    async with SessionLocal() as s:
        h = await tick_from_bot(s, call.from_user.id, habit_id)
    if h is None:
        await call.answer("Этой привычки больше нет", show_alert=False)
        return
    await call.answer(f"Отмечено: {h.title} ✓")
    kb = call.message.reply_markup
    rows = [r for r in (kb.inline_keyboard if kb else []) if r[0].callback_data != call.data]
    try:
        await call.message.edit_reply_markup(reply_markup=InlineKeyboardMarkup(inline_keyboard=rows) if rows else None)
    except Exception:
        pass  # the message is too old to edit; the tick is saved anyway


@router.error()
async def on_error(event: ErrorEvent) -> bool:
    log.exception("Update handling failed", exc_info=event.exception)
    await alerts.report("бот", alerts.describe(event.exception))
    msg = event.update.message
    if msg:
        try:
            await msg.answer("Что-то пошло не так. Попробуй ещё раз чуть позже.")
        except Exception:
            pass
    return True


async def sync_menu_button(bot: Bot, shown: str | None) -> str | None:
    """Point the shared "Setly" menu button at the current address if it changed; returns the address shown."""
    url = current_webapp_url()
    if not url.startswith("https://") or url == shown:
        return shown
    await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="Setly", web_app=WebAppInfo(url=url)))
    log.info("Кнопка меню обновлена: %s", url)
    return url


async def reset_chat_menu_buttons(bot: Bot) -> None:
    """Older versions pinned a per-chat menu button to a fixed address; drop those so the shared one shows."""
    async with SessionLocal() as s:
        ids = list(await s.scalars(select(User.telegram_id)))
    for chat_id in ids:
        try:
            await bot.set_chat_menu_button(chat_id=chat_id, menu_button=MenuButtonDefault())
        except Exception:
            pass  # chat never started or bot blocked
        await asyncio.sleep(0.05)


async def keep_menu_button(bot: Bot) -> None:
    """The "Setly" button next to the message box always opens the current tunnel address.
    Message buttons keep the address they were sent with, so after a reconnect old ones show "no tunnel";
    this one follows every address change within ~10 s, no /start needed."""
    shown, reset = None, False
    while True:
        try:
            shown = await sync_menu_button(bot, shown)
            if shown and not reset:
                await reset_chat_menu_buttons(bot)
                reset = True
        except Exception:
            log.warning("Не удалось обновить кнопку меню, попробую снова", exc_info=True)
        await asyncio.sleep(10)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    if not settings.bot_token:
        raise SystemExit("BOT_TOKEN не задан в .env")
    if not settings.webapp_url.startswith("https://"):
        log.warning("WEBAPP_URL не HTTPS — Telegram не откроет Mini App")
    dp = Dispatcher()
    dp.include_router(groups.router)  # group chats only
    dp.include_router(router)
    dp.include_router(chat.owner)
    dp.include_router(chat.router)  # last: it takes any other text as food
    # Optional proxy for networks where api.telegram.org is blocked (http:// or socks5://).
    session = AiohttpSession(proxy=settings.bot_proxy) if settings.bot_proxy else None
    bot = Bot(settings.bot_token, session=session)

    def reminder_keyboard() -> InlineKeyboardMarkup | None:
        url = current_webapp_url()
        return open_app_keyboard(url) if url.startswith("https://") else None

    # runs alongside polling; the reference keeps the task from being garbage-collected
    reminder_task = asyncio.create_task(reminders.run(bot, reminder_keyboard, current_webapp_url))
    outbox_task = asyncio.create_task(outbox.run(bot, reminder_keyboard))
    menu_task = asyncio.create_task(keep_menu_button(bot))
    # start_polling fails right away if Telegram is unreachable at startup; keep retrying instead of exiting.
    profile_synced = False
    while True:
        try:
            if not profile_synced:  # first moment Telegram is reachable
                await profile.sync(bot)
                await bot.set_my_commands([BotCommand(command=c, description=d) for c, d in COMMANDS])
                USERNAME_FILE.write_text((await bot.get_me()).username or "", encoding="utf-8")  # for invite links
                profile_synced = True
            await dp.start_polling(bot)
            return
        except TelegramNetworkError as e:
            log.error("Нет связи с Telegram (%s). Проверь интернет/VPN или BOT_PROXY в .env. Повтор через 15 с…", e)
            await asyncio.sleep(15)


if __name__ == "__main__":
    asyncio.run(main())
