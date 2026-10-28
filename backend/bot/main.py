import asyncio
import logging

from aiogram import Bot, Dispatcher, Router
from aiogram.filters import CommandStart
from aiogram.types import (
    ErrorEvent,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)

from backend.core.config import Settings, settings

log = logging.getLogger("bot")
router = Router()

WELCOME = (
    "Привет, {name}! 👋\n\n"
    "Я <b>Fitness Assistant</b> — помогу вести дневник питания, тренировок "
    "и следить за прогрессом.\n\nНажми кнопку ниже, чтобы открыть приложение."
)


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
    await message.answer(WELCOME.format(name=name), reply_markup=open_app_keyboard(url), parse_mode="HTML")
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
    # No network calls before polling: start_polling retries on its own if the connection drops,
    # and the menu button is set per chat in /start.
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(Bot(settings.bot_token))


if __name__ == "__main__":
    asyncio.run(main())
