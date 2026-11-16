"""Durable snapshot of a user's generated meal plan and its inputs."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from backend.api.deps import get_or_create_user, telegram_user
from backend.database.db import AsyncSession, get_session
from backend.database.models import SavedMealPlan, User

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
    return row.payload if row else None


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
    stmt = insert(SavedMealPlan).values(user_id=user.id, payload=payload)
    await session.execute(stmt.on_conflict_do_update(index_elements=[SavedMealPlan.user_id], set_={"payload": stmt.excluded.payload}))
    await session.commit()
    return payload
