"""Water tracker and the last-7-days overview (week rings + streak)."""
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.deps import get_or_create_user, telegram_user
from backend.database.db import AsyncSession, get_session
from backend.database.models import FoodLog, Product, Profile, User, WaterIntake, WorkoutLog
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")
GLASS_ML = 250
MAX_ML = 6000


def local_start(d: date) -> datetime:
    return datetime.combine(d, time.min).astimezone()  # server-local day, same as the food diary


def water_goal(profile: Profile | None) -> int:
    """~33 ml per kg, rounded to a glass, within 1.5–4 l."""
    if profile is None:
        return 2000
    ml = round(profile.weight_kg * 33 / GLASS_ML) * GLASS_ML
    return min(4000, max(1500, ml))


@router.get("/water")
async def get_water(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    row = await session.scalar(select(WaterIntake).where(WaterIntake.user_id == user.id, WaterIntake.day == date.today()))
    return {"ml": row.ml if row else 0, "goal_ml": water_goal(await session.get(Profile, user.id))}


class WaterIn(BaseModel):
    delta_ml: int = Field(ge=-1000, le=1000)  # +250 a glass, -250 to undo


@router.post("/water")
async def add_water(body: WaterIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    today = date.today()
    # atomic upsert so two quick taps can't lose a glass; result clamped to 0..MAX_ML
    ml = await session.scalar(
        insert(WaterIntake)
        .values(user_id=user.id, day=today, ml=max(0, min(MAX_ML, body.delta_ml)))
        .on_conflict_do_update(
            index_elements=["user_id", "day"],
            set_={"ml": func.least(MAX_ML, func.greatest(0, WaterIntake.ml + body.delta_ml))},
        )
        .returning(WaterIntake.ml)
    )
    await session.commit()
    goal = water_goal(await session.get(Profile, user.id))
    xp = await award_xp(session, user.id, "water_goal", f"water:{today}") if ml >= goal else 0
    return {"ml": ml, "goal_ml": goal, "xp_awarded": xp}


async def active_days(session: AsyncSession, user: User, since: date) -> dict[date, dict]:
    """Per local day since `since`: kcal eaten, water ml, completed workouts."""
    start = local_start(since)
    days: dict[date, dict] = {}

    def bucket(d: date) -> dict:
        return days.setdefault(d, {"kcal": 0.0, "water_ml": 0, "workouts": 0})

    rows = await session.execute(
        select(FoodLog.logged_at, FoodLog.amount_g, Product.kcal)
        .join(Product, Product.id == FoodLog.product_id)
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= start)
    )
    for logged_at, grams, kcal in rows:
        bucket(logged_at.astimezone().date())["kcal"] += kcal * grams / 100
    for w in await session.scalars(select(WaterIntake).where(WaterIntake.user_id == user.id, WaterIntake.day >= since)):
        bucket(w.day)["water_ml"] = w.ml
    for done in await session.scalars(
        select(WorkoutLog.completed_at).where(WorkoutLog.user_id == user.id, WorkoutLog.completed_at >= start)
    ):
        bucket(done.astimezone().date())["workouts"] += 1
    return days


def streak(days: dict[date, dict], today: date) -> int:
    """Consecutive active days up to today; today may still be empty without breaking the streak."""
    active = {d for d, v in days.items() if v["kcal"] > 0 or v["water_ml"] > 0 or v["workouts"] > 0}
    d = today if today in active else today - timedelta(days=1)
    n = 0
    while d in active:
        n += 1
        d -= timedelta(days=1)
    return n


@router.get("/week")
async def week(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    today = date.today()
    # shortcut: streak looks back at most a year; extend if anyone gets there
    days = await active_days(session, user, today - timedelta(days=365))
    last7 = [today - timedelta(days=i) for i in range(6, -1, -1)]
    empty = {"kcal": 0.0, "water_ml": 0, "workouts": 0}
    return {
        "streak": streak(days, today),
        "days": [{"date": d.isoformat(), **{**empty, **days.get(d, {})}, "kcal": round(days.get(d, empty)["kcal"])} for d in last7],
    }
