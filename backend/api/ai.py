"""AI features: meal from text/photo (draft → user confirms) and day/week summaries."""
import base64
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import ai
from backend.core.config import settings
from backend.core.search import stems, word_start
from backend.core.nutrition import GOAL_RU, daily_targets
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import (
    AiRequest,
    AiSummary,
    BodyMeasurement,
    FoodLog,
    Product,
    Profile,
    User,
    WorkoutLog,
)
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api/ai")

STRESS_RU = {"low": "низкий", "moderate": "умеренный", "high": "высокий"}
INJURY_RU = {"knees": "колени", "back": "спина", "shoulders": "плечи", "other": "есть травма"}
ALLERGY_RU = {"dairy": "молочное", "eggs": "яйца", "gluten": "глютен", "nuts": "орехи", "fish": "рыба"}

MealType = Literal["breakfast", "lunch", "dinner", "snack"]
MAX_IMAGE_BYTES = 6 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
CATALOG_LIMIT = 400  # products in the prompt: own ones, those named in the text, then plain staples


def day_start(d: date) -> datetime:
    return clock.local_start(d)


async def use_quota(session: AsyncSession, user: User, kind: str) -> None:
    """Count the request against the daily limit before calling the paid API."""
    if not settings.anthropic_api_key:
        raise HTTPException(503, "AI не настроен: добавьте ANTHROPIC_API_KEY в .env")
    used = await session.scalar(
        select(func.count(AiRequest.id)).where(
            AiRequest.user_id == user.id, AiRequest.created_at >= day_start(clock.today())
        )
    )
    if used >= settings.ai_daily_limit:
        raise HTTPException(429, f"Лимит AI-запросов на сегодня исчерпан ({settings.ai_daily_limit}). Завтра снова можно.")
    session.add(AiRequest(user_id=user.id, kind=kind))
    await session.commit()


def ai_errors(e: ai.AIUnavailable) -> HTTPException:
    return HTTPException(503, f"AI сейчас недоступен: {e}")


# ---- Meal recognition ----

MEAL_SYSTEM = """Ты помощник дневника питания. Разбери, что съел пользователь, на отдельные продукты с массой в граммах.
Правила:
- Если продукт есть в каталоге — укажи его catalog_id. Выбирай по смыслу и состоянию продукта: крупы в каталоге могут быть сухими; если человек ел готовую кашу, а в каталоге только сухая крупа — не бери её, а дай свою оценку для готового блюда.
- Если подходящего продукта в каталоге нет — catalog_id = null, дай короткое название и свою оценку КБЖУ на 100 г.
- Массу оценивай реалистично: «тарелка супа» ≈ 300 г, «яйцо» ≈ 55 г, «кусок хлеба» ≈ 30 г, «ложка масла» ≈ 10 г.
- Не выдумывай продукты, которых нет в описании/на фото. Если на фото не еда или ничего не понять — верни пустой список и объясни в note.
- note — одна короткая фраза по-русски, только если есть важная неопределённость. Иначе пусто."""

MEAL_TOOL = {
    "name": "record_meal",
    "description": "Записать распознанные продукты приёма пищи",
    "input_schema": {
        "type": "object",
        "properties": {
            "meal_type": {"type": ["string", "null"], "enum": ["breakfast", "lunch", "dinner", "snack", None]},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "catalog_id": {"type": ["integer", "null"]},
                        "name": {"type": "string"},
                        "grams": {"type": "number"},
                        "kcal_100g": {"type": "number"},
                        "protein_100g": {"type": "number"},
                        "fat_100g": {"type": "number"},
                        "carbs_100g": {"type": "number"},
                    },
                    "required": ["catalog_id", "name", "grams", "kcal_100g", "protein_100g", "fat_100g", "carbs_100g"],
                },
            },
            "note": {"type": "string"},
        },
        "required": ["items"],
    },
}


