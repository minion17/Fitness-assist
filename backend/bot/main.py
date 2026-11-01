import asyncio
import html
import logging

from aiogram import Bot, Dispatcher, Router
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.exceptions import TelegramNetworkError
from aiogram.filters import CommandStart
from aiogram.types import (
    ErrorEvent,
    BufferedInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)

from sqlalchemy import select

from backend.bot import cards, profile, reminders
from backend.database.db import SessionLocal
from backend.database.models import User
from backend.core.config import Settings, settings

log = logging.getLogger("bot")
router = Router()

WELCOME = (
    "Привет, {name}! 👋\n\n"
    "Я <b>Fitness Assistant</b> — посчитаю твою норму КБЖУ, помогу вести дневник питания "
    "и тренировок и напомню про воду.\n\nНажми кнопку ниже — анкета займёт пару минут."
)


async def account(telegram_id: int) -> User | None:
    """The user's account if they opened the app before (for their theme)."""
    async with SessionLocal() as s:
        return await s.scalar(select(User).where(User.telegram_id == telegram_id))


def current_webapp_url() -> str:
    # Re-read .env each time: the tunnel script rewrites WEBAPP_URL when the tunnel reconnects.
    return Settings().webapp_url


def open_app_keyboard(url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Открыть Fitness Assistant", web_app=WebAppInfo(url=url))]]
    )


@router.message(CommandStart())
async def start(message: Message) -> None:
    url = current_webapp_url()
    name = message.from_user.first_name if message.from_user else "друг"
    caption = WELCOME.format(name=html.escape(name))
    try:
        user = await account(message.from_user.id) if message.from_user else None
        png = await asyncio.to_thread(cards.welcome, user and user.theme, user and user.accent)
        await message.answer_photo(BufferedInputFile(png, "welcome.png"), caption=caption,
                                   reply_markup=open_app_keyboard(url), parse_mode="HTML")
    except Exception:
        log.warning("welcome card failed, sending text", exc_info=True)
        await message.answer(caption, reply_markup=open_app_keyboard(url), parse_mode="HTML")
    if url.startswith("https://"):
        try:  # keep this chat's menu button on the current address too
            await message.bot.set_chat_menu_button(
                chat_id=message.chat.id, menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=url))
            )
        except Exception:
            log.warning("could not update menu button", exc_info=True)


@router.error()
async def on_error(event: ErrorEvent) -> bool:
    log.exception("Update handling failed", exc_info=event.exception)
    msg = event.update.message
    if msg:
        try:
            await msg.answer("Что-то пошло не так. Попробуйте ещё раз чуть позже.")
        except Exception:
            pass
    return True


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    if not settings.bot_token:
        raise SystemExit("BOT_TOKEN не задан в .env")
    if not settings.webapp_url.startswith("https://"):
        log.warning("WEBAPP_URL не HTTPS — Telegram не откроет Mini App")
    dp = Dispatcher()
    dp.include_router(router)
    # Optional proxy for networks where api.telegram.org is blocked (http:// or socks5://).
    session = AiohttpSession(proxy=settings.bot_proxy) if settings.bot_proxy else None
    bot = Bot(settings.bot_token, session=session)

    def reminder_keyboard() -> InlineKeyboardMarkup | None:
        url = current_webapp_url()
        return open_app_keyboard(url) if url.startswith("https://") else None

    # runs alongside polling; the reference keeps the task from being garbage-collected
    reminder_task = asyncio.create_task(reminders.run(bot, reminder_keyboard))
    # start_polling fails right away if Telegram is unreachable at startup; keep retrying instead of exiting.
    profile_synced = False
    while True:
        try:
            if not profile_synced:  # first moment Telegram is reachable
                await profile.sync(bot)
                profile_synced = True
            await dp.start_polling(bot)
            return
        except TelegramNetworkError as e:
            log.error("Нет связи с Telegram (%s). Проверьте интернет/VPN или BOT_PROXY в .env. Повтор через 15 с…", e)
            await asyncio.sleep(15)


if __name__ == "__main__":
    asyncio.run(main())
