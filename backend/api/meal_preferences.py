from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from backend.api.deps import get_or_create_user, telegram_user
from backend.database.db import AsyncSession, get_session
from backend.database.models import MealPreferences

router = APIRouter(prefix="/api/meal-preferences")
Meal = Literal["breakfast", "lunch", "dinner"]
NEW_FIELDS = {"persons", "selected_meals", "shared_meals", "dietary_type", "liked_recipe_ids", "disliked_recipe_ids", "sex", "cooking_mode", "batch_days"}


class PreferencesIn(BaseModel):
    days: Literal[1, 3, 7, 14]
    goal: Literal["weight_loss", "maintenance", "mass_gain"]
    allergies: str = Field(default="", max_length=1000)
    liked: str = Field(default="", max_length=1000)
    disliked: str = Field(default="", max_length=1000)
    budget: int | None = Field(default=None, ge=0, le=10000000)
    current_spend: int | None = Field(default=None, ge=0, le=10000000)
    persons: int = Field(default=1, ge=1, le=10, strict=True)
    selected_meals: list[Meal] = Field(default_factory=lambda: ["breakfast", "lunch", "dinner"], max_length=3)
    shared_meals: list[Meal] = Field(default_factory=list, max_length=3)
    dietary_type: Literal["omnivore", "pescatarian", "vegetarian", "vegan"] = "omnivore"
    liked_recipe_ids: list[str] = Field(default_factory=list, max_length=1000)
    disliked_recipe_ids: list[str] = Field(default_factory=list, max_length=1000)
    sex: Literal["male", "female"] | None = None
    cooking_mode: Literal["daily", "batch", "varied"] = "daily"
    batch_days: Literal[2, 7] = 2

    @model_validator(mode="after")
    def validate_meals(self):
        if not set(self.shared_meals).issubset(self.selected_meals):
            raise ValueError("shared_meals must be a subset of selected_meals")
        return self


@router.get("")
async def get_preferences(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    row = await session.get(MealPreferences, user.id)
    if row is None:
        return None
    return PreferencesIn.model_validate(row, from_attributes=True).model_dump()


@router.put("")
async def save_preferences(body: PreferencesIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if not user.consent_at:
        raise HTTPException(403, "Для сохранения необходимо согласие на обработку данных")
    if body.allergies.strip() and not user.health_consent_at:
        raise HTTPException(403, "Для сохранения аллергий необходимо согласие на обработку данных о здоровье")
    row = await session.get(MealPreferences, user.id)
    data = body.model_dump()
    if row is not None:
        for key in NEW_FIELDS - body.model_fields_set:
            data[key] = getattr(row, key)
        try:
            PreferencesIn.model_validate(data)
        except ValidationError:
            raise HTTPException(422, "shared_meals must be a subset of selected_meals")
    if row is None:
        row = MealPreferences(user_id=user.id)
        session.add(row)
    for key, value in data.items():
        setattr(row, key, value)
    await session.commit()
    return data
