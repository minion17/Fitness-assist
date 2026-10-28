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

from backend.core.config import settings

log = logging.getLogger("bot")
router = Router()

WELCOME = (
    "Привет, {name}! 👋\n\n"
    "Я <b>Fitness Assistant</b> — помогу вести дневник питания, тренировок "
    "и следить за прогрессом.\n\nНажми кнопку ниже, чтобы открыть приложение."
)


def open_app_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="Открыть Fitness Assistant", web_app=WebAppInfo(url=settings.webapp_url))]]
    )


@router.message(CommandStart())
async def start(message: Message) -> None:
    name = message.from_user.first_name if message.from_user else "друг"
    await message.answer(WELCOME.format(name=name), reply_markup=open_app_keyboard(), parse_mode="HTML")


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
    bot = Bot(settings.bot_token)
    if settings.webapp_url.startswith("https://"):
        # Telegram accepts only HTTPS for Mini Apps
        await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=settings.webapp_url)))
    else:
        log.warning("WEBAPP_URL не HTTPS — Telegram не откроет Mini App")
    dp = Dispatcher()
    dp.include_router(router)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