async def visible_products(session: AsyncSession, user: User, text: str = "") -> dict[int, Product]:
    """The catalog can't go whole into the prompt (thousands of supermarket items): the user's own products, then those
    whose words appear in the text ("гречка с котлетой"), then plain staples without a brand (огурец, борщ, банан)."""
    out: dict[int, Product] = {}

    async def take(where, order, limit: int) -> None:
        for p in await session.scalars(select(Product).where(where, Product.id.not_in(out.keys() or [0])).order_by(*order).limit(limit)):
            out[p.id] = p

    await take(Product.owner_user_id == user.id, [Product.id.desc()], 100)
    words = [w for w in stems(text.lower().replace("ё", "е")) if len(w) >= 3]
    if words:
        await take(Product.owner_user_id.is_(None) & or_(*(word_start(Product.search_text, w) for w in words)),
                   [Product.brand.is_not(None), func.length(Product.name)], 150)
    # staples people actually log come first, so the budget isn't spent on the start of the alphabet
    logged = select(func.count(FoodLog.id)).where(FoodLog.product_id == Product.id).scalar_subquery()
    await take(Product.owner_user_id.is_(None) & Product.brand.is_(None) & Product.barcode.is_(None),
               [logged.desc(), func.length(Product.name), Product.name], CATALOG_LIMIT - len(out))
    return out


def catalog_text(products: dict[int, Product]) -> str:
    lines = [f"{p.id} | {p.name}{f' ({p.brand})' if p.brand else ''} | {round(p.kcal)} ккал/100г" for p in products.values()]
    return "Каталог (id | название | ккал на 100 г):\n" + ("\n".join(lines) or "пусто")


def clamp(v, lo: float, hi: float) -> float:
    try:
        return round(min(hi, max(lo, float(v))), 1)
    except (TypeError, ValueError):
        return lo


def build_draft(raw: dict, products: dict[int, Product]) -> dict:
    """Trust the catalog over the model: known products get DB values; unknown ones get clamped estimates."""
    items = []
    for it in raw.get("items") or []:
        grams = clamp(it.get("grams"), 0, 3000)
        if grams <= 0 or not str(it.get("name", "")).strip():
            continue
        p = products.get(it.get("catalog_id")) if isinstance(it.get("catalog_id"), int) else None
        if p:
            items.append({
                "product_id": p.id, "name": p.name, "grams": grams, "from_catalog": True,
                "kcal_100g": p.kcal, "protein_100g": p.protein_g, "fat_100g": p.fat_g, "carbs_100g": p.carbs_g,
            })
        else:
            items.append({
                "product_id": None, "name": str(it["name"]).strip()[:200], "grams": grams, "from_catalog": False,
                "kcal_100g": clamp(it.get("kcal_100g"), 0, 900), "protein_100g": clamp(it.get("protein_100g"), 0, 100),
                "fat_100g": clamp(it.get("fat_100g"), 0, 100), "carbs_100g": clamp(it.get("carbs_100g"), 0, 100),
            })
    meal = raw.get("meal_type")
    return {"meal_type": meal if meal in MealType.__args__ else None, "items": items, "note": (raw.get("note") or "").strip()}


async def recognise(session: AsyncSession, user: User, kind: str, content: list[dict], text: str = "") -> dict:
    await use_quota(session, user, kind)
    products = await visible_products(session, user, text)
    try:
        raw = await ai.call_tool(MEAL_SYSTEM, [{"type": "text", "text": catalog_text(products)}, *content], MEAL_TOOL)
    except ai.AIUnavailable as e:
        raise ai_errors(e)
    return build_draft(raw, products)


class MealTextIn(BaseModel):
    text: str = Field(min_length=2, max_length=1000)


