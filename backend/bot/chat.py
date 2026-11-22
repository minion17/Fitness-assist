"""What a user can do right in the chat, without opening the app: log food by text or photo, water, weight,
"Сегодня", today's workout, the product tour. The diary, targets and XP are the same as in the Mini App."""
import asyncio
import base64
import html
import json
import logging
import re
import time
from datetime import timedelta
from pathlib import Path

from aiogram import Bot, F, Router
from aiogram.filters import Command, CommandObject
from aiogram.types import (
    BufferedInputFile, CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, InputMediaPhoto, KeyboardButton,
    Message, ReplyKeyboardMarkup, WebAppInfo,
)
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from backend.api.ai import DraftItem, recognise, save_draft
from backend.api.daily import GLASS_ML, WaterIn, add_water, local_start, water_goal
from backend.api.deps import get_or_create_user
from backend.api.stats import targets
from backend.bot import cards
from backend.core import alerts, clock
from backend.core.config import Settings
from backend.core.search import norm, stem
from backend.database.db import SessionLocal
from backend.database.models import (
    BodyMeasurement, FoodLog, Product, Profile, Program, ProgramDay, ProgramExercise, User, WaterIntake, WorkoutLog,
)
from backend.database.rewards import award_xp

router = Router()
router.message.filter(F.chat.type == "private")
owner = Router()  # the owner's own actions; included before `router`, which takes any photo or text as food
owner.message.filter(F.chat.type == "private")
log = logging.getLogger("bot.chat")

MEALS = {"breakfast": "завтрак", "lunch": "обед", "dinner": "ужин", "snack": "перекус"}
CODE = {"b": "breakfast", "l": "lunch", "d": "dinner", "s": "snack"}  # short forms: callback data is limited to 64 bytes
SHORT = {v: k for k, v in CODE.items()}
DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]

BTN_FOOD, BTN_WATER, BTN_TODAY, BTN_WORKOUT = "🍽 Еда", "💧 +250 мл", "📊 Сегодня", "💪 Тренировка"
KEYBOARD = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text=BTN_FOOD), KeyboardButton(text=BTN_WATER)],
              [KeyboardButton(text=BTN_TODAY), KeyboardButton(text=BTN_WORKOUT)]],
    resize_keyboard=True, is_persistent=True, input_field_placeholder="Например: гречка 150 г, курица 120 г",
)
EXAMPLE = "«овсянка 60 г, банан» или «гречка 150 г и котлета»"
HELP = (
    "Что можно делать прямо здесь:\n\n"
    f"🍽 <b>Записать еду</b> — напиши, что съел: {EXAMPLE}. Или пришли фото тарелки.\n"
    "💧 <b>Вода</b> — кнопка «+250 мл» или любое количество: «500 мл», «вода 0,5 л», «2 стакана воды».\n"
    "⚖️ <b>Вес</b> — «вес 76,4».\n"
    "✏️ <b>Поправить</b> — «убери хлеб», «риса было 200», «это был обед».\n"
    "🍽 /eat — что поесть сейчас под твой остаток.\n"
    "🧾 <b>Меню ресторана</b> — пришли фото с подписью «меню», подскажу, что взять.\n"
    "📊 /today — сколько съедено и сколько осталось.\n"
    "💪 /workout — тренировка на сегодня.\n"
    "⏱ /fast — интервальное голодание: сколько прошло и когда окно.\n\n"
    "Всё остальное — в приложении: кнопка «Setly» слева от поля ввода."
)


def app_url(query: str = "") -> str:
    url = Settings().webapp_url  # re-read: the tunnel script rewrites it when the tunnel reconnects
    return f"{url}{'&' if '?' in url else '?'}{query}" if query else url


def app_button(text: str, query: str = "") -> InlineKeyboardButton | None:
    url = app_url(query)
    return InlineKeyboardButton(text=text, web_app=WebAppInfo(url=url)) if url.startswith("https://") else None


def kb(*rows: list[InlineKeyboardButton | None]) -> InlineKeyboardMarkup | None:
    rows = [[b for b in r if b] for r in rows]
    rows = [r for r in rows if r]
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


def n(x: float) -> str:
    return f"{round(x):,}".replace(",", " ")


def dec(x: float) -> str:
    return f"{x:.1f}".rstrip("0").rstrip(".").replace(".", ",")


def liters(ml: float) -> str:
    return f"{ml / 1000:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def guess_meal(hour: int) -> str:
    if 5 <= hour < 11:
        return "breakfast"
    if 11 <= hour < 16:
        return "lunch"
    if 18 <= hour < 23:
        return "dinner"
    return "snack"


def pack(ids: list[int]) -> str:
    return ".".join(_b36(i) for i in ids)


def unpack(s: str) -> list[int]:
    return [int(x, 36) for x in s.split(".") if x]


