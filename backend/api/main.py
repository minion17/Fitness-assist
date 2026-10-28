from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import selectinload

from backend.core.config import settings
from backend.core.gamification import level_progress
from backend.core.nutrition import daily_targets
from backend.core.telegram_auth import InitDataError, validate_init_data
from backend.database.db import AsyncSession, get_session, init_db
from backend.database.models import (
    Exercise,
    FoodLog,
    Product,
    Profile,
    Program,
    ProgramDay,
    ProgramExercise,
    User,
    WorkoutLog,
    WorkoutSet,
)
from backend.database.rewards import award_xp


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Fitness Assistant API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


def telegram_user(authorization: str = Header(default="")) -> dict:
    """Mini App sends `Authorization: tma <initData>`."""
    scheme, _, init_data = authorization.partition(" ")
    if scheme.lower() != "tma":
        raise HTTPException(401, "missing Telegram initData")
    try:
        data = validate_init_data(init_data, settings.bot_token, settings.init_data_max_age)
    except InitDataError as e:
        raise HTTPException(401, f"invalid initData: {e}")
    if "user" not in data:
        raise HTTPException(401, "no user in initData")
    return data["user"]


@app.get("/health")
async def health(session: AsyncSession = Depends(get_session)):
    try:
        await session.execute(text("SELECT 1"))
        db = "ok"
    except Exception as e:  # report, don't crash the probe
        db = f"error: {type(e).__name__}"
    return {"status": "ok" if db == "ok" else "degraded", "database": db}


async def get_or_create_user(tg: dict, session: AsyncSession) -> User:
    user = await session.scalar(select(User).where(User.telegram_id == tg["id"]))
    if user is None:
        user = User(telegram_id=tg["id"])
        session.add(user)
    user.username = tg.get("username")
    user.first_name = tg.get("first_name")
    user.language_code = tg.get("language_code")
    await session.commit()
    await session.refresh(user)
    return user


def profile_out(profile: Profile | None) -> dict | None:
    if profile is None:
        return None
    data = ProfileIn.model_validate(profile, from_attributes=True).model_dump()
    return {**data, "targets": daily_targets(**data)}