@router.post("/meal/text")
async def meal_from_text(body: MealTextIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    return await recognise(session, user, "meal_text", [{"type": "text", "text": f"Пользователь пишет: {body.text}"}], body.text)


@router.post("/meal/photo")
async def meal_from_photo(
    file: UploadFile = File(...), tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    if file.content_type not in IMAGE_TYPES:
        raise HTTPException(415, "Нужна фотография (JPEG, PNG или WebP)")
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Фото слишком большое (до 6 МБ)")
    user = await get_or_create_user(tg, session)
    image = {"type": "image", "source": {"type": "base64", "media_type": file.content_type, "data": base64.b64encode(data).decode()}}
    return await recognise(session, user, "meal_photo", [image, {"type": "text", "text": "Что на фото и сколько примерно грамм?"}])


class DraftItem(BaseModel):
    product_id: int | None = None
    name: str = Field(min_length=1, max_length=200)
    grams: float = Field(gt=0, le=3000)
    kcal_100g: float = Field(ge=0, le=900)
    protein_100g: float = Field(ge=0, le=100)
    fat_100g: float = Field(ge=0, le=100)
    carbs_100g: float = Field(ge=0, le=100)


class ConfirmIn(BaseModel):
    meal_type: MealType
    items: list[DraftItem] = Field(min_length=1, max_length=30)


@router.post("/meal/confirm")
async def confirm_meal(body: ConfirmIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Write the (possibly edited) draft to the diary. Unknown products become the user's own products."""
    user = await get_or_create_user(tg, session)
    slot = clock.now().strftime("%H:%M") if body.meal_type == "snack" else None  # one snack per recognised meal
    logs = []
    for it in body.items:
        if it.product_id is not None:
            product = await session.get(Product, it.product_id)
            if product is None or product.owner_user_id not in (None, user.id):
                raise HTTPException(404, f"Продукт «{it.name}» не найден")
        else:
            product = await session.scalar(
                select(Product).where(Product.owner_user_id == user.id, Product.name == it.name)
            )
            if product is None:
                product = Product(owner_user_id=user.id, name=it.name, category="Мои продукты")
                session.add(product)
            # the user may have corrected the estimate — keep their latest numbers
            product.kcal, product.protein_g = it.kcal_100g, it.protein_100g
            product.fat_g, product.carbs_g = it.fat_100g, it.carbs_100g
            await session.flush()
        logs.append(FoodLog(user_id=user.id, product_id=product.id, amount_g=it.grams, meal_type=body.meal_type,
                            snack_slot=slot))
    session.add_all(logs)
    await session.commit()
    # same key as the manual diary, so XP stays once per meal type per day
    xp = await award_xp(session, user.id, "meal_logged", f"meal:{clock.today()}:{body.meal_type}")
    return {"added": len(logs), "xp_awarded": xp}


# ---- Summaries ----

SUMMARY_SYSTEM = """Ты доброжелательный фитнес-помощник. По данным пользователя напиши короткий итог по-русски.
Формат (не больше 90 слов, без заголовков и markdown):
1–2 предложения: что получилось и что нет — с конкретными цифрами из данных.
Затем строка «Совет: …» — один-два конкретных выполнимых шага на завтра.
Правила:
- Опирайся только на переданные данные, ничего не выдумывай. Если данных почти нет — скажи об этом и предложи начать с записи приёмов пищи.
- Тон поддерживающий, без стыда и давления. Не предлагай резких ограничений, голодания или калорийности ниже нормы из анкеты.
- Если человек сильно недоедает несколько дней подряд — мягко напомни, что есть достаточно важно, и при сложностях стоит обратиться к врачу или диетологу.
- Не ставь диагнозов и не давай медицинских назначений."""


async def summary_data(session: AsyncSession, user: User, period: str) -> str:
    today = clock.today()
    days = 1 if period == "day" else 7
    start = day_start(today - timedelta(days=days - 1))
    profile = await session.get(Profile, user.id)
    lines = [f"Период: {'сегодня' if period == 'day' else 'последние 7 дней'} (по {today.isoformat()})."]
    if profile:
        t = daily_targets(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity, profile.goal)
        lines.append(f"Цель: {GOAL_RU.get(profile.goal, profile.goal)}. "
                     f"Норма в день: {t['calories']} ккал, Б {t['protein']} г, Ж {t['fat']} г, У {t['carbs']} г.")
        extra = [
            profile.sleep_hours and f"сон ~{profile.sleep_hours} ч",
            profile.stress and f"стресс: {STRESS_RU[profile.stress]}",
            profile.injury and f"ограничение: {INJURY_RU[profile.injury]}",
            profile.allergies and f"аллергии: {', '.join(ALLERGY_RU[a] for a in profile.allergies)}",
        ]
        if any(extra):
            lines.append("Из анкеты: " + "; ".join(x for x in extra if x) + ".")
    else:
        lines.append("Анкета не заполнена — нормы нет.")

    logs = (await session.scalars(
        select(FoodLog).where(FoodLog.user_id == user.id, FoodLog.logged_at >= start).order_by(FoodLog.logged_at)
    )).all()
    ids = {l.product_id for l in logs}
    products = {p.id: p for p in (await session.scalars(select(Product).where(Product.id.in_(ids)))).all()} if ids else {}
    by_day: dict[date, dict] = {}
    for l in logs:
        p, k = products[l.product_id], l.amount_g / 100
        d = by_day.setdefault(l.logged_at.astimezone(clock.tz()).date(), {"kcal": 0, "p": 0, "f": 0, "c": 0, "items": []})
        d["kcal"] += p.kcal * k; d["p"] += p.protein_g * k; d["f"] += p.fat_g * k; d["c"] += p.carbs_g * k
        d["items"].append(f"{p.name} {round(l.amount_g)} г")
    if by_day:
        for d, v in sorted(by_day.items()):
            extra = f"; продукты: {', '.join(v['items'][:15])}" if period == "day" else ""
            lines.append(f"{d.isoformat()}: {round(v['kcal'])} ккал, Б {round(v['p'])}, Ж {round(v['f'])}, У {round(v['c'])}{extra}")
        if period == "week":
            lines.append(f"Дней с записями питания: {len(by_day)} из 7.")
    else:
        lines.append("Записей питания за период нет.")

    workouts = (await session.scalars(
        select(WorkoutLog).where(WorkoutLog.user_id == user.id, WorkoutLog.started_at >= start)
    )).all()
    done = [w for w in workouts if w.completed_at]
    lines.append(f"Тренировок завершено: {len(done)}" + (f" ({', '.join(w.title for w in done[:7])})" if done else "") + ".")

    weights = (await session.scalars(
        select(BodyMeasurement).where(
            BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None),
            BodyMeasurement.measured_on >= today - timedelta(days=30),
        ).order_by(BodyMeasurement.measured_on)
    )).all()
    if weights:
        lines.append(f"Вес: {weights[-1].weight_kg} кг ({weights[-1].measured_on})"
                     + (f", месяц назад в данных {weights[0].weight_kg} кг ({weights[0].measured_on})" if len(weights) > 1 else "") + ".")
    return "\n".join(lines)


@router.get("/summary")
async def summary(
    period: Literal["day", "week"] = "day", refresh: bool = False,
    tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session),
):
    user = await get_or_create_user(tg, session)
    today = clock.today()
    cached = await session.scalar(
        select(AiSummary).where(AiSummary.user_id == user.id, AiSummary.period == period, AiSummary.day == today)
    )
    if cached and not refresh:
        return {"period": period, "text": cached.text, "created_at": cached.created_at.isoformat(), "cached": True}
    await use_quota(session, user, f"summary_{period}")
    data = await summary_data(session, user, period)
    try:
        text = await ai.call_text(SUMMARY_SYSTEM, [{"type": "text", "text": data}])
    except ai.AIUnavailable as e:
        raise ai_errors(e)
    if not text:
        raise HTTPException(503, "AI вернул пустой ответ, попробуйте ещё раз")
    row = (await session.execute(
        insert(AiSummary).values(user_id=user.id, period=period, day=today, text=text)
        .on_conflict_do_update(index_elements=["user_id", "period", "day"], set_={"text": text, "created_at": func.now()})
        .returning(AiSummary.created_at)
    )).scalar_one()
    await session.commit()
    return {"period": period, "text": text, "created_at": row.isoformat(), "cached": False}


@router.get("/status")
async def status(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Lets the UI hide AI buttons when no key is configured and show remaining quota."""
    user = await get_or_create_user(tg, session)
    used = await session.scalar(
        select(func.count(AiRequest.id)).where(AiRequest.user_id == user.id, AiRequest.created_at >= day_start(clock.today()))
    )
    return {"enabled": bool(settings.anthropic_api_key), "used_today": used, "daily_limit": settings.ai_daily_limit}


# ---- Nutrition label (for products missing from every database) ----

LABEL_SYSTEM = """Ты читаешь фото упаковки продукта и переписываешь пищевую ценность из таблицы на этикетке.
Правила:
- Бери только числа, напечатанные на упаковке, ничего не придумывай и не подставляй «типичные» значения.
- Нужны значения на 100 г (или 100 мл). Если указано только на порцию и вес порции напечатан — пересчитай на 100 г.
- Если энергия дана только в кДж — переведи в ккал (кДж / 4.184).
- Десятичная запятая: «5,7» = 5.7.
- Название — коротко, как на упаковке (вид продукта, марка, жирность), если оно видно; иначе пустая строка.
- brand — торговая марка или производитель, если видно, иначе пустая строка.
- net_amount — масса нетто или объём всей упаковки, если напечатан («450 г» → 450, «0,5 л» → 500), иначе 0; net_unit — "g" или "ml".
- pieces — сколько штук внутри, если напечатано («6 шт × 50 г» → 6, батончик 40 г → 1), иначе 0.
- Если таблицы пищевой ценности на фото нет или её нельзя прочитать — found = false и объясни в note, как переснять."""

LABEL_TOOL = {
    "name": "nutrition_label",
    "description": "Пищевая ценность с этикетки на 100 г",
    "input_schema": {
        "type": "object",
        "properties": {
            "found": {"type": "boolean"},
            "name": {"type": "string"},
            "kcal_100g": {"type": "number"},
            "protein_100g": {"type": "number"},
            "fat_100g": {"type": "number"},
            "carbs_100g": {"type": "number"},
            "brand": {"type": "string"},
            "net_amount": {"type": "number"},
            "net_unit": {"type": "string", "enum": ["g", "ml", ""]},
            "pieces": {"type": "integer"},
            "note": {"type": "string"},
        },
        "required": ["found", "name", "kcal_100g", "protein_100g", "fat_100g", "carbs_100g", "brand", "net_amount", "net_unit", "pieces", "note"],
    },
}


@router.post("/label")
async def read_label(
    file: UploadFile = File(...), tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    """Fill the custom-product form from a photo of the package's nutrition table."""
    if file.content_type not in IMAGE_TYPES:
        raise HTTPException(415, "Нужна фотография (JPEG, PNG или WebP)")
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Фото слишком большое (до 6 МБ)")
    user = await get_or_create_user(tg, session)
    await use_quota(session, user, "label")
    image = {"type": "image", "source": {"type": "base64", "media_type": file.content_type, "data": base64.b64encode(data).decode()}}
    try:
        raw = await ai.call_tool(LABEL_SYSTEM, [image, {"type": "text", "text": "Перепиши пищевую ценность на 100 г."}], LABEL_TOOL, 500)
    except ai.AIUnavailable as e:
        raise ai_errors(e)
    if not raw.get("found"):
        return {"found": False, "note": str(raw.get("note") or "Не удалось прочитать таблицу пищевой ценности — снимите её ближе и ровнее.")}
    out = {k: round(clamp(raw.get(f"{k}_100g", 0), 0, hi), 1) for k, hi in (("kcal", 900), ("protein", 100), ("fat", 100), ("carbs", 100))}
    net = clamp(raw.get("net_amount") or 0, 0, 5000)
    pieces = int(clamp(raw.get("pieces") or 0, 0, 100))
    return {"found": True, "name": str(raw.get("name") or "")[:200], "kcal": out["kcal"], "protein_g": out["protein"],
            "fat_g": out["fat"], "carbs_g": out["carbs"], "note": str(raw.get("note") or ""),
            "brand": str(raw.get("brand") or "")[:100], "package_g": round(net, 1) if net >= 1 else None,
            "pieces": pieces if pieces > 1 else None, "liquid": raw.get("net_unit") == "ml"}


# ---- Restaurant menu / delivery-app dish card ----

MENU_SYSTEM = """Ты читаешь фото меню ресторана, карточки блюда в приложении доставки или упаковки готовой еды.
Перепиши блюда, для которых на фото напечатана пищевая ценность.
Правила:
- Только напечатанные числа, ничего не оценивай «на глаз». Блюдо без КБЖУ на фото — пропусти.
- Нужны значения на 100 г. Если КБЖУ даны на порцию и вес порции напечатан — пересчитай на 100 г. Если вес порции не указан — пропусти блюдо.
- portion_g — вес порции/выход, если он напечатан, иначе null. portion_name — «порция», «пицца», «кусок», «шт» и т. п.
- Название — как в меню, с размером если он есть («Пепперони 30 см»).
- venue — название заведения или бренда, если оно видно на фото (логотип, шапка меню, заголовок приложения), иначе пустая строка.
- Если ни у одного блюда нет КБЖУ — пустой список и объясни в note, что снять (например, раскрыть «Пищевая ценность» в карточке)."""

MENU_TOOL = {
    "name": "menu_dishes",
    "description": "Блюда с напечатанной пищевой ценностью",
    "input_schema": {
        "type": "object",
        "properties": {
            "venue": {"type": "string"},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "portion_g": {"type": ["number", "null"]},
                        "portion_name": {"type": "string"},
                        "kcal_100g": {"type": "number"},
                        "protein_100g": {"type": "number"},
                        "fat_100g": {"type": "number"},
                        "carbs_100g": {"type": "number"},
                    },
                    "required": ["name", "portion_g", "portion_name", "kcal_100g", "protein_100g", "fat_100g", "carbs_100g"],
                },
            },
            "note": {"type": "string"},
        },
        "required": ["venue", "items", "note"],
    },
}