def _b36(i: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        i, r = divmod(i, 36)
        out = digits[r] + out
        if not i:
            return out


# A meal the next text message goes to ("Записать ужин" in the evening): chat id -> (meal, until).
# shortcut: in memory, lost on restart; then the meal is guessed by the time, which is the usual case anyway
_asked: dict[int, tuple[str, float]] = {}


def asked_meal(chat_id: int) -> str | None:
    meal, until = _asked.pop(chat_id, (None, 0))
    return meal if until > time.time() else None


def tgd(tg_user) -> dict:
    """The shape the API's handlers get from initData."""
    return {"id": tg_user.id, "first_name": tg_user.first_name, "username": tg_user.username, "language_code": tg_user.language_code}


async def me(session, tg_user) -> tuple[User, Profile | None]:
    """The user's account (created on first contact) with their timezone applied to clock.today()."""
    user = await get_or_create_user(tgd(tg_user), session)
    return user, await session.get(Profile, user.id)


async def need_profile(message: Message) -> None:
    await message.answer("Сначала короткая анкета — 2 минуты. Без неё я не знаю твою норму калорий.",
                         reply_markup=kb([app_button("Заполнить анкету")]))


# ---- Food ----

SPLIT = re.compile(r"\s*(?:,(?=\s)|(?<!\d),|,(?!\d)|;|\n|\s+и\s+|\s+с\s+|\s+со\s+)\s*", re.I)  # not the comma in "0,5 л"
AMOUNT = re.compile(r"(\d+(?:[.,]\d+)?)\s*(кг|килограмм\w*|г|гр|грамм\w*|g|мл|ml|л|литр\w*)(?![а-яa-z])\.?", re.I)
COUNT = re.compile(r"(?:^|\s)(\d+(?:[.,]\d+)?)\s*(?:шт\w*\.?)?(?:\s|$)", re.I)


def split_food(text: str) -> list[tuple[str, float | None, str | None, float | None]]:
    """"гречка 150 г, 2 яйца" -> [(name, amount, unit, count)]: unit "g" or "ml", count = pieces."""
    out = []
    for part in SPLIT.split(text.strip()):
        amount = unit = count = None
        m = AMOUNT.search(part)
        if m:
            amount = float(m[1].replace(",", "."))
            u = m[2].lower()
            if u in ("мл", "ml"):
                unit = "ml"
            elif u.startswith("л"):
                unit, amount = "ml", amount * 1000
            elif u.startswith("к"):
                unit, amount = "g", amount * 1000
            else:
                unit = "g"
            part = part[:m.start()] + " " + part[m.end():]
        else:
            c = COUNT.search(part)
            if c:
                count = float(c[1].replace(",", "."))
                part = part[:c.start()] + " " + part[c.end():]
        name = re.sub(r"[^\w\s%-]", " ", part).strip()
        name = re.sub(r"\s+", " ", name)
        if len(name) >= 2:
            out.append((name, amount, unit, count))
    return out


async def find_local(session, tg: dict, text: str) -> tuple[list[DraftItem] | None, bool]:
    """The catalog alone (no AI, free and instant) when every part is a known product with an amount we can work out.
    `sure`: every pick is the product's exact name or one this user has eaten before; otherwise the AI picks better
    ("рис" is boiled rice, not the first rice in the catalog), and these picks are only the fallback."""
    from backend.api.main import search_products

    parts = split_food(text)
    if not parts or len(parts) > 12:
        return None, False
    user = await get_or_create_user(tg, session)
    eaten = set(await session.scalars(select(FoodLog.product_id).where(FoodLog.user_id == user.id).distinct()))
    items, sure = [], True
    for name, amount, unit, count in parts:
        found = await search_products(q=name[:100], quiet=True, tg=tg, session=session)  # their own products and history first
        mine = [p for p in found if p.get("id")]
        first = stem(norm(name).split()[0])[:4]
        p = next((p for p in mine if any(w.startswith(first) for w in norm(p["name"]).split())), None)
        if p is None:
            return None, False
        sure = sure and (p["id"] in eaten or norm(p["name"]) == norm(name))
        if amount is not None:
            grams = amount * (p["ml_g"] or 1) if unit == "ml" else amount
        elif p["piece_g"]:
            grams = p["piece_g"] * (count or 1)
        elif p["portion_g"]:
            grams = p["portion_g"] * (count or 1)
        else:
            return None, False  # "сыр" without grams: let the AI estimate a portion
        items.append(DraftItem(product_id=p["id"], name=p["name"][:200], grams=round(min(3000, max(1, grams)), 1),
                               kcal_100g=p["kcal"], protein_100g=p["protein_g"], fat_100g=p["fat_g"], carbs_100g=p["carbs_g"]))
    return items, sure


def draft_items(draft: dict) -> list[DraftItem]:
    return [DraftItem(**{k: it[k] for k in DraftItem.model_fields}) for it in draft["items"]]


async def day_kcal(session, user: User) -> float:
    rows = await session.execute(select(FoodLog.amount_g, Product.kcal).join(Product, Product.id == FoodLog.product_id)
                                 .where(FoodLog.user_id == user.id, FoodLog.logged_at >= local_start(clock.today())))
    return sum(a * k / 100 for a, k in rows.all())


MEAL_ICON = {"breakfast": "🍳", "lunch": "🥗", "dinner": "🍝", "snack": "🍎"}
Row = tuple[str, float, float, float, float, float]  # name, grams, kcal / protein / fat / carbs per 100 g


def day_bar(eaten: float, goal: float) -> str:
    """🟩🟩🟩⬜⬜⬜⬜⬜ — the day's calories at a glance; emoji squares look the same in every Telegram app
    (▰▱ turned into a thin dash on the desktop). Over the norm the last cell turns orange."""
    cells = 8
    filled = max(0, min(cells, round(cells * eaten / goal))) if goal else 0
    bar = "🟩" * filled + "⬜" * (cells - filled)
    return bar[:-1] + "🟧" if goal and eaten > goal * 1.1 else bar


def logged_text(meal: str, rows: list[Row], eaten: float, goal: dict | None, note: str = "") -> str:
    tot = [sum(r[i] * r[1] / 100 for r in rows) for i in (2, 3, 4, 5)]
    lines = [f"{MEAL_ICON[meal]} <b>{MEALS[meal].capitalize()}</b> · записал ✓\n"]
    lines += [f"{html.escape(name)} · {dec(g)} г — <b>{n(k * g / 100)} ккал</b>" for name, g, k, *_ in rows]
    lines.append(("\nВсего <b>" + n(tot[0]) + " ккал</b> · " if len(rows) > 1 else "\n") +
                 f"Б {n(tot[1])} · Ж {n(tot[2])} · У {n(tot[3])} г")
    if goal:
        norm, left = goal["calories"], goal["calories"] - eaten
        lines.append(f"\n{day_bar(eaten, norm)}  {n(eaten)} из {n(norm)} ккал")
        lines.append(f"<i>осталось {n(left)} ккал</i>" if left > 0 else f"<i>норма набрана{f', +{n(-left)} сверх' if left < -50 else ''}</i>")
    if note:
        lines.append(f"\nⓘ {html.escape(note)}")
    return "\n".join(lines)


def logged_keyboard(meal: str, ids: list[int]) -> InlineKeyboardMarkup | None:
    """The four meals as a 2×2 switch (the current one green with a check) and "Отменить" under them."""
    packed = pack(ids)
    if len(f"fm:x:{packed}") > 64:
        return kb([app_button("Открыть дневник", "open=food")])
    chips = [InlineKeyboardButton(text=f"✓ {MEALS[m].capitalize()}", callback_data="fm:same", style="success") if m == meal else
             InlineKeyboardButton(text=f"{MEAL_ICON[m]} {MEALS[m].capitalize()}", callback_data=f"fm:{SHORT[m]}:{packed}")
             for m in MEALS]
    return kb(chips[:2], chips[2:], [InlineKeyboardButton(text="↩ Отменить запись", callback_data=f"fu:{packed}")])


# The meal card a chat is filling: products sent one after another join it (one card, one total) instead of a card
# each. chat id -> (message id, meal, log ids, open until).
# shortcut: in memory, a restart starts a new card; that's all it costs
_cards: dict[int, tuple[int, str, list[int], float]] = {}
CARD_WINDOW = 20 * 60


def open_card(chat_id: int) -> tuple[int, str, list[int], float] | None:
    card = _cards.get(chat_id)
    return card if card and card[3] > time.time() else None


async def card_text(session, user: User, profile: Profile | None, meal: str, ids: list[int], note: str = "") -> tuple[str, list[int]]:
    """The card for these entries as they are in the diary now (moved or deleted elsewhere is taken into account)."""
    logs = list(await session.scalars(select(FoodLog).options(selectinload(FoodLog.product))
                                      .where(FoodLog.id.in_(ids or [0]), FoodLog.user_id == user.id).order_by(FoodLog.id)))
    rows = [(l.product.name, l.amount_g, l.product.kcal, l.product.protein_g, l.product.fat_g, l.product.carbs_g) for l in logs]
    return logged_text(meal, rows, await day_kcal(session, user), profile and targets(profile), note), [l.id for l in logs]


async def log_food(message: Message, text: str = "", image: dict | None = None) -> None:
    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        if profile is None:
            await need_profile(message)
            return
        card = open_card(message.chat.id)
        asked = asked_meal(message.chat.id)
        meal = asked or (card[1] if card else guess_meal(clock.now().hour))
        if card and card[1] != meal:
            card = None  # "Записать ужин" while a lunch card is open: a new card
        items, sure = (None, False) if image else await find_local(session, tgd(message.from_user), text)
        note = ""
        if not sure and (image or items is None or Settings().anthropic_api_key):
            wait = await message.answer("Считаю… 🔎")
            content = [image, {"type": "text", "text": "Что на фото и сколько примерно грамм?" + (f" Подпись: {text}" if text else "")}] \
                if image else [{"type": "text", "text": f"Пользователь пишет: {text}"}]
            try:
                draft = await recognise(session, user, "meal_photo" if image else "meal_text", content, text)
            except HTTPException as e:
                if not items:
                    await wait.edit_text(f"Не получилось распознать: {e.detail}\n\nНапиши с граммами, например {EXAMPLE} — "
                                         "такое я посчитаю и без AI.")
                    return
                draft = None  # AI unavailable or out of quota: the catalog's picks are still a good answer
            await wait.delete()
            if draft is not None:
                items, note = draft_items(draft), draft["note"]
            if not items:
                await message.answer((html.escape(note) + "\n\n" if note else "") +
                                     f"Не понял, что записать. Напиши, например, {EXAMPLE}.", parse_mode="HTML")
                return
        logs = await save_draft(session, user, meal, items)
        ids = [l.id for l in logs]
        if card:
            if meal == "snack":  # one snack group in the diary, not one per message
                first = await session.get(FoodLog, card[2][0]) if card[2] else None
                if first and first.user_id == user.id:
                    for l in logs:
                        l.snack_slot = first.snack_slot
                    await session.commit()
            ids = card[2] + ids
        await award_xp(session, user.id, "meal_logged", f"meal:{clock.today()}:{meal}")
        await show_card(message, session, user, profile, meal, ids, note, card)


async def show_card(message: Message, session, user: User, profile: Profile | None, meal: str, ids: list[int], note: str = "",
                    old: tuple | None = None) -> None:
    """The meal card at the bottom of the chat (the previous one of this meal removed), open for products sent next."""
    text, ids = await card_text(session, user, profile, meal, ids, note)
    if old:
        try:
            await message.bot.delete_message(message.chat.id, old[0])  # the card moves down to the newest message
        except Exception:
            pass
    if not ids:
        _cards.pop(message.chat.id, None)
        await message.answer("Карточка пуста — всё убрал из дневника.")
        return
    sent = await message.answer(text, parse_mode="HTML", reply_markup=logged_keyboard(meal, ids))
    _cards[message.chat.id] = (sent.message_id, meal, ids, time.time() + CARD_WINDOW)


@router.callback_query(F.data == "fm:same")
async def same_meal(call: CallbackQuery) -> None:
    await call.answer("Запись уже здесь")


@router.callback_query(F.data.startswith("fm:"))
async def move_food(call: CallbackQuery) -> None:
    _, code, packed = call.data.split(":", 2)
    meal = CODE.get(code)
    async with SessionLocal() as session:
        user, profile = await me(session, call.from_user)
        logs = list(await session.scalars(select(FoodLog).where(FoodLog.id.in_(unpack(packed)), FoodLog.user_id == user.id)))
        if not meal or not logs:
            await call.answer("Этих записей уже нет")
            return
        slot = clock.local(min(l.logged_at for l in logs)).strftime("%H:%M") if meal == "snack" else None
        for log in logs:
            log.meal_type, log.snack_slot = meal, slot
        await session.commit()
        await award_xp(session, user.id, "meal_logged", f"meal:{clock.today()}:{meal}")
        text, ids = await card_text(session, user, profile, meal, [l.id for l in logs])
    await call.message.edit_text(text, parse_mode="HTML", reply_markup=logged_keyboard(meal, ids))
    card = open_card(call.message.chat.id)
    if card and card[0] == call.message.message_id:  # the next product joins the meal it was moved to
        _cards[call.message.chat.id] = (card[0], meal, ids, card[3])
    await call.answer(f"Перенёс в {MEALS[meal]}")


@router.callback_query(F.data.startswith("fu:"))
async def undo_food(call: CallbackQuery) -> None:
    async with SessionLocal() as session:
        user, _ = await me(session, call.from_user)
        await session.execute(delete(FoodLog).where(FoodLog.id.in_(unpack(call.data[3:])), FoodLog.user_id == user.id))
        await session.commit()
    card = open_card(call.message.chat.id)
    if card and card[0] == call.message.message_id:
        _cards.pop(call.message.chat.id, None)
    await call.message.edit_text("↩ Отменено — из дневника убрал.")
    await call.answer()


@router.callback_query(F.data.startswith("ask:"))
async def ask_meal(call: CallbackQuery) -> None:
    meal = CODE.get(call.data[4:], "dinner")
    _asked[call.message.chat.id] = (meal, time.time() + 30 * 60)
    await call.message.answer(f"Напиши, что было на {MEALS[meal]}, — например «рыба 150 г, рис 100 г». Или пришли фото.")
    await call.answer()


@router.callback_query(F.data.startswith("rep:"))
async def repeat_meal(call: CallbackQuery) -> None:
    """"Как вчера" under a meal reminder: yesterday's same meal copied into today."""
    from backend.api.quick_food import CopyIn, copy_meal

    meal = CODE.get(call.data[4:])
    async with SessionLocal() as session:
        user, _ = await me(session, call.from_user)
        try:
            res = await copy_meal(CopyIn(from_day=clock.today() - timedelta(days=1), meal_type=meal),
                                  tg=tgd(call.from_user), session=session)
        except HTTPException as e:
            await call.answer(e.detail, show_alert=True)
            return
        eaten = await day_kcal(session, user)
    await call.message.answer(f"✅ {MEALS[meal].capitalize()} как вчера — записал {res['copied']} продукт(а). "
                              f"Сегодня {n(eaten)} ккал.", reply_markup=kb([app_button("Поправить в дневнике", "open=food")]))
    await call.answer("Записано")


@router.message(F.photo)
async def food_photo(message: Message, bot: Bot) -> None:
    photo = message.photo[-1]
    if (photo.file_size or 0) > 6 * 1024 * 1024:
        await message.answer("Фото слишком большое — пришли поменьше (до 6 МБ).")
        return
    data = (await bot.download(photo)).read()
    image = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(data).decode()}}
    if "меню" in (message.caption or "").lower():  # a restaurant menu: what fits today, not a plate to log
        await menu_photo(message, image)
    else:
        await log_food(message, (message.caption or "")[:300], image)


