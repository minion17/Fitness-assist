"""Real expenditure from the user's own data: what they ate vs how their weight moved. Plus a forecast and a plateau hint.

Energy balance: 1 kg of body weight ≈ 7700 kcal. Over a few weeks, average intake − 7700 × (kg lost per day) = expenditure.
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.stats import daily_series
from backend.core import clock
from backend.core.nutrition import MIN_CALORIES, OLD_GOALS, maintenance
from backend.database.db import AsyncSession, get_session
from backend.database.models import BodyMeasurement, Profile

router = APIRouter(prefix="/api")
KCAL_PER_KG = 7700
WINDOW = 28  # days looked at
NEED_DAYS = 10  # fully logged days
NEED_WEIGHINS = 3
FULL_DAY = 800  # kcal: a day with less was probably not logged completely
LOSS = ("weight_loss", "fat_loss")
GAIN = ("muscle_gain", "mass_gain")


def slope(points: list[tuple[float, float]]) -> float:
    """Least-squares trend: kg per day. Steadier than first-vs-last weigh-in (water, salt, timing)."""
    n = len(points)
    mx, my = sum(x for x, _ in points) / n, sum(y for _, y in points) / n
    den = sum((x - mx) ** 2 for x, _ in points)
    return sum((x - mx) * (y - my) for x, y in points) / den if den else 0.0


def estimate(intakes: list[float], weighins: list[tuple[int, float]]) -> dict | None:
    """intakes: kcal of fully logged days; weighins: (day number, kg). None until there's enough data."""
    if len(intakes) < NEED_DAYS or len(weighins) < NEED_WEIGHINS or weighins[-1][0] - weighins[0][0] < NEED_DAYS:
        return None
    per_day = slope(weighins)
    intake = sum(intakes) / len(intakes)
    tdee = intake - per_day * KCAL_PER_KG
    if not 1000 <= tdee <= 6000:  # gaps in the diary or a scale error; don't show nonsense
        return None
    return {"tdee": round(tdee / 10) * 10, "intake": round(intake), "kg_per_week": round(per_day * 7, 2)}


def suggestion(tdee: int, goal: str, sex: str) -> int:
    """A norm from the real expenditure: about −0.5 kg/week for loss, +0.25 kg/week for gain."""
    goal = OLD_GOALS.get(goal, goal)
    if goal in LOSS:
        return max(round((tdee - 550) / 10) * 10, MIN_CALORIES[sex])
    if goal in GAIN:
        return round((tdee + 300) / 10) * 10
    return tdee


@router.get("/insights/energy")
async def energy(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    today = clock.today()
    since = today - timedelta(days=WINDOW - 1)
    days = await daily_series(session, user, since, today - timedelta(days=1))  # today isn't finished yet
    intakes = [d["kcal"] for d in days if d["kcal"] >= FULL_DAY]
    weights = [(m.measured_on, m.weight_kg) for m in await session.scalars(
        select(BodyMeasurement).where(BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on >= since,
                                      BodyMeasurement.weight_kg.is_not(None)).order_by(BodyMeasurement.measured_on))]
    weighins = [((d - since).days, w) for d, w in weights]
    formula = maintenance(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity)
    est = estimate(intakes, weighins)
    out = {"ready": est is not None, "formula": formula, "days_logged": len(intakes), "weighins": len(weighins),
           "need_days": NEED_DAYS, "need_weighins": NEED_WEIGHINS, "target_weight_kg": profile.target_weight_kg,
           "kcal_override": profile.kcal_override, "goal": OLD_GOALS.get(profile.goal, profile.goal)}
    if not est:
        return out
    per_day = est["kg_per_week"] / 7
    current = weighins[-1][1]
    out.update(est, suggest=suggestion(est["tdee"], profile.goal, profile.sex), weight=current,
               in_30_days=round(current + per_day * 30, 1))
    target = profile.target_weight_kg
    if target and abs(per_day) >= 0.01 and (target - current) * per_day > 0:
        eta = (target - current) / per_day
        out["eta"] = (today + timedelta(days=round(eta))).isoformat() if eta <= 730 else None
    # Plateau: losing weight is the goal, yet the last two weeks are flat
    recent = [(d, w) for d, w in weighins if d >= WINDOW - 14]
    out["plateau"] = (out["goal"] in LOSS and len(recent) >= NEED_WEIGHINS and recent[-1][0] - recent[0][0] >= 7
                      and abs(slope(recent) * 14) < 0.25)
    return out


class Override(BaseModel):
    kcal: int | None = Field(default=None, ge=1000, le=6000)  # None: back to the formula


@router.post("/insights/energy/apply")
async def apply(body: Override, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    if body.kcal and body.kcal < MIN_CALORIES[profile.sex]:
        raise HTTPException(422, f"Не меньше {MIN_CALORIES[profile.sex]} ккал — ниже опасно для здоровья")
    profile.kcal_override = body.kcal
    await session.commit()
    return {"kcal_override": profile.kcal_override}


class TargetWeight(BaseModel):
    target_weight_kg: float | None = Field(default=None, ge=30, le=300)


@router.post("/profile/target-weight")
async def target_weight(body: TargetWeight, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    profile.target_weight_kg = body.target_weight_kg
    await session.commit()
    return {"target_weight_kg": profile.target_weight_kg}