@app.post("/api/auth")
async def auth(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Register or refresh the user from verified initData."""
    user = await get_or_create_user(tg, session)
    return {
        "id": user.id,
        "telegram_id": user.telegram_id,
        "first_name": user.first_name,
        "username": user.username,
        "progress": level_progress(user.xp),
        "profile": profile_out(await session.get(Profile, user.id)),
    }


class ProfileIn(BaseModel):
    sex: Literal["male", "female"]
    birth_year: int = Field(ge=date.today().year - 100, le=date.today().year - 12)
    height_cm: int = Field(ge=120, le=230)
    weight_kg: float = Field(ge=30, le=300)
    activity: Literal["low", "light", "moderate", "high", "very_high"]
    goal: Literal["lose", "maintain", "gain"]


@app.get("/api/profile")
async def get_profile(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    return profile_out(await session.get(Profile, user.id))


@app.put("/api/profile")
async def save_profile(
    body: ProfileIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id) or Profile(user_id=user.id)
    for k, v in body.model_dump().items():
        setattr(profile, k, v)
    session.add(profile)
    await session.commit()
    return profile_out(profile)


# ---- Reference data: products, exercises, programs ----


@app.get("/api/products/search")
async def search_products(q: str = Query(min_length=2, max_length=100), session: AsyncSession = Depends(get_session)):
    q = q.lower().replace("ё", "е").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = await session.scalars(
        select(Product)
        .where(Product.search_text.like(f"%{q}%", escape="\\"))
        .order_by(Product.name)
        .limit(20)
    )
    return [product_out(p) for p in rows]


def product_out(p: Product) -> dict:
    return {
        "id": p.id, "name": p.name, "brand": p.brand, "category": p.category,
        "kcal": p.kcal, "protein_g": p.protein_g, "fat_g": p.fat_g, "carbs_g": p.carbs_g,
    }


@app.get("/api/exercises")
async def list_exercises(session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(Exercise).order_by(Exercise.name))
    return [
        {
            "id": e.id, "name": e.name, "muscle_groups": e.muscle_groups, "equipment": e.equipment,
            "difficulty": e.difficulty, "description": e.description, "is_bodyweight": e.is_bodyweight,
        }
        for e in rows
    ]


@app.get("/api/programs")
async def list_programs(session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(Program)
        .options(selectinload(Program.days).selectinload(ProgramDay.items).selectinload(ProgramExercise.exercise))
        .order_by(Program.id)
    )
    return [
        {
            "id": p.id, "name": p.name, "goal": p.goal, "level": p.level,
            "days_per_week": p.days_per_week, "description": p.description,
            "days": [
                {
                    "id": d.id, "day_name": d.day_name, "day_order": d.day_order,
                    "exercises": [
                        {
                            "exercise_id": i.exercise_id, "name": i.exercise.name, "sets": i.sets,
                            "reps": i.reps, "rest_seconds": i.rest_seconds, "notes": i.notes,
                        }
                        for i in d.items
                    ],
                }
                for d in p.days
            ],
        }
        for p in rows
    ]


# ---- Food diary ----


class FoodLogIn(BaseModel):
    product_id: int
    amount_g: float = Field(gt=0, le=5000)
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]


def food_log_out(log: FoodLog) -> dict:
    k = log.amount_g / 100  # product nutrition is per 100 g
    p = log.product
    return {
        "id": log.id, "meal_type": log.meal_type, "amount_g": log.amount_g, "logged_at": log.logged_at.isoformat(),
        "product": product_out(p),
        "kcal": round(p.kcal * k), "protein_g": round(p.protein_g * k, 1),
        "fat_g": round(p.fat_g * k, 1), "carbs_g": round(p.carbs_g * k, 1),
    }


@app.post("/api/food-logs")
async def add_food_log(body: FoodLogIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if not await session.get(Product, body.product_id):
        raise HTTPException(404, "Продукт не найден")
    log = FoodLog(user_id=user.id, **body.model_dump())
    session.add(log)
    await session.commit()
    log = await session.scalar(select(FoodLog).options(selectinload(FoodLog.product)).where(FoodLog.id == log.id))
    # One reward per meal type per day, so XP can't be farmed by logging many items.
    xp = await award_xp(session, user.id, "meal_logged", f"meal:{log.logged_at.astimezone().date()}:{log.meal_type}")
    return {**food_log_out(log), "xp_awarded": xp}


@app.get("/api/food-logs")
async def get_food_logs(
    day: date | None = None, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    """Entries and totals for one day (default: today)."""
    user = await get_or_create_user(tg, session)
    day = day or date.today()
    # Day bounds computed in Python (server's local time), not func.date(): the DB may run in UTC.
    # shortcut: "day" is the server's timezone, not the user's; store user tz when users span zones
    start = datetime.combine(day, time.min).astimezone()
    rows = await session.scalars(
        select(FoodLog)
        .options(selectinload(FoodLog.product))
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= start, FoodLog.logged_at < start + timedelta(days=1))
        .order_by(FoodLog.logged_at)
    )
    items = [food_log_out(log) for log in rows]
    totals = {k: round(sum(i[k] for i in items), 1) for k in ("kcal", "protein_g", "fat_g", "carbs_g")}
    return {"date": day.isoformat(), "items": items, "totals": totals}


# ---- Workout journal ----


class WorkoutLogIn(BaseModel):
    program_day_id: int | None = None
    title: str = Field(default="Тренировка", min_length=1, max_length=200)


class WorkoutSetIn(BaseModel):
    exercise_id: int
    set_number: int = Field(ge=1, le=50)
    reps: int = Field(gt=0, le=500)
    weight_kg: float = Field(default=0, ge=0, le=500)


async def own_workout(log_id: int, user: User, session: AsyncSession) -> WorkoutLog:
    w = await session.get(WorkoutLog, log_id)
    if w is None or w.user_id != user.id:
        raise HTTPException(404, "Тренировка не найдена")
    return w


@app.post("/api/workout-logs")
async def start_workout(body: WorkoutLogIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if body.program_day_id is not None and not await session.get(ProgramDay, body.program_day_id):
        raise HTTPException(404, "День программы не найден")
    w = WorkoutLog(user_id=user.id, **body.model_dump())
    session.add(w)
    await session.commit()
    return {"id": w.id, "title": w.title}


@app.post("/api/workout-logs/{log_id}/sets")
async def log_set(
    log_id: int, body: WorkoutSetIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    user = await get_or_create_user(tg, session)
    w = await own_workout(log_id, user, session)
    if w.completed_at is not None:
        raise HTTPException(409, "Тренировка уже завершена")
    if not await session.get(Exercise, body.exercise_id):
        raise HTTPException(404, "Упражнение не найдено")
    ws = WorkoutSet(workout_log_id=w.id, **body.model_dump())
    session.add(ws)
    await session.commit()
    return {"id": ws.id}


@app.post("/api/workout-logs/{log_id}/complete")
async def complete_workout(log_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    w = await own_workout(log_id, user, session)
    if not await session.scalar(select(WorkoutSet.id).where(WorkoutSet.workout_log_id == w.id).limit(1)):
        raise HTTPException(400, "Добавьте хотя бы один подход")  # no XP for empty workouts
    if w.completed_at is None:
        w.completed_at = func.now()
        await session.commit()
    xp = await award_xp(session, user.id, "workout_completed", f"workout:{w.id}")
    return {"ok": True, "xp_awarded": xp}


@app.get("/api/workout-logs")
async def list_workout_logs(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    rows = await session.scalars(
        select(WorkoutLog)
        .options(selectinload(WorkoutLog.sets))
        .where(WorkoutLog.user_id == user.id)
        .order_by(WorkoutLog.started_at.desc())
        .limit(50)
    )
    return [
        {
            "id": w.id, "title": w.title, "program_day_id": w.program_day_id,
            "started_at": w.started_at.isoformat(),
            "completed_at": w.completed_at.isoformat() if w.completed_at else None,
            "sets": len(w.sets),
        }
        for w in rows
    ]


# Serve the built Mini App from the same origin, so one HTTPS tunnel covers UI + API.
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="webapp")