@router.message(F.voice | F.video_note)
async def voice(message: Message) -> None:
    await message.answer(f"Голосовые пока не понимаю. Напиши текстом, например {EXAMPLE}, или пришли фото.")


# ---- Water and weight ----

VOLUME = re.compile(r"([+−-]?)\s*(\d+(?:[.,]\d+)?)\s*(мл|ml|миллилитр\w*|л|l|литр\w*)?(?![а-яa-z])", re.I)
VESSEL = re.compile(r"(?:(\d+|пол)\s*)?(стакан|бутылк|кружк)\w*", re.I)
VESSEL_ML = {"стакан": 250, "бутылк": 500, "кружк": 300}


def water_amount(text: str) -> int | None:
    """Millilitres of water in a message, or None if it's about something else (then it's food).
    "+300", "500 мл", "вода 0,5 л", "выпил 2 стакана воды", "бутылка воды", "-250"."""
    t = norm(text).strip().rstrip(".!")
    t = re.sub(r"^(?:я\s+)?(?:вы|по)пил[аи]?\s+", "", t)
    water_word = r"\bвод(?:а|ы|у|е|ой|ичк[аиу]|ички)\b"  # not "водка"
    about_water = re.search(water_word, t) is not None
    rest = re.sub(water_word, "", t).strip()
    if about_water and not rest:
        return GLASS_ML  # just "вода": a glass
    if m := VESSEL.fullmatch(rest):
        if not about_water:
            return None  # "стакан кефира" is food
        count = 0.5 if m[1] == "пол" else float(m[1] or 1)
        return round(count * VESSEL_ML[m[2].lower()])
    m = VOLUME.fullmatch(rest)
    if not m or not (about_water or m[1] or m[3]):
        return None  # a bare "300" isn't water; "300 мл", "+300" or "вода 300" are
    amount = float(m[2].replace(",", "."))
    unit = (m[3] or "").lower()
    if unit.startswith(("л", "l")) or (not unit and amount <= 5):  # "вода 1,5" means litres
        amount *= 1000
    ml = round(amount) * (-1 if m[1] in "−-" and m[1] else 1)
    return ml if 10 <= abs(ml) <= 5000 else None
