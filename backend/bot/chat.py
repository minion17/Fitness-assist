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
    f"🍽 <b>Записать еду</b> — напишите, что съели: {EXAMPLE}. Или пришлите фото тарелки.\n"
    "💧 <b>Вода</b> — кнопка «+250 мл» или сообщение «+300».\n"
    "⚖️ <b>Вес</b> — «вес 76,4».\n"
    "📊 /today — сколько съедено и сколько осталось.\n"
    "💪 /workout — тренировка на сегодня.\n\n"
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
    await message.answer("Сначала короткая анкета — 2 минуты. Без неё я не знаю вашу норму калорий.",
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


def logged_text(meal: str, items: list[DraftItem], eaten: float, goal: dict | None, note: str = "") -> str:
    tot = {k: sum(getattr(i, f"{k}_100g") * i.grams / 100 for i in items) for k in ("kcal", "protein", "fat", "carbs")}
    lines = [f"✅ Записал в {MEALS[meal]}:"]
    lines += [f"• {html.escape(i.name)} — {dec(i.grams)} г, {n(i.kcal_100g * i.grams / 100)} ккал" for i in items]
    lines.append(f"\nИтого {n(tot['kcal'])} ккал · Б {n(tot['protein'])} · Ж {n(tot['fat'])} · У {n(tot['carbs'])}")
    if goal:
        left = goal["calories"] - eaten
        lines.append(f"Сегодня {n(eaten)} из {n(goal['calories'])} ккал" + (f", осталось {n(left)}" if left > 0 else ""))
    if note:
        lines.append(f"\nⓘ {html.escape(note)}")
    return "\n".join(lines)


def logged_keyboard(meal: str, ids: list[int]) -> InlineKeyboardMarkup | None:
    packed = pack(ids)
    if len(f"fm:x:{packed}") > 64:
        return kb([app_button("Открыть дневник", "open=food")])
    move = [InlineKeyboardButton(text=f"→ {MEALS[m].capitalize()}", callback_data=f"fm:{SHORT[m]}:{packed}")
            for m in MEALS if m != meal]
    return kb(move[:2], move[2:] + [InlineKeyboardButton(text="↩ Отменить", callback_data=f"fu:{packed}")])


async def log_food(message: Message, text: str = "", image: dict | None = None) -> None:
    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        if profile is None:
            await need_profile(message)
            return
        meal = asked_meal(message.chat.id) or guess_meal(clock.now().hour)
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
                    await wait.edit_text(f"Не получилось распознать: {e.detail}\n\nНапишите с граммами, например {EXAMPLE} — "
                                         "такое я посчитаю и без AI.")
                    return
                draft = None  # AI unavailable or out of quota: the catalog's picks are still a good answer
            await wait.delete()
            if draft is not None:
                items, note = draft_items(draft), draft["note"]
            if not items:
                await message.answer((html.escape(note) + "\n\n" if note else "") +
                                     f"Не понял, что записать. Напишите, например, {EXAMPLE}.", parse_mode="HTML")
                return
        logs = await save_draft(session, user, meal, items)
        await award_xp(session, user.id, "meal_logged", f"meal:{clock.today()}:{meal}")
        eaten = await day_kcal(session, user)
        await message.answer(logged_text(meal, items, eaten, targets(profile), note), parse_mode="HTML",
                             reply_markup=logged_keyboard(meal, [l.id for l in logs]))


@router.callback_query(F.data.startswith("fm:"))
async def move_food(call: CallbackQuery) -> None:
    _, code, packed = call.data.split(":", 2)
    meal = CODE.get(code)
    async with SessionLocal() as session:
        user, _ = await me(session, call.from_user)
        logs = list(await session.scalars(select(FoodLog).where(FoodLog.id.in_(unpack(packed)), FoodLog.user_id == user.id)))
        if not meal or not logs:
            await call.answer("Этих записей уже нет")
            return
        for log in logs:
            log.meal_type, log.snack_slot = meal, clock.local(log.logged_at).strftime("%H:%M") if meal == "snack" else None
        await session.commit()
        await award_xp(session, user.id, "meal_logged", f"meal:{clock.today()}:{meal}")
    text = (call.message.text or "").split("\n", 1)
    await call.message.edit_text(f"✅ Записал в {MEALS[meal]}:\n{text[1] if len(text) > 1 else ''}",
                                 reply_markup=logged_keyboard(meal, [l.id for l in logs]))
    await call.answer(f"Перенёс в {MEALS[meal]}")


@router.callback_query(F.data.startswith("fu:"))
async def undo_food(call: CallbackQuery) -> None:
    async with SessionLocal() as session:
        user, _ = await me(session, call.from_user)
        await session.execute(delete(FoodLog).where(FoodLog.id.in_(unpack(call.data[3:])), FoodLog.user_id == user.id))
        await session.commit()
    await call.message.edit_text("↩ Отменено — из дневника убрал.")
    await call.answer()


@router.callback_query(F.data.startswith("ask:"))
async def ask_meal(call: CallbackQuery) -> None:
    meal = CODE.get(call.data[4:], "dinner")
    _asked[call.message.chat.id] = (meal, time.time() + 30 * 60)
    await call.message.answer(f"Напишите, что было на {MEALS[meal]}, — например «рыба 150 г, рис 100 г». Или пришлите фото.")
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
        await message.answer("Фото слишком большое — пришлите поменьше (до 6 МБ).")
        return
    data = (await bot.download(photo)).read()
    image = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(data).decode()}}
    await log_food(message, (message.caption or "")[:300], image)


