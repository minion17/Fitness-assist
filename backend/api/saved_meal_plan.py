"""Durable snapshot of a user's generated meal plan and its inputs."""
import json
import math
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from backend.core import clock
from backend.api.deps import get_or_create_user, telegram_user
from backend.database.db import AsyncSession, get_session
from backend.database.models import Outbox, SavedMealPlan, User, Product, FoodLog

router = APIRouter(prefix="/api/meal-plan")
MAX_BYTES = 256 * 1024


class SavedPlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: dict
    plan: dict

    @field_validator("input")
    @classmethod
    def validate_input(cls, value):
        if not isinstance(value.get("allergies"), str):
            raise ValueError("input.allergies must be a string")
        return value

    @field_validator("plan")
    @classmethod
    def validate_plan(cls, value):
        for key in ("days", "shopping", "warnings"):
            if not isinstance(value.get(key), list):
                raise ValueError(f"plan.{key} must be a list")
        return value

    @model_validator(mode="after")
    def validate_size(self):
        try:
            encoded = json.dumps(self.model_dump(), ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (ValueError, UnicodeEncodeError, RecursionError):
            raise ValueError("invalid JSON")
        if len(encoded) > MAX_BYTES:
            raise ValueError("saved plan exceeds 256 KiB")
        return self


@router.get("")
async def get_saved_plan(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    row = await session.get(SavedMealPlan, user.id)
    return {k: v for k, v in row.payload.items() if k in ("input", "plan")} if row else None


@router.put("")
async def put_saved_plan(body: SavedPlanIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    # Serialize consent changes and plan writes on the same user row.
    user = await session.scalar(select(User).where(User.id == user.id).with_for_update().execution_options(populate_existing=True))
    if not user.consent_at:
        raise HTTPException(403, "Для сохранения необходимо согласие на обработку данных")
    if body.input["allergies"].strip() and not user.health_consent_at:
        raise HTTPException(403, "Для сохранения аллергий необходимо согласие на обработку данных о здоровье")
    payload = body.model_dump()
    previous = await session.get(SavedMealPlan, user.id)
    tracking = previous.payload.get("_tracking") if previous and previous.payload.get("plan") == payload["plan"] else None
    payload["_tracking"] = tracking or {"start": clock.today().isoformat(), "logs": {}}
    stmt = insert(SavedMealPlan).values(user_id=user.id, payload=payload)
    await session.execute(stmt.on_conflict_do_update(index_elements=[SavedMealPlan.user_id], set_={"payload": stmt.excluded.payload}))
    persons = body.input.get("persons")
    if isinstance(persons, int) and persons > 1 and body.plan["shopping"] and not await session.scalar(
            select(Outbox.id).where(Outbox.user_id == user.id, Outbox.kind == "shoptip").limit(1)):
        # once: a plan for a family — the list can go to the family chat, where whoever buys ticks it off
        session.add(Outbox(telegram_id=user.telegram_id, user_id=user.id, kind="shoptip", text=SHOP_TIP))
    await session.commit()
    return body.model_dump()


SHOP_TIP = ("🛒 Рацион на семью сохранён, список покупок готов.\n\n"
            "Отправь его в ваш семейный чат: кто купил — отмечает товар прямо в сообщении, и у всех список обновится. "
            "Кнопка «Отправить список в чат» — под списком продуктов в рационе.\n\n"
            "Если меня ещё нет в семейном чате — /group.")


class MealConfirmation(BaseModel):
    completed: bool


async def _current_plan(session: AsyncSession, user_id: int, lock: bool = False):
    query = select(SavedMealPlan).where(SavedMealPlan.user_id == user_id)
    if lock:
        query = query.with_for_update()
    row = await session.scalar(query)
    if not row:
        return None, None, None
    payload = dict(row.payload)
    tracking = dict(payload.get("_tracking") or {"start": clock.today().isoformat(), "logs": {}})
    try:
        index = (clock.today() - date.fromisoformat(tracking["start"])).days
        days = payload["plan"]["days"]
        day = days[index] if 0 <= index < len(days) else None
    except (KeyError, TypeError, ValueError, IndexError):
        raise HTTPException(422, "Не удалось прочитать сохранённый рацион")
    return row, tracking, day


@router.get("/today")
async def plan_today(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    row, tracking, day = await _current_plan(session, user.id, lock=True)
    if not row:
        return None
    if "_tracking" not in row.payload:
        row.payload = {**row.payload, "_tracking": tracking}
        await session.commit()
    if day is None:
        return {"finished": True, "meals": []}
    logs = tracking.get("logs", {}).get(clock.today().isoformat(), {})
    existing = set((await session.scalars(select(FoodLog.id).where(FoodLog.user_id == user.id, FoodLog.id.in_(list(logs.values()))))).all()) if logs else set()
    return {"finished": False, "day": day.get("day"), "meals": [{**meal, "completed": logs.get(str(i)) in existing} for i, meal in enumerate(day.get("meals", []))]}


@router.put("/today/{meal_index}")
async def confirm_plan_meal(meal_index: int, body: MealConfirmation, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    row, tracking, day = await _current_plan(session, user.id, lock=True)
    meals = day.get("meals", []) if isinstance(day, dict) else []
    if not row or meal_index < 0 or meal_index >= len(meals):
        raise HTTPException(404, "Блюдо в рационе на сегодня не найдено")
    meal = meals[meal_index]
    logs = dict(tracking.get("logs", {})); today = clock.today().isoformat(); day_logs = dict(logs.get(today, {})); key = str(meal_index)
    existing = await session.get(FoodLog, day_logs[key]) if key in day_logs else None
    if existing and existing.user_id != user.id:
        raise HTTPException(409, "Ошибка связи с дневником")
    if body.completed and not existing:
        try:
            name = meal["name"]
            slot = meal["meal"]
            grams = sum(float(item["grams"]) for item in meal["ingredients"])
            nutrition = {k: float(meal["nutrition"][k]) for k in ("kcal", "protein_g", "fat_g", "carbs_g")}
            if not isinstance(name, str) or not name.strip() or len(name) > 200 or slot not in ("breakfast", "lunch", "snack", "dinner") or not math.isfinite(grams) or not 0 < grams <= 5000 or any(not math.isfinite(v) or v < 0 or v > 10000 for v in nutrition.values()):
                raise ValueError()
        except (TypeError, KeyError, ValueError, OverflowError):
            raise HTTPException(422, "В блюде не хватает корректных данных для записи")
        product = Product(name=name, owner_user_id=user.id, category="Блюда из рациона", portion_g=grams, portion_name="порция", **{k: v * 100 / grams for k, v in nutrition.items()})
        session.add(product); await session.flush()
        entry = FoodLog(user_id=user.id, product_id=product.id, amount_g=grams, unit="порция", qty=1, meal_type=slot,
                        snack_slot="16:00" if slot == "snack" else None)
        session.add(entry); await session.flush(); day_logs[key] = entry.id
    elif not body.completed:
        if existing:
            await session.delete(existing)
        day_logs.pop(key, None)
    logs[today] = day_logs; tracking["logs"] = logs
    row.payload = {**row.payload, "_tracking": tracking}
    await session.commit()
    return {"completed": body.completed}


def plan_end_day(payload: dict) -> date | None:
    """The plan's last day, by when it was saved."""
    try:
        return date.fromisoformat(payload["_tracking"]["start"]) + timedelta(days=len(payload["plan"]["days"]) - 1)
    except (KeyError, TypeError, ValueError):
        return None
