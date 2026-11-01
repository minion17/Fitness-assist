"""Bot's own profile: avatar, description (shown in an empty chat) and short description (the "about" line).

Applied by the bot on startup, but only when something here changed: Telegram keeps every uploaded photo,
so re-uploading on each start would pile them up. Edit the texts or assets/avatar.jpg and restart the bot.
"""
import hashlib
import logging
from pathlib import Path

from aiogram.types import FSInputFile, InputProfilePhotoStatic

log = logging.getLogger("bot.profile")

AVATAR = Path(__file__).parent / "assets" / "avatar.jpg"
STAMP = Path(__file__).resolve().parents[2] / ".bot_profile"  # in the project root, git-ignored

SHORT_DESCRIPTION = "Дневник питания, тренировки и вода в одном приложении. Сканер штрихкодов, AI по фото, напоминания."

DESCRIPTION = """Помогу питаться и тренироваться осознанно — без таблиц и подсчётов на бумажке.

🍽 Питание: норма КБЖУ под вашу цель, сканер штрихкодов, еда по фото и меню ресторанов с AI
💪 Тренировки: программа под ваш уровень и инвентарь
💧 Вода, вес и замеры тела
🔥 Серии дней, уровни и напоминания

Нажмите «Старт» — анкета займёт пару минут."""


def fingerprint() -> str:
    h = hashlib.sha256(AVATAR.read_bytes())
    h.update(DESCRIPTION.encode())
    h.update(SHORT_DESCRIPTION.encode())
    return h.hexdigest()


async def sync(bot) -> None:
    """Push the profile to Telegram if it changed since the last successful push. Never stops the bot."""
    fp = fingerprint()
    try:
        if STAMP.exists() and STAMP.read_text().strip() == fp:
            return
        await bot.set_my_description(description=DESCRIPTION)
        await bot.set_my_short_description(short_description=SHORT_DESCRIPTION)
        await bot.set_my_profile_photo(photo=InputProfilePhotoStatic(photo=FSInputFile(AVATAR)))
        STAMP.write_text(fp)
        log.info("Профиль бота обновлён: аватар и описание")
    except Exception:
        log.warning("Не удалось обновить профиль бота — попробую при следующем запуске", exc_info=True)