WEIGHT = re.compile(r"^(?:вес|weight)\s*:?\s*(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg)?$|^(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg)$", re.I)


def water_keyboard(ml: int) -> InlineKeyboardMarkup | None:
    """Other usual amounts in one tap, and undo of the last one."""
    more = [InlineKeyboardButton(text=f"+{v} мл", callback_data=f"w:{v}") for v in (150, 330, 500) if v != ml]
    undo = [InlineKeyboardButton(text=f"↩ Убрать {ml} мл", callback_data=f"w:-{ml}")] if ml > 0 else []
    return kb(more, undo)


async def add_ml(session, tg_user, ml: int) -> dict:
    """The API takes up to 1 l per call: "1,5 л" goes in parts."""
    res, left = None, ml
    while left:
        part = max(-1000, min(1000, left))
        res = await add_water(WaterIn(delta_ml=part), tg=tgd(tg_user), session=session)
        left -= part
    return res


def water_line(ml: int, res: dict) -> str:
    sign = f"+{ml}" if ml > 0 else f"−{-ml}"
    done = " Норма на сегодня выполнена 🎉" if ml > 0 and res["ml"] >= res["goal_ml"] and res["ml"] - ml < res["goal_ml"] else ""
    return f"💧 {sign} мл · {liters(res['ml'])} из {liters(res['goal_ml'])} л.{done}"


async def water(message: Message, ml: int) -> None:
    async with SessionLocal() as session:
        await me(session, message.from_user)
        res = await add_ml(session, message.from_user, ml)
    await message.answer(water_line(ml, res), reply_markup=water_keyboard(ml))


@router.callback_query(F.data.startswith("w:"))
async def water_button(call: CallbackQuery) -> None:
    delta = int(call.data[2:])
    async with SessionLocal() as session:
        await me(session, call.from_user)
        res = await add_ml(session, call.from_user, delta)
    if delta < 0:
        await call.message.edit_text(f"↩ Убрал {-delta} мл. 💧 {liters(res['ml'])} из {liters(res['goal_ml'])} л.")
    else:
        await call.message.answer(water_line(delta, res), reply_markup=water_keyboard(delta))
    await call.answer()


async def weight(message: Message, kg: float) -> None:
    if not 30 <= kg <= 300:
        await message.answer("Похоже на опечатку — вес должен быть от 30 до 300 кг.")
        return
    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        today = clock.today()
        prev = (await session.execute(
            select(BodyMeasurement.measured_on, BodyMeasurement.weight_kg).where(
                BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None), BodyMeasurement.measured_on < today)
            .order_by(BodyMeasurement.measured_on.desc()).limit(1))).first()
        m = await session.scalar(select(BodyMeasurement).where(BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on == today)) \
            or BodyMeasurement(user_id=user.id, measured_on=today)
        m.weight_kg = kg  # only the weight: waist and the rest of today's entry stay
        session.add(m)
        if profile:
            profile.weight_kg = kg  # the latest weight drives the daily targets (same as the app)
        await session.commit()
        await award_xp(session, user.id, "body_measurement", f"measure:{today}")
        goal = profile and profile.target_weight_kg
    text = f"⚖️ Записал: {dec(kg)} кг."
    if prev:
        d = round(kg - prev[1], 1)
        text += f" {'+' if d > 0 else '−' if d < 0 else '±'}{dec(abs(d))} кг с {prev[0]:%d.%m}."
    if goal and abs(kg - goal) >= 0.1:
        text += f" До цели {dec(abs(kg - goal))} кг."
    await message.answer(text)


@router.message(Command("water"))
async def water_cmd(message: Message, command: CommandObject) -> None:
    arg = (command.args or "").strip()
    ml = water_amount(f"вода {arg}") if arg else GLASS_ML
    await water(message, ml) if ml else await message.answer("Напиши количество, например /water 500 или «вода 0,5 л».")


