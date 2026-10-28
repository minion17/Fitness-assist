"""AI features: meal from text/photo (draft → user confirms) and day/week summaries."""
import base64
from datetime import date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import ai
from backend.core.config import settings
from backend.core.nutrition import daily_targets
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

MealType = Literal["breakfast", "lunch", "dinner", "snack"]
MAX_IMAGE_BYTES = 6 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
CATALOG_LIMIT = 400  # shortcut: whole catalog goes into the prompt; prefilter by keywords once it grows past this


def day_start(d: date) -> datetime:
    return datetime.combine(d, time.min).astimezone()  # server-local day, same as the food diary


async def use_quota(session: AsyncSession, user: User, kind: str) -> None:
    """Count the request against the daily limit before calling the paid API."""
    if not settings.anthropic_api_key:
        raise HTTPException(503, "AI не настроен: добавьте ANTHROPIC_API_KEY в .env")
    used = await session.scalar(
        select(func.count(AiRequest.id)).where(
            AiRequest.user_id == user.id, AiRequest.created_at >= day_start(date.today())
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


async def visible_products(session: AsyncSession, user: User) -> dict[int, Product]:
    rows = await session.scalars(
        select(Product)
        .where((Product.owner_user_id.is_(None)) | (Product.owner_user_id == user.id))
        .order_by(Product.owner_user_id.is_(None), Product.name)  # own products first
        .limit(CATALOG_LIMIT)
    )
    return {p.id: p for p in rows}


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


async def recognise(session: AsyncSession, user: User, kind: str, content: list[dict]) -> dict:
    await use_quota(session, user, kind)
    products = await visible_products(session, user)
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
    return await recognise(session, user, "meal_text", [{"type": "text", "text": f"Пользователь пишет: {body.text}"}])


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
        logs.append(FoodLog(user_id=user.id, product_id=product.id, amount_g=it.grams, meal_type=body.meal_type))
    session.add_all(logs)
    await session.commit()
    # same key as the manual diary, so XP stays once per meal type per day
    xp = await award_xp(session, user.id, "meal_logged", f"meal:{date.today()}:{body.meal_type}")
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
    today = date.today()
    days = 1 if period == "day" else 7
    start = day_start(today - timedelta(days=days - 1))
    profile = await session.get(Profile, user.id)
    lines = [f"Период: {'сегодня' if period == 'day' else 'последние 7 дней'} (по {today.isoformat()})."]
    if profile:
        t = daily_targets(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity, profile.goal)
        goal = {"lose": "снижение веса", "maintain": "поддержание", "gain": "набор массы"}[profile.goal]
        lines.append(f"Цель: {goal}. Норма в день: {t['calories']} ккал, Б {t['protein']} г, Ж {t['fat']} г, У {t['carbs']} г.")
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
        d = by_day.setdefault(l.logged_at.astimezone().date(), {"kcal": 0, "p": 0, "f": 0, "c": 0, "items": []})
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
    today = date.today()
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
        select(func.count(AiRequest.id)).where(AiRequest.user_id == user.id, AiRequest.created_at >= day_start(date.today()))
    )
    return {"enabled": bool(settings.anthropic_api_key), "used_today": used, "daily_limit": settings.ai_daily_limit}
