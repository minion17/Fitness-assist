import asyncio
import html
import random
import logging
import unicodedata

from aiogram import Bot, Dispatcher, Router
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.exceptions import TelegramNetworkError
from aiogram.filters import CommandStart
from aiogram.types import (
    ErrorEvent,
    BufferedInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonDefault,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)

from sqlalchemy import select

from backend.bot import cards, profile, reminders
from backend.database.db import SessionLocal
from backend.database.models import Profile, User
from backend.core.config import Settings, settings

log = logging.getLogger("bot")
router = Router()

WELCOME = (
    "{hello} 👋\n\n"
    "Я Setly. Помогаю не бросить питание и тренировки через неделю. Сфоткал тарелку — "
    "я посчитал калории. Забыл про воду — напомню. Пропускаешь — тоже напомню, но по-доброму 🙂\n\n"
    "Для начала пара вопросов о тебе, чтобы норма была твоя, а не «средняя по больнице». "
    "Это пара минут, честно."
)
# Returning users: (greeting word, emoji, text, picture from cards.BACK_KINDS); never the same one twice in a row.
BACK = [
    ("С возвращением", "👋", "Рад снова видеть. Дневник, тренировки и вода — всё на месте, жми «Открыть» и продолжаем.", "ring"),
    ("Привет", "🔥", "Серия сама себя не продлит. Запиши хотя бы один приём пищи — и день засчитан.", "streak"),
    ("О, привет", "💧", "Начнём с простого: стакан воды. Остальное подтянется.", "water"),
    ("Здорово", "💪", "Если сегодня тренировка — программа уже ждёт. Если нет — просто отметь, что ел.", "workout"),
    ("Привет", "🍽", "Сфоткай, что на тарелке, — калории посчитаю сам. Это быстрее, чем кажется.", "food"),
    ("С возвращением", "✌️", "Неважно, сколько было пропусков. Важно, что ты здесь. Открывай — продолжим с сегодняшнего дня.", "comeback"),
]
last_back: dict[int, int] = {}  # shortcut: in memory, forgotten on restart; only avoids an immediate repeat


def pick_back(telegram_id: int) -> int:
    i = random.choice([i for i in range(len(BACK)) if i != last_back.get(telegram_id)])
    last_back[telegram_id] = i
    return i


def greeting(first_name: str | None, back: bool, variant: int = 0) -> str:
    """"Привет, Егор!" — or just "Привет!" when the name is empty or made only of invisible characters."""
    name = "".join(ch for ch in (first_name or "") if unicodedata.category(ch)[0] not in "CZ" or ch == " ").strip()
    word, emoji, body = (BACK[variant][:3] if back else ("Привет", "👋", None))
    hello = word + (f", {html.escape(name)}!" if name else "!")
    return f"{hello} {emoji}\n\n{body}" if back else WELCOME.format(hello=hello)


async def account(telegram_id: int) -> tuple[User | None, bool]:
    """The user's account if they opened the app before (for their theme), and whether they filled the questionnaire."""
    async with SessionLocal() as s:
        user = await s.scalar(select(User).where(User.telegram_id == telegram_id))
        return user, bool(user and await s.get(Profile, user.id))


def current_webapp_url() -> str:
    # Re-read .env each time: the tunnel script rewrites WEBAPP_URL when the tunnel reconnects.
    return Settings().webapp_url


def open_app_keyboard(url: str, text: str = "Открыть приложение") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=text, web_app=WebAppInfo(url=url))]])


@router.message(CommandStart())
async def start(message: Message) -> None:
    url = current_webapp_url()
    user, back = await account(message.from_user.id) if message.from_user else (None, False)
    variant = pick_back(message.from_user.id) if back else 0
    caption = greeting(message.from_user and message.from_user.first_name, back, variant)
    keyboard = open_app_keyboard(url, "Открыть" if back else "Поехали →")
    theme, accent = user and user.theme, user and user.accent
    try:
        png = await asyncio.to_thread(cards.welcome_back, BACK[variant][3], theme, accent) if back \
            else await asyncio.to_thread(cards.welcome, theme, accent)
        await message.answer_photo(BufferedInputFile(png, "welcome.png"), caption=caption, reply_markup=keyboard, parse_mode="HTML")
    except Exception:
        log.warning("welcome card failed, sending text", exc_info=True)
        await message.answer(caption, reply_markup=keyboard, parse_mode="HTML")


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
    dp.include_router(router)
    # Optional proxy for networks where api.telegram.org is blocked (http:// or socks5://).
    session = AiohttpSession(proxy=settings.bot_proxy) if settings.bot_proxy else None
    bot = Bot(settings.bot_token, session=session)

    def reminder_keyboard() -> InlineKeyboardMarkup | None:
        url = current_webapp_url()
        return open_app_keyboard(url) if url.startswith("https://") else None

    # runs alongside polling; the reference keeps the task from being garbage-collected
    reminder_task = asyncio.create_task(reminders.run(bot, reminder_keyboard))
    menu_task = asyncio.create_task(keep_menu_button(bot))
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