@router.message(Command("weight"))
async def weight_cmd(message: Message, command: CommandObject) -> None:
    arg = (command.args or "").replace(",", ".").replace("кг", "").strip()
    try:
        await weight(message, float(arg))
    except ValueError:
        await message.answer("Напиши вес сообщением, например: вес 76,4")


# ---- Today and workout ----

async def today_text(session, user: User, profile: Profile) -> tuple[str, bool]:
    from backend.bot.reminders import eaten_today

    today = clock.today()
    eaten, t = await eaten_today(session, user, local_start(today))
    goal = targets(profile)
    ml = await session.scalar(select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)) or 0
    left = goal["calories"] - t["kcal"]
    lines = [f"📊 <b>Сегодня, {today:%d.%m}</b>\n",
             f"🍽 {n(t['kcal'])} из {n(goal['calories'])} ккал" + (f" — осталось {n(left)}" if left > 0 else " — норма набрана"),
             f"Б {n(t['protein'])}/{n(goal['protein'])} · Ж {n(t['fat'])}/{n(goal['fat'])} · У {n(t['carbs'])}/{n(goal['carbs'])} г",
             f"💧 {liters(ml)} из {liters(water_goal(profile))} л"]
    missing = [MEALS[m] for m in ("breakfast", "lunch", "dinner") if m not in eaten
               and clock.now().hour >= {"breakfast": 11, "lunch": 16, "dinner": 21}[m]]
    if missing:
        lines.append(f"Не записан: {', '.join(missing)}")
    trained = await session.scalar(select(WorkoutLog.id).where(WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None),
                                                               WorkoutLog.started_at >= local_start(today)).limit(1))
    if trained:
        lines.append("💪 Тренировка сделана ✓")
    elif profile.training_days and today.weekday() in profile.training_days:
        lines.append("💪 Сегодня день тренировки — /workout")
    return "\n".join(lines), bool(trained)


async def today_cmd(message: Message) -> None:
    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        if profile is None:
            await need_profile(message)
            return
        text, _ = await today_text(session, user, profile)
    await message.answer(text, parse_mode="HTML", reply_markup=kb(
        [InlineKeyboardButton(text="🍽 Что поесть?", callback_data="eat"), InlineKeyboardButton(text="💧 +250 мл", callback_data="w:250")],
        [app_button("Открыть дневник", "open=food")]))


async def next_workout(session, user: User, profile: Profile) -> ProgramDay | None:
    """The day the app shows as next: the one after the last completed day of the chosen (or recommended) program."""
    from backend.api.main import recommended_program

    program_id = user.program_id or ((await recommended_program(session, profile)) or {}).get("program_id")
    if not program_id:
        return None
    program = await session.scalar(select(Program).where(Program.id == program_id).options(
        selectinload(Program.days).selectinload(ProgramDay.items).selectinload(ProgramExercise.exercise)))
    if not program or not program.days:
        return None
    ids = [d.id for d in program.days]
    last = await session.scalar(select(WorkoutLog.program_day_id).where(
        WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None), WorkoutLog.program_day_id.in_(ids))
        .order_by(WorkoutLog.completed_at.desc()).limit(1))
    return program.days[(ids.index(last) + 1) % len(ids)] if last in ids else program.days[0]


def day_minutes(day: ProgramDay) -> int:
    """About how long the workout takes: 45 s a set plus the rest, rounded to 5 minutes."""
    return max(10, round(sum(i.sets * (45 + i.rest_seconds) for i in day.items) / 60 / 5) * 5)


MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")


async def day_greeting(session, user: User, profile: Profile, hello_name: str) -> tuple[str, dict, bool]:
    """/start of someone who has a plan: their actual day instead of a stock phrase.
    Returns the caption, the card's arguments (cards.today) and whether today's workout is due."""
    from backend.api.daily import is_active, streak_state
    from backend.bot.reminders import eaten_today

    today, hour = clock.today(), clock.now().hour
    word, emoji = (("Доброе утро", "☀️") if 5 <= hour < 12 else ("Добрый день", "👋") if hour < 17 else
                   ("Добрый вечер", "🌙") if hour < 23 else ("Привет", "🌙"))
    eaten, t = await eaten_today(session, user, local_start(today))
    goal = targets(profile)
    norm, left = goal["calories"], goal["calories"] - t["kcal"]
    ml = await session.scalar(select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)) or 0
    wgoal = water_goal(profile)
    streak, days = await streak_state(session, user, today)
    active_today = today in days and is_active(days[today])
    recent = [d for d, v in days.items() if today - timedelta(days=7) <= d < today and is_active(v)]
    away = not recent and clock.local(user.created_at).date() < today - timedelta(days=7)
    trained = await session.scalar(select(WorkoutLog.id).where(WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None),
                                                               WorkoutLog.started_at >= local_start(today)).limit(1))
    day = None
    if not trained and profile.training_days and today.weekday() in profile.training_days:
        day = await next_workout(session, user, profile)

    lines = [f"{word}, {hello_name}! {emoji}", ""]
    if away:
        lines.append("Давно не виделись! Ничего страшного — начнём с сегодняшнего дня. Твой план на месте, "
                     "просто напиши, что ел, — я посчитаю.")
        title = ("С возвращением", "начнём с сегодня")
    elif not eaten:
        lines.append("Сегодня пока пусто — напиши сюда завтрак, например «омлет из 2 яиц, кофе»." if hour < 12 else
                     f"Сегодня пока пусто — напиши, что ел, например {EXAMPLE}, и я посчитаю.")
        title = ("Сегодня", "пока пусто")
    else:
        lines.append(f"Сегодня {n(t['kcal'])} из {n(norm)} ккал, воды {liters(ml)} из {liters(wgoal)} л. " +
                     (f"Осталось {n(left)} ккал — пиши, что съел, запишу." if left > 0 else "Норма на сегодня набрана 👌"))
        title = ("Осталось", f"{n(left)} ккал") if left > 0 else ("Норма", "набрана")
    if not away and streak >= 2 and not active_today:
        lines.append(f"\n🔥 Серия {streak} дн. — запиши сегодня хоть что-то, и она продолжится.")
    elif streak >= 3 and active_today:
        lines.append(f"\n🔥 Серия {streak} дн. — так держать!")
    if day:
        lines.append(f"\n💪 По плану тренировка: {html.escape(day.day_name)} — ~{day_minutes(day)} мин.")
    chips = [f"Вода {liters(ml)} из {liters(wgoal)} л"]
    if streak:
        chips.append(f"Серия {streak} дн.")
    if trained or day:
        chips.append("Тренировка ✓" if trained else "Тренировка сегодня")
    card = {"title": title[0], "accent_line": title[1], "eaten": t["kcal"], "goal": norm, "chips": chips,
            "date": f"{today.day} {MONTHS[today.month - 1]}"}
    return "\n".join(lines), card, day is not None