@router.post("/menu")
async def read_menu(
    file: UploadFile = File(...), tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    """Dishes with printed nutrition from a menu / delivery-app photo, for the user to pick and save."""
    if file.content_type not in IMAGE_TYPES:
        raise HTTPException(415, "Нужна фотография (JPEG, PNG или WebP)")
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Фото слишком большое (до 6 МБ)")
    user = await get_or_create_user(tg, session)
    await use_quota(session, user, "menu")
    image = {"type": "image", "source": {"type": "base64", "media_type": file.content_type, "data": base64.b64encode(data).decode()}}
    try:
        raw = await ai.call_tool(MENU_SYSTEM, [image, {"type": "text", "text": "Перепиши блюда с КБЖУ."}], MENU_TOOL, 3000)
    except ai.AIUnavailable as e:
        raise ai_errors(e)
    items = []
    for it in (raw.get("items") or [])[:40]:
        name = str(it.get("name") or "").strip()[:200]
        if len(name) < 2:
            continue
        macros = {k: clamp(it.get(f"{k}_100g"), 0, 100) for k in ("protein", "fat", "carbs")}
        if sum(macros.values()) > 101:  # misread: physically impossible per 100 g
            continue
        portion = it.get("portion_g")
        items.append({
            "name": name, "kcal": clamp(it.get("kcal_100g"), 0, 900),
            "protein_g": macros["protein"], "fat_g": macros["fat"], "carbs_g": macros["carbs"],
            "portion_g": clamp(portion, 1, 3000) if isinstance(portion, (int, float)) and portion > 0 else None,
            "portion_name": (str(it.get("portion_name") or "").strip() or "порция")[:40],
        })
    return {"venue": str(raw.get("venue") or "").strip()[:100], "items": items, "note": str(raw.get("note") or "")}


async def weekly_tip(session: AsyncSession, user: User) -> str | None:
    """The week's AI summary for the Sunday bot message: today's cached one or a fresh one; None if AI is off/fails.
    Sent by the app itself, so it doesn't count against the user's daily AI limit."""
    if not settings.anthropic_api_key:
        return None
    today = clock.today()
    cached = await session.scalar(
        select(AiSummary).where(AiSummary.user_id == user.id, AiSummary.period == "week", AiSummary.day == today)
    )
    if cached:
        return cached.text
    try:
        text = await ai.call_text(SUMMARY_SYSTEM, [{"type": "text", "text": await summary_data(session, user, "week")}])
    except ai.AIUnavailable:
        return None
    if text:
        await session.execute(insert(AiSummary).values(user_id=user.id, period="week", day=today, text=text).on_conflict_do_nothing())
        await session.commit()
    return text or None
