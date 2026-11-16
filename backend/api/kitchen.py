"""Own meal sets ("Мой завтрак" in one tap) and home recipes (a dish from catalog products, logged per plate)."""
from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.quick_food import local_start, product_out
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import FoodLog, MealSet, Product, Recipe, User, _search_text

router = APIRouter(prefix="/api")
MAX_SETS = 20
MEALS = ("breakfast", "lunch", "dinner", "snack")
MACROS = ("kcal", "protein_g", "fat_g", "carbs_g")


async def products(session: AsyncSession, user: User, ids: set[int]) -> dict[int, Product]:
    """The products the user may use: shared ones and their own."""
    rows = await session.scalars(select(Product).where(
        Product.id.in_(ids or [0]), Product.owner_user_id.is_(None) | (Product.owner_user_id == user.id)))
    return {p.id: p for p in rows}


def totals(pairs) -> dict:
    pairs = list(pairs)  # read once per macro
    """(product, grams) -> summed kcal and macros."""
    return {k: round(sum(getattr(p, k) * g / 100 for p, g in pairs), 1) for k in MACROS}


# ---- Meal sets ----

async def set_out(session: AsyncSession, user: User, s: MealSet, known: dict[int, Product] | None = None) -> dict:
    known = known or await products(session, user, {i["product_id"] for i in s.items})
    items = [{**i, "name": known[i["product_id"]].name} for i in s.items if i["product_id"] in known]
    return {"id": s.id, "name": s.name, "items": items,
            **totals((known[i["product_id"]], i["amount_g"]) for i in items)}