async def workout_cmd(message: Message) -> None:
    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        if profile is None:
            await need_profile(message)
            return
        day = await next_workout(session, user, profile)
        today = clock.today()
        trained = await session.scalar(select(WorkoutLog.id).where(WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None),
                                                                   WorkoutLog.started_at >= local_start(today)).limit(1))
        if day is None:
            await message.answer("Программа ещё не выбрана — выбери её в приложении.",
                                 reply_markup=kb([app_button("Выбрать программу", "open=workout")]))
            return
        rest = profile.training_days and today.weekday() not in profile.training_days
        head = ("💪 Сегодня тренировка уже сделана ✓ Следующая:" if trained else
                "😌 Сегодня по плану отдых. Если хочется — следующая тренировка:" if rest else "💪 Тренировка на сегодня:")
        sets = sum(i.sets for i in day.items)
        minutes = day_minutes(day)
        lines = [head, f"\n<b>{html.escape(day.day_name)}</b> — {len(day.items)} упр., ~{minutes} мин\n"]
        lines += [f"• {html.escape(i.exercise.name)} — {i.sets} × {html.escape(i.reps)}" for i in day.items[:8]]
        if len(day.items) > 8:
            lines.append(f"• и ещё {len(day.items) - 8}")
        lines.append(f"\nВсего {sets} подходов. Таймер отдыха и веса с прошлого раза — в приложении.")
    await message.answer("\n".join(lines), parse_mode="HTML",
                         reply_markup=kb([app_button("Начать тренировку" if not trained else "Открыть тренировки", "open=workout")]))


# ---- Tour ----

TOUR_CAPTIONS = ("Листай стрелками →", "", "", "Ответь на пару вопросов — и я соберу твой план: норму КБЖУ, воду и "
                 "программу тренировок. Это 2 минуты.")


def tour_keyboard(i: int) -> InlineKeyboardMarkup:
    last = len(cards.TOUR) - 1
    arrows = [InlineKeyboardButton(text="←", callback_data=f"tour:{(i - 1) % (last + 1)}"),
              InlineKeyboardButton(text="→", callback_data=f"tour:{(i + 1) % (last + 1)}")]
    return kb(arrows, [app_button("Заполнить анкету →")])


async def tour_card(tg_id: int, i: int) -> BufferedInputFile:
    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.telegram_id == tg_id))
    theme = user.theme if user and user.theme in cards.THEMES else None
    png = await asyncio.to_thread(cards.tour, i, theme, user and user.accent)
    return BufferedInputFile(png, f"setly-{i + 1}.png")


TOUR_POST = Path(__file__).resolve().parents[2] / ".tour_post"  # project root, git-ignored: {"chat_id", "ids"}
TOUR_INVITE = "Ответь на пару вопросов — и я соберу твой план: норму КБЖУ, воду и программу тренировок. Это 2 минуты."


def tour_post() -> dict | None:
    try:
        post = json.loads(TOUR_POST.read_text(encoding="utf-8"))
        return post if post.get("chat_id") and post.get("ids") else None
    except (OSError, ValueError):
        return None


@router.callback_query(F.data == "tour")
async def tour(call: CallbackQuery, bot: Bot) -> None:
    """The owner's carousel post from the Setly channel, copied (no "forwarded from"); bots can't send a carousel
    themselves. Without that post, or if copying fails: one slide flipped with arrows."""
    await call.answer()
    post = tour_post()
    if post:
        try:
            await bot.copy_messages(call.from_user.id, post["chat_id"], post["ids"])
            await call.message.answer(TOUR_INVITE, reply_markup=kb([app_button("Заполнить анкету →")]))
            return
        except Exception:
            log.warning("tour post copy failed, sending slides", exc_info=True)
    await call.message.answer_photo(await tour_card(call.from_user.id, 0), caption=TOUR_CAPTIONS[0], reply_markup=tour_keyboard(0))


_tour_parts: dict[str, list[int]] = {}  # media_group_id -> channel message ids, while an album arrives in parts


@owner.message(F.forward_origin.type == "channel", F.func(lambda m: m.from_user and m.from_user.id in alerts.admin_ids()))
async def save_tour_post(message: Message, bot: Bot) -> None:
    """The owner forwards the carousel post from the channel to the bot: it becomes the tour."""
    origin = message.forward_origin
    log.info("owner forwarded channel post %s/%s (group %s)", origin.chat.id, origin.message_id, message.media_group_id)
    group = message.media_group_id or str(origin.message_id)
    first = group not in _tour_parts
    _tour_parts.setdefault(group, []).append(origin.message_id)
    if not first:
        return
    await asyncio.sleep(2)  # the rest of the album arrives as separate messages
    ids = sorted(set(_tour_parts.pop(group)))
    TOUR_POST.write_text(json.dumps({"chat_id": origin.chat.id, "ids": ids}), encoding="utf-8")
    await message.answer(f"Сохранил пост из канала ({len(ids)} фото) как карусель для новичков. Вот как его увидят:")
    try:
        await bot.copy_messages(message.chat.id, origin.chat.id, ids)
    except Exception as e:
        await message.answer(f"Не получилось скопировать: {e}. Проверь, что бот — админ канала.")


@router.callback_query(F.data.startswith("tour:"))
async def tour_flip(call: CallbackQuery) -> None:
    i = int(call.data[5:]) % len(cards.TOUR) if call.data[5:].isdigit() else 0
    await call.answer()
    try:
        await call.message.edit_media(InputMediaPhoto(media=await tour_card(call.from_user.id, i), caption=TOUR_CAPTIONS[i] or None),
                                      reply_markup=tour_keyboard(i))
    except Exception:
        pass  # a double tap: "message is not modified"


# ---- "Что поесть?", "Как обычно", corrections in words, menu advice ----

def ideas_text(sug: dict) -> str:
    meal = sug["meal_type"]
    head = f"🍽 <b>Что поесть на {MEALS[meal]}</b>\n\nОсталось {n(sug['kcal_left'])} ккал" + \
        (f" и {n(sug['protein_left'])} г белка" if sug["protein_left"] > 10 else "") + "."
    lines = [head, ""]
    lines += [f"{i + 1}. {html.escape(o['title'])} — {n(o['kcal'])} ккал, Б {n(o['protein_g'])}" for i, o in enumerate(sug["options"])]
    lines.append("\nНажми номер — запишу.")
    return "\n".join(lines)


def ideas_keyboard(sug: dict) -> InlineKeyboardMarkup | None:
    row = []
    for i, o in enumerate(sug["options"]):
        data = f"ea:{SHORT[sug['meal_type']]}:" + ".".join(f"{_b36(it['product_id'])}x{round(it['amount_g'])}" for it in o["items"])
        if len(data.encode()) <= 64:
            row.append(InlineKeyboardButton(text=f"✓ {i + 1}", callback_data=data))
    return kb(row, [app_button("Открыть дневник", "open=food")])