@router.message(F.voice | F.video_note)
async def voice(message: Message) -> None:
    await message.answer(f"Голосовые пока не понимаю. Напишите текстом, например {EXAMPLE}, или пришлите фото.")


# ---- Water and weight ----

WATER = re.compile(r"^(?:вода\s*)?\+\s*(\d{2,4})\s*(?:мл|ml)?$|^вода\s+(\d{2,4})\s*(?:мл|ml)?$", re.I)
WEIGHT = re.compile(r"^(?:вес|weight)\s*:?\s*(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg)?$|^(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg)$", re.I)


async def water(message: Message, ml: int) -> None:
    async with SessionLocal() as session:
        user, profile = await me(session, message.from_user)
        res = await add_water(WaterIn(delta_ml=max(-1000, min(1000, ml))),
                              tg=tgd(message.from_user), session=session)
    done = " Норма на сегодня выполнена 🎉" if res["ml"] >= res["goal_ml"] and res["ml"] - ml < res["goal_ml"] else ""
    await message.answer(f"💧 +{ml} мл · {liters(res['ml'])} из {liters(res['goal_ml'])} л.{done}",
                         reply_markup=kb([InlineKeyboardButton(text=f"↩ −{ml} мл", callback_data=f"w:-{ml}")]))


@router.callback_query(F.data.startswith("w:"))
async def water_button(call: CallbackQuery) -> None:
    delta = int(call.data[2:])
    async with SessionLocal() as session:
        await me(session, call.from_user)
        res = await add_water(WaterIn(delta_ml=max(-1000, min(1000, delta))),
                              tg=tgd(call.from_user), session=session)
    text = f"💧 {liters(res['ml'])} из {liters(res['goal_ml'])} л."
    if delta < 0:
        await call.message.edit_text(f"↩ Убрал {-delta} мл. {text}")
    else:
        await call.message.answer(f"💧 +{delta} мл · {text[2:]}", reply_markup=kb([InlineKeyboardButton(text=f"↩ −{delta} мл", callback_data=f"w:-{delta}")]))
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
    await water(message, int(arg) if arg.isdigit() and 50 <= int(arg) <= 1000 else GLASS_ML)