@router.get("/meal-sets")
async def list_sets(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    sets = list(await session.scalars(select(MealSet).where(MealSet.user_id == user.id).order_by(MealSet.id)))
    known = await products(session, user, {i["product_id"] for s in sets for i in s.items})
    return [await set_out(session, user, s, known) for s in sets]


class SetIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    from_day: str  # YYYY-MM-DD: the meal of that day becomes the set
    meal_type: str
    snack_slot: str | None = None

    @field_validator("name")
    @classmethod
    def strip(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("empty")
        return v.strip()


@router.post("/meal-sets")
async def create_set(body: SetIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Save a meal from the diary as a set."""
    from datetime import date, timedelta

    user = await get_or_create_user(tg, session)
    if await session.scalar(select(func.count()).where(MealSet.user_id == user.id)) >= MAX_SETS:
        raise HTTPException(409, f"Не больше {MAX_SETS} наборов — удалите ненужный")
    try:
        day = date.fromisoformat(body.from_day)
    except ValueError:
        raise HTTPException(422, "Неверная дата") from None
    start = local_start(day)
    q = select(FoodLog).where(FoodLog.user_id == user.id, FoodLog.meal_type == body.meal_type,
                              FoodLog.logged_at >= start, FoodLog.logged_at < start + timedelta(days=1))
    if body.meal_type == "snack" and body.snack_slot:
        q = q.where(FoodLog.snack_slot == body.snack_slot)
    logs = list(await session.scalars(q.order_by(FoodLog.logged_at)))
    if not logs:
        raise HTTPException(404, "В этом приёме пищи пока ничего нет")
    s = MealSet(user_id=user.id, name=body.name, items=[
        {"product_id": x.product_id, "amount_g": x.amount_g, "unit": x.unit, "qty": x.qty} for x in logs[:30]])
    session.add(s)
    await session.commit()
    return await set_out(session, user, s)


@router.delete("/meal-sets/{set_id}")
async def delete_set(set_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    s = await session.get(MealSet, set_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(404, "Набор не найден")
    await session.delete(s)
    await session.commit()
    return {"ok": True}


class LogSetIn(BaseModel):
    meal_type: str
    snack_slot: str | None = None
    day: date | None = None


@router.post("/meal-sets/{set_id}/log")
async def log_set(set_id: int, body: LogSetIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Everything of the set into a meal (today or a past day); XP as for any meal (once per meal per day)."""
    from backend.api.main import entry_time, meal_xp

    if body.meal_type not in MEALS:
        raise HTTPException(422, "Неизвестный приём пищи")
    user = await get_or_create_user(tg, session)
    s = await session.get(MealSet, set_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(404, "Набор не найден")
    known = await products(session, user, {i["product_id"] for i in s.items})
    items = [i for i in s.items if i["product_id"] in known]
    if not items:
        raise HTTPException(404, "Продуктов из набора больше нет")
    when, day = entry_time(body.day, body.meal_type, body.snack_slot)
    session.add_all(FoodLog(user_id=user.id, product_id=i["product_id"], amount_g=i["amount_g"], unit=i.get("unit"),
                            qty=i.get("qty"), meal_type=body.meal_type, **when) for i in items)
    await session.commit()
    xp = await meal_xp(session, user, day, body.meal_type)
    return {"logged": len(items), "xp_awarded": xp}


# ---- Recipes ----

class Ingredient(BaseModel):
    product_id: int
    grams: float = Field(gt=0, le=10000)


class RecipeIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    ingredients: list[Ingredient] = Field(min_length=1, max_length=40)
    cooked_g: float | None = Field(default=None, gt=0, le=30000)  # the pot weighed after cooking: water boiled off
    servings: int | None = Field(default=None, ge=1, le=50)


async def build(session: AsyncSession, user: User, body: RecipeIn) -> dict:
    """Per 100 g of the cooked dish, and the portion if it is split into servings."""
    known = await products(session, user, {i.product_id for i in body.ingredients})
    missing = [i.product_id for i in body.ingredients if i.product_id not in known]
    if missing:
        raise HTTPException(404, "Некоторых продуктов нет в каталоге")
    raw = sum(i.grams for i in body.ingredients)
    weight = body.cooked_g or raw
    if weight < raw * 0.2:
        raise HTTPException(422, "Готовое блюдо не может весить в 5 раз меньше продуктов — проверьте вес")
    t = totals((known[i.product_id], i.grams) for i in body.ingredients)
    per100 = {k: round(v * 100 / weight, 1) for k, v in t.items()}
    per100["kcal"] = round(per100["kcal"])
    portion = round(weight / body.servings) if body.servings else None
    return {"name": body.name.strip(), **per100, "category": "Мой рецепт",
            "portion_g": portion, "portion_name": "порция" if portion else None}


def recipe_out(p: Product, r: Recipe, known: dict[int, Product]) -> dict:
    ings = [{**i, **({"name": known[i["product_id"]].name, **{k: getattr(known[i["product_id"]], k) for k in MACROS}}
                     if i["product_id"] in known else {"name": "—", **dict.fromkeys(MACROS, 0)})} for i in r.ingredients]
    return {**product_out(p), "ingredients": ings, "cooked_g": r.cooked_g, "servings": r.servings,
            "total_g": r.cooked_g or sum(i["grams"] for i in r.ingredients)}


@router.get("/recipes")
async def list_recipes(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    rows = (await session.execute(select(Product, Recipe).join(Recipe, Recipe.product_id == Product.id)
                                  .where(Recipe.user_id == user.id).order_by(Product.name))).all()
    known = await products(session, user, {i["product_id"] for _, r in rows for i in r.ingredients})
    return [recipe_out(p, r, known) for p, r in rows]


@router.post("/recipes")
async def create_recipe(body: RecipeIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    values = await build(session, user, body)
    p = Product(owner_user_id=user.id, **values)
    session.add(p)
    await session.flush()
    r = Recipe(product_id=p.id, user_id=user.id, ingredients=[i.model_dump() for i in body.ingredients],
               cooked_g=body.cooked_g, servings=body.servings)
    session.add(r)
    await session.commit()
    return recipe_out(p, r, await products(session, user, {i.product_id for i in body.ingredients}))


async def own_recipe(session: AsyncSession, user: User, product_id: int) -> tuple[Product, Recipe]:
    r = await session.get(Recipe, product_id)
    if r is None or r.user_id != user.id:
        raise HTTPException(404, "Рецепт не найден")
    return await session.get(Product, product_id), r


@router.put("/recipes/{product_id}")
async def update_recipe(product_id: int, body: RecipeIn, tg: dict = Depends(telegram_user),
                        session: AsyncSession = Depends(get_session)):
    """shortcut: the dish is edited in place, so plates logged before show the new numbers too; make a copy if that matters."""
    user = await get_or_create_user(tg, session)
    p, r = await own_recipe(session, user, product_id)
    for k, v in (await build(session, user, body)).items():
        setattr(p, k, v)
    p.search_text = _search_text({"name": p.name, "brand": p.brand})  # the column default only runs on insert
    r.ingredients, r.cooked_g, r.servings = [i.model_dump() for i in body.ingredients], body.cooked_g, body.servings
    await session.commit()
    return recipe_out(p, r, await products(session, user, {i.product_id for i in body.ingredients}))


@router.delete("/recipes/{product_id}")
async def delete_recipe(product_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """The dish goes; if it is already in the diary, it stays there as a plain product of the user."""
    user = await get_or_create_user(tg, session)
    p, r = await own_recipe(session, user, product_id)
    await session.delete(r)
    if not await session.scalar(select(FoodLog.id).where(FoodLog.product_id == p.id).limit(1)):
        await session.delete(p)
    await session.commit()
    return {"ok": True}


# ---- "What to eat": the user's own past meals that fit what is left of today's norm ----

def score(c: dict, kcal_left: float, protein_left: float) -> float:
    """Lower is better: close to the calories left, and covering the protein still missing."""
    miss = max(0.0, protein_left - c["protein_g"]) / max(protein_left, 1)
    return abs(kcal_left - c["kcal"]) / max(kcal_left, 1) + 0.8 * miss


@router.get("/suggest/meal")
async def suggest_meal(meal_type: str = "dinner", tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    from datetime import timedelta

    from backend.api.stats import targets
    from backend.database.models import Profile

    user = await get_or_create_user(tg, session)
    t = targets(await session.get(Profile, user.id))
    if not t:
        return {"options": []}
    today = clock.today()
    since = local_start(today - timedelta(days=30))
    logs = list(await session.execute(
        select(FoodLog, Product).join(Product, Product.id == FoodLog.product_id)
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= since).order_by(FoodLog.logged_at)))
    eaten = {k: 0.0 for k in MACROS}
    meals: dict[tuple, list] = {}
    for log, p in logs:
        day = log.logged_at.astimezone(clock.tz()).date()
        if day == today:
            for k in MACROS:
                eaten[k] += getattr(p, k) * log.amount_g / 100
        elif log.meal_type in ("lunch", "dinner"):
            meals.setdefault((day, log.meal_type), []).append((log, p))
    kcal_left, protein_left = t["calories"] - eaten["kcal"], t["protein"] - eaten["protein_g"]
    out = {"kcal_left": round(kcal_left), "protein_left": round(max(protein_left, 0)), "options": []}
    if kcal_left < 200:
        return out
    candidates, seen = [], set()
    for items in reversed(list(meals.values())):  # newest first, so a tie goes to what they ate lately
        key = frozenset(p.id for _, p in items)
        if key in seen:
            continue
        seen.add(key)
        candidates.append({
            "title": ", ".join(p.name for _, p in items[:3]) + ("…" if len(items) > 3 else ""),
            "items": [{"product_id": p.id, "name": p.name, "amount_g": log.amount_g, "unit": log.unit, "qty": log.qty} for log, p in items],
            **totals((p, log.amount_g) for log, p in items)})
    for s in await session.scalars(select(MealSet).where(MealSet.user_id == user.id)):
        candidates.append({**(c := await set_out(session, user, s)), "title": f"☆ {c['name']}"})
    fit = [c for c in candidates if 0.35 * kcal_left <= c["kcal"] <= 1.1 * kcal_left and c["items"]]
    out["options"] = [{k: c[k] for k in ("title", "items", *MACROS)} for c in sorted(fit, key=lambda c: score(c, kcal_left, protein_left))[:3]]
    return out


class BatchIn(BaseModel):
    meal_type: str
    snack_slot: str | None = None
    items: list[dict] = Field(min_length=1, max_length=30)  # [{"product_id", "amount_g", "unit"?, "qty"?}]
    day: date | None = None


@router.post("/food-logs/batch")
async def log_batch(body: BatchIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Several products into one meal at once (a suggested meal)."""
    from backend.api.main import entry_time, meal_xp

    if body.meal_type not in MEALS:
        raise HTTPException(422, "Неизвестный приём пищи")
    user = await get_or_create_user(tg, session)
    try:
        items = [(int(i["product_id"]), float(i["amount_g"]), i.get("unit"), i.get("qty")) for i in body.items]
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "Неверные продукты") from None
    if any(not 0 < g <= 5000 for _, g, _, _ in items):
        raise HTTPException(422, "Граммы: от 1 до 5000")
    known = await products(session, user, {pid for pid, *_ in items})
    if any(pid not in known for pid, *_ in items):
        raise HTTPException(404, "Продукт не найден")
    when, day = entry_time(body.day, body.meal_type, body.snack_slot)
    session.add_all(FoodLog(user_id=user.id, product_id=pid, amount_g=g, unit=str(u)[:12] if u else None,
                            qty=float(q) if q else None, meal_type=body.meal_type, **when) for pid, g, u, q in items)
    await session.commit()
    xp = await meal_xp(session, user, day, body.meal_type)
    return {"logged": len(items), "xp_awarded": xp}