async def eat_cmd(message: Message, tg_user) -> None:
    from backend.api.kitchen import meal_suggestions

    async with SessionLocal() as session:
        user, profile = await me(session, tg_user)
        if profile is None:
            await need_profile(message)
            return
        sug = await meal_suggestions(session, user, guess_meal(clock.now().hour))
    if sug["kcal_left"] < 150:
        await message.answer("На сегодня норма набрана 👌 Если голодно — лучше овощи, кефир или чай.")
    elif not sug["options"]:
        await message.answer(f"Пока не из чего выбрать — запиши пару дней еды, и я буду подсказывать. Осталось {n(sug['kcal_left'])} ккал.")
    else:
        await message.answer(ideas_text(sug), parse_mode="HTML", reply_markup=ideas_keyboard(sug))


async def log_items(message: Message, tg_user, meal: str, items: list[dict]) -> None:
    """Products with their grams into a meal, then the usual card (open for more products)."""
    from backend.api.kitchen import BatchIn, log_batch

    async with SessionLocal() as session:
        user, profile = await me(session, tg_user)
        try:
            res = await log_batch(BatchIn(meal_type=meal, items=items), tg=tgd(tg_user), session=session)
        except HTTPException as e:
            await message.answer(f"Не записалось: {e.detail}")
            return
        card = open_card(message.chat.id)
        card = card if card and card[1] == meal else None
        await show_card(message, session, user, profile, meal, (card[2] if card else []) + res["ids"], "", card)


@router.callback_query(F.data == "eat")
async def eat_button(call: CallbackQuery) -> None:
    await call.answer()
    await eat_cmd(call.message, call.from_user)


@router.callback_query(F.data.startswith("ea:"))
async def eat_pick(call: CallbackQuery) -> None:
    _, code, packed = call.data.split(":", 2)
    items = []
    for part in packed.split("."):
        pid, _, grams = part.partition("x")
        if pid and grams.isdigit():
            items.append({"product_id": int(pid, 36), "amount_g": int(grams)})
    await call.answer("Записываю")
    try:
        await call.message.edit_reply_markup(reply_markup=None)  # one pick per list
    except Exception:
        pass
    if items:
        await log_items(call.message, call.from_user, CODE.get(code, "snack"), items)


@router.callback_query(F.data.startswith("us:"))
async def usual_pick(call: CallbackQuery) -> None:
    """"↻ Как обычно" under a meal reminder."""
    from backend.api.kitchen import usual_for

    meal = CODE.get(call.data[3:], "breakfast")
    async with SessionLocal() as session:
        user, _ = await me(session, call.from_user)
        usual = await usual_for(session, user, meal)
    await call.answer()
    if not usual:
        await call.message.answer(f"Сегодня {MEALS[meal]} уже записан — или привычного набора пока нет.")
        return
    await log_items(call.message, call.from_user, meal, [{"product_id": i["product_id"], "amount_g": i["amount_g"]} for i in usual["items"]])


REMOVE = re.compile(r"^(?:убери|удали|убрать|удалить|без|минус)\s+(.+)$", re.I)
AMEND = re.compile(r"^(?:(?:исправь|поправь|не)\s+)?(.+?)\s+(?:было|был|была|были|на|а)\s+(\d+(?:[.,]\d+)?)\s*(?:г|гр|грамм\w*|мл)?\.?$", re.I)
WAS_MEAL = re.compile(r"^(?:это\s+)?(?:был[аио]?\s+)?(?:на\s+)?(завтрак|обед|ужин|перекус)\w*$", re.I)
MEAL_WORD = {"завтрак": "breakfast", "обед": "lunch", "ужин": "dinner", "перекус": "snack"}


def which(logs: list[FoodLog], words: str) -> FoodLog | None:
    """The card's entry the user means by "хлеб" / "риса": the first word's stem against the product names."""
    w = norm(words).split()
    if not w:
        return None
    root = stem(w[0])[:4]
    return next((l for l in logs if any(x.startswith(root) for x in norm(l.product.name).split())), None)


async def correct(message: Message, text: str) -> bool:
    """"убери хлеб", "риса было 200", "это был обед": a fix to the open card. False when the text isn't one."""
    card = open_card(message.chat.id)
    if not card:
        return False
    mm, rm, am = WAS_MEAL.match(text), REMOVE.match(text), AMEND.match(text)
    if not (mm or rm or am):
        return False
    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        logs = list(await session.scalars(select(FoodLog).options(selectinload(FoodLog.product))
                                          .where(FoodLog.id.in_(card[2]), FoodLog.user_id == user.id).order_by(FoodLog.id)))
        meal = card[1]
        if mm:
            meal = MEAL_WORD[mm[1].lower()]
            slot = clock.local(min(l.logged_at for l in logs)).strftime("%H:%M") if meal == "snack" and logs else None
            for l in logs:
                l.meal_type, l.snack_slot = meal, slot
        else:
            target = which(logs, (rm or am)[1])
            if target is None:
                return False  # "без сахара" may be a new product after all: let it be food
            if rm:
                await session.delete(target)
                logs.remove(target)
            else:
                target.amount_g = max(1.0, min(3000.0, float(am[2].replace(",", "."))))
        await session.commit()
        await show_card(message, session, user, profile, meal, [l.id for l in logs], "", card)
    return True


def menu_advice(dishes: list[dict], kcal_left: float, protein_left: float, aim: float) -> str:
    """Which dishes of a menu fit what's left today: the best 3, and what would eat most of the day."""
    portions = []
    for d in dishes:
        g = d.get("portion_g") or 0
        if g:
            k = d["kcal"] * g / 100
            portions.append({**d, "pk": k, "pp": d["protein_g"] * g / 100})
    if not portions:
        return "В меню не нашёл блюд с весом порции — не могу посчитать. Попробуй сфотографировать страницу крупнее."
    fit = sorted((p for p in portions if p["pk"] <= aim * 1.1),
                 key=lambda p: abs(aim * 0.8 - p["pk"]) / max(aim, 1) - (0.5 * min(p["pp"], protein_left) / max(protein_left, 1)))[:3]
    heavy = sorted((p for p in portions if p["pk"] > kcal_left * 0.6), key=lambda p: -p["pk"])[:2]
    mark = lambda p: "≈" if p.get("estimated") else ""  # noqa: E731
    lines = [f"🧾 <b>Что взять</b> — осталось {n(kcal_left)} ккал" + (f", белка {n(protein_left)} г" if protein_left > 10 else "") + ":", ""]
    lines += [f"✅ {html.escape(p['name'])} — {mark(p)}{n(p['pk'])} ккал, Б {mark(p)}{n(p['pp'])}" for p in fit] or ["Под остаток ничего не влезает целиком — возьми половину порции или салат."]
    if heavy:
        lines.append("")
        lines += [f"⚠️ {html.escape(p['name'])} — {mark(p)}{n(p['pk'])} ккал, это {round(p['pk'] / max(kcal_left, 1) * 100)}% остатка" for p in heavy]
    if any(p.get("estimated") for p in portions):
        lines.append("\n≈ — оценка: КБЖУ в меню не напечатаны.")
    return "\n".join(lines)