@router.message(Command("weight"))
async def weight_cmd(message: Message, command: CommandObject) -> None:
    arg = (command.args or "").replace(",", ".").replace("кг", "").strip()
    try:
        await weight(message, float(arg))
    except ValueError:
        await message.answer("Напишите вес сообщением, например: вес 76,4")


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
        [InlineKeyboardButton(text="💧 +250 мл", callback_data="w:250")], [app_button("Открыть дневник", "open=food")]))


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
            await message.answer("Программа ещё не выбрана — выберите её в приложении.",
                                 reply_markup=kb([app_button("Выбрать программу", "open=workout")]))
            return
        rest = profile.training_days and today.weekday() not in profile.training_days
        head = ("💪 Сегодня уже потренировались ✓ Следующая тренировка:" if trained else
                "😌 Сегодня по плану отдых. Если хочется — следующая тренировка:" if rest else "💪 Тренировка на сегодня:")
        sets = sum(i.sets for i in day.items)
        minutes = round(sum(i.sets * (45 + i.rest_seconds) for i in day.items) / 60 / 5) * 5
        lines = [head, f"\n<b>{html.escape(day.day_name)}</b> — {len(day.items)} упр., ~{max(minutes, 10)} мин\n"]
        lines += [f"• {html.escape(i.exercise.name)} — {i.sets} × {html.escape(i.reps)}" for i in day.items[:8]]
        if len(day.items) > 8:
            lines.append(f"• и ещё {len(day.items) - 8}")
        lines.append(f"\nВсего {sets} подходов. Таймер отдыха и веса с прошлого раза — в приложении.")
    await message.answer("\n".join(lines), parse_mode="HTML",
                         reply_markup=kb([app_button("Начать тренировку" if not trained else "Открыть тренировки", "open=workout")]))


# ---- Tour ----

TOUR_CAPTIONS = ("Листайте стрелками →", "", "", "Ответьте на пару вопросов — и я соберу ваш план: норму КБЖУ, воду и "
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
TOUR_INVITE = "Ответьте на пару вопросов — и я соберу ваш план: норму КБЖУ, воду и программу тренировок. Это 2 минуты."


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
        await message.answer(f"Не получилось скопировать: {e}. Проверьте, что бот — админ канала.")


@router.callback_query(F.data.startswith("tour:"))
async def tour_flip(call: CallbackQuery) -> None:
    i = int(call.data[5:]) % len(cards.TOUR) if call.data[5:].isdigit() else 0
    await call.answer()
    try:
        await call.message.edit_media(InputMediaPhoto(media=await tour_card(call.from_user.id, i), caption=TOUR_CAPTIONS[i] or None),
                                      reply_markup=tour_keyboard(i))
    except Exception:
        pass  # a double tap: "message is not modified"


# ---- Commands and buttons; any other text is food ----

@router.message(Command("help"))
async def help_cmd(message: Message) -> None:
    await message.answer(HELP, parse_mode="HTML", reply_markup=KEYBOARD)


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
    await message.answer(f"Напишите, что съели, — например {EXAMPLE}. Или пришлите фото тарелки.",
                         reply_markup=kb([app_button("Открыть дневник", "open=food")]))


@router.message(F.text)
async def any_text(message: Message) -> None:
    text = message.text.strip()
    if text.startswith("/"):
        await message.answer(HELP, parse_mode="HTML", reply_markup=KEYBOARD)
        return
    if m := WATER.match(text):
        await water(message, min(1000, int(m[1] or m[2])))
    elif m := WEIGHT.match(text):
        await weight(message, float((m[1] or m[2]).replace(",", ".")))
    elif len(text) > 300:
        await message.answer("Слишком длинно — напишите покороче, например " + EXAMPLE + ".")
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
        await message.answer("Пост из канала сохраняет как карусель только владелец бота. Если это вы — отправьте /stats: "
                             "я пришлю ваш Telegram ID и подскажу, что вписать в .env (ADMIN_IDS), затем перезапустите бота.")
    else:
        await message.answer(HELP, parse_mode="HTML", reply_markup=KEYBOARD)