async def menu_photo(message: Message, image: dict) -> None:
    from backend.api.ai import menu_dishes
    from backend.api.kitchen import meal_suggestions

    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        if profile is None:
            await need_profile(message)
            return
        wait = await message.answer("Читаю меню… 🔎")
        try:
            menu = await menu_dishes(session, user, image)
        except HTTPException as e:
            await wait.edit_text(f"Не получилось прочитать меню: {e.detail}")
            return
        meal = guess_meal(clock.now().hour)
        sug = await meal_suggestions(session, user, meal)
        goal = targets(profile)
        aim = sug["kcal_left"] if meal == "dinner" else min(sug["kcal_left"], goal["calories"] * 0.4)
    await wait.delete()
    if not menu["items"]:
        await message.answer(html.escape(menu["note"] or "Не нашёл в фото блюд из меню."), parse_mode="HTML")
        return
    await message.answer(menu_advice(menu["items"], sug["kcal_left"], sug["protein_left"], aim), parse_mode="HTML")


# ---- Morning check-in: sleep and energy ----

SLEEP_BTN = (("<6 ч", 1), ("6–7", 2), ("7–8", 3), ("8+", 4))
ENERGY_BTN = (("😩 мало сил", 1), ("🙂 норм", 2), ("💪 бодро", 3))


@router.callback_query(F.data.startswith("sl:"))
async def sleep_pick(call: CallbackQuery) -> None:
    from backend.api.daily import save_checkin

    async with SessionLocal() as session:
        user, _ = await me(session, call.from_user)
        await save_checkin(session, user, int(call.data[3:]), None)
    label = dict((v, k) for k, v in SLEEP_BTN)[int(call.data[3:])]
    await call.message.edit_text(f"Сон: {label}. А как энергия сейчас?",
                                 reply_markup=kb([InlineKeyboardButton(text=t, callback_data=f"en:{v}") for t, v in ENERGY_BTN]))
    await call.answer()


@router.callback_query(F.data.startswith("en:"))
async def energy_pick(call: CallbackQuery) -> None:
    from backend.api.daily import checkin_insight, save_checkin

    async with SessionLocal() as session:
        user, _ = await me(session, call.from_user)
        await save_checkin(session, user, None, int(call.data[3:]))
        insight = await checkin_insight(session, user)
    text = (call.message.text or "").split(" А как", 1)[0] + " " + dict((v, k) for k, v in ENERGY_BTN)[int(call.data[3:])] + ". Записал ✓"
    await call.message.edit_text(text + (f"\n\n💡 {insight}" if insight else ""))
    await call.answer()


# ---- Commands and buttons; any other text is food ----

@router.message(Command("eat"))
async def eat_command(message: Message) -> None:
    await eat_cmd(message, message.from_user)


@router.message(Command("help"))
async def help_cmd(message: Message) -> None:
    await message.answer(HELP, parse_mode="HTML", reply_markup=KEYBOARD)


@router.message(Command("fast"))
async def fast_command(message: Message) -> None:
    from backend.api import fasting

    async with SessionLocal() as session:
        user, _ = await me(session, message.from_user)
        plan = await session.get(fasting.FastingPlan, user.id)
        st = plan and fasting.state(plan, await fasting.last_meal(session, user.id), clock.now())
    if not plan:
        await message.answer("Интервальное голодание пока не включено. Выбери схему (12:12, 14:10, 16:8 или 18:6) и время "
                             "окна в приложении — дальше я напомню, когда окно открывается и закрывается.",
                             reply_markup=kb([app_button("Настроить голодание", "open=fasting")]))
        return
    await message.answer(fasting.text(plan, st), reply_markup=kb([app_button("Открыть таймер", "open=fasting")]))


@router.message(Command("today"))
async def today_command(message: Message) -> None:
    await today_cmd(message)


@router.message(Command("workout"))
async def workout_command(message: Message) -> None:
    await workout_cmd(message)


@router.message(F.text == BTN_TODAY)
async def today_button(message: Message) -> None:
    await today_cmd(message)


@router.message(F.text == BTN_WORKOUT)
async def workout_button(message: Message) -> None:
    await workout_cmd(message)


@router.message(F.text == BTN_WATER)
async def water_button_msg(message: Message) -> None:
    await water(message, GLASS_ML)


@router.message(F.text == BTN_FOOD)
async def food_button(message: Message) -> None:
    await message.answer(f"Напиши, что съел, — например {EXAMPLE}. Или пришли фото тарелки.",
                         reply_markup=kb([app_button("Открыть дневник", "open=food")]))


@router.message(F.text)
async def any_text(message: Message) -> None:
    text = message.text.strip()
    if text.startswith("/"):
        await message.answer(HELP, parse_mode="HTML", reply_markup=KEYBOARD)
        return
    if re.fullmatch(r"(?:а\s+)?что\s+(?:мне\s+)?(?:поесть|съесть|покушать)\??", text.strip().lower()):
        await eat_cmd(message, message.from_user)
    elif await correct(message, text):
        pass
    elif (ml := water_amount(text)) is not None:
        await water(message, ml)
    elif m := WEIGHT.match(text):
        await weight(message, float((m[1] or m[2]).replace(",", ".")))
    elif len(text) > 300:
        await message.answer("Слишком длинно — напиши покороче, например " + EXAMPLE + ".")
    else:
        await log_food(message, text)


async def me_for_test(tg_id: int) -> None:
    """Tests: the account a first /start creates."""
    from types import SimpleNamespace

    async with SessionLocal() as session:
        await me(session, SimpleNamespace(id=tg_id, first_name="Тест", username=None, language_code="ru"))


@router.message()
async def anything_else(message: Message) -> None:
    """Stickers, files, a forwarded post, a kind of message the bot doesn't know yet: never silence."""
    if message.forward_origin and message.forward_origin.type == "channel":
        await message.answer("Пост из канала сохраняет как карусель только владелец бота. Если это ты — отправь /stats: "
                             "я пришлю твой Telegram ID и подскажу, что вписать в .env (ADMIN_IDS), затем перезапусти бота.")
    else:
        await message.answer(HELP, parse_mode="HTML", reply_markup=KEYBOARD)
