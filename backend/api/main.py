from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.orm import selectinload

from backend.core.config import settings
from backend.core.gamification import level_progress
from backend.core.nutrition import daily_targets
from backend.core.programs import recommend
from backend.api.ai import router as ai_router
from backend.api.daily import router as daily_router
from backend.api.quick_food import product_out, router as quick_food_router
from backend.api.stats import router as stats_router
from backend.api.deps import get_or_create_user, optional_telegram_user, telegram_user
from backend.database.db import AsyncSession, get_session, init_db
from backend.database.models import (
    BodyMeasurement,
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


app = FastAPI(title="Setly API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health(session: AsyncSession = Depends(get_session)):
    try:
        await session.execute(text("SELECT 1"))
        db = "ok"
    except Exception as e:  # report, don't crash the probe
        db = f"error: {type(e).__name__}"
    return {"status": "ok" if db == "ok" else "degraded", "database": db}


def profile_out(profile: Profile | None) -> dict | None:
    if profile is None:
        return None
    data = ProfileIn.model_validate(profile, from_attributes=True).model_dump()
    return {**data, "targets": daily_targets(**{k: data[k] for k in BASE_FIELDS})}


async def recommended_program(session: AsyncSession, profile: Profile | None) -> dict | None:
    if profile is None:
        return None
    programs = await session.scalars(
        select(Program).where(Program.owner_user_id.is_(None)).options(selectinload(Program.days).selectinload(ProgramDay.items).selectinload(ProgramExercise.exercise))
    )
    return recommend(programs.all(), profile)


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
        "profile": profile_out(profile := await session.get(Profile, user.id)),
        "recommended_program": await recommended_program(session, profile),
        "settings": settings_out(user),
    }


def settings_out(user: User) -> dict:
    return {"theme": user.theme, "accent": user.accent, "program_id": user.program_id}


class SettingsIn(BaseModel):
    """Partial update: only the fields sent are changed."""
    theme: Literal["auto", "dark", "light", "green"] | None = None
    accent: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    program_id: int | None = None


@app.put("/api/settings")
async def save_settings(body: SettingsIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    changes = body.model_dump(exclude_unset=True)
    if changes.get("program_id") is not None:
        selected = await session.get(Program, changes["program_id"])
        if selected is None or selected.owner_user_id not in (None, user.id):
            raise HTTPException(404, "Программа не найдена")
    for k, v in changes.items():
        setattr(user, k, v)
    await session.commit()
    return settings_out(user)


Equipment = Literal["bodyweight", "dumbbells", "barbell", "bench", "pullup_bar", "cable_machine", "machine", "treadmill", "exercise_bike"]
Allergy = Literal["dairy", "eggs", "gluten", "nuts", "fish"]
BASE_FIELDS = ("sex", "birth_year", "height_cm", "weight_kg", "activity", "goal")


class ProfileIn(BaseModel):
    sex: Literal["male", "female"]
    birth_year: int = Field(ge=date.today().year - 100, le=date.today().year - 12)
    height_cm: int = Field(ge=120, le=230)
    weight_kg: float = Field(ge=30, le=300)
    activity: Literal["low", "light", "moderate", "high", "very_high"]
    goal: Literal["weight_loss", "fat_loss", "maintenance", "muscle_gain", "mass_gain"]
    # extended questionnaire; optional so older clients/profiles keep working
    experience: Literal["beginner", "intermediate", "advanced"] | None = None
    equipment: list[Equipment] | None = Field(default=None, max_length=9)
    sessions_per_week: int | None = Field(default=None, ge=1, le=7)
    session_minutes: Literal[20, 30, 45, 60, 90] | None = None
    allergies: list[Allergy] | None = Field(default=None, max_length=5)
    meals_per_day: Literal[3, 4, 5] | None = None
    sleep_hours: float | None = Field(default=None, ge=3, le=12)
    stress: Literal["low", "moderate", "high"] | None = None
    injury: Literal["knees", "back", "shoulders", "other"] | None = None


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
async def search_products(
    q: str = Query(min_length=2, max_length=100),
    tg: dict | None = Depends(optional_telegram_user),
    session: AsyncSession = Depends(get_session),
):
    """Shared catalog plus the caller's own custom products."""
    owner = Product.owner_user_id.is_(None)
    if tg:
        user = await get_or_create_user(tg, session)
        owner = owner | (Product.owner_user_id == user.id)
    q = q.lower().replace("ё", "е").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = await session.scalars(
        select(Product)
        .where(owner, Product.search_text.like(f"%{q}%", escape="\\"))
        # names starting with the query first, then shorter (more generic) names
        .order_by(Product.search_text.like(f"{q}%", escape="\\").desc(), func.length(Product.name), Product.name)
        .limit(20)
    )
    return [product_out(p) for p in rows]


@app.get("/api/exercises")
async def list_exercises(tg: dict | None = Depends(optional_telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session) if tg else None
    access = Exercise.owner_user_id.is_(None)
    if user:
        access = access | (Exercise.owner_user_id == user.id)
    rows = await session.scalars(select(Exercise).where(access).order_by(Exercise.name))
    return [
        {
            "id": e.id, "name": e.name, "muscle_groups": e.muscle_groups, "equipment": e.equipment,
            "difficulty": e.difficulty, "description": e.description, "is_bodyweight": e.is_bodyweight,
        }
        for e in rows
    ]


class CustomExerciseIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@app.post("/api/exercises")
async def create_custom_exercise(body: CustomExerciseIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Введите название упражнения")
    exercise = await session.scalar(select(Exercise).where(Exercise.name == name, Exercise.owner_user_id == user.id))
    if exercise is None:
        exercise = Exercise(name=name, owner_user_id=user.id, muscle_groups=[], equipment=[], difficulty="beginner", is_bodyweight=False)
        session.add(exercise)
        await session.commit()
        await session.refresh(exercise)
    return {"id": exercise.id, "name": exercise.name}


@app.get("/api/programs")
async def list_programs(tg: dict | None = Depends(optional_telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session) if tg else None
    access = Program.owner_user_id.is_(None)
    if user:
        access = access | (Program.owner_user_id == user.id)
    rows = await session.scalars(
        select(Program)
        .where(access)
        .options(selectinload(Program.days).selectinload(ProgramDay.items).selectinload(ProgramExercise.exercise))
        .order_by(Program.id)
    )
    return [
        {
            "id": p.id, "name": p.name, "goal": p.goal, "level": p.level, "is_personal": p.owner_user_id is not None,
            "days_per_week": p.days_per_week, "description": p.description,
            "days": [
                {
                    "id": d.id, "day_name": d.day_name, "day_order": d.day_order,
                    "exercises": [
                        {
                            "exercise_id": i.exercise_id, "name": i.exercise.name, "sets": i.sets,
                            "reps": i.reps, "rest_seconds": i.rest_seconds, "notes": i.notes, "unit": i.unit, "superset": i.superset, "planned_weights": i.planned_weights,
                        }
                        for i in d.items
                    ],
                }
                for d in p.days
            ],
        }
        for p in rows
    ]


class PersonalExerciseIn(BaseModel):
    exercise_id: int
    sets: int = Field(ge=1, le=50)
    reps: str = Field(min_length=1, max_length=30)
    rest_seconds: int = Field(ge=0, le=3600)
    unit: Literal["reps", "seconds"] = "reps"
    superset: int | None = Field(default=None, ge=1, le=50)
    planned_weights: list[float | None] | None = Field(default=None, max_length=50)


class PersonalDayIn(BaseModel):
    id: int | None = None
    name: str = Field(min_length=1, max_length=100)
    exercises: list[PersonalExerciseIn] = Field(min_length=1, max_length=50)


class PersonalProgramIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    days: list[PersonalDayIn] = Field(min_length=1, max_length=14)


async def save_personal_program(body: PersonalProgramIn, user: User, session: AsyncSession, tg: dict, program: Program | None = None):
    if any(e.planned_weights is not None and (len(e.planned_weights) != e.sets or any(w is not None and not 0 <= w <= 500 for w in e.planned_weights)) for d in body.days for e in d.exercises):
        raise HTTPException(422, "Проверьте веса подходов")
    ids = {item.exercise_id for day in body.days for item in day.exercises}
    existing = set((await session.scalars(select(Exercise.id).where(Exercise.id.in_(ids), (Exercise.owner_user_id.is_(None)) | (Exercise.owner_user_id == user.id)))).all())
    if ids != existing or not body.name.strip() or any(not d.name.strip() or any(not e.reps.strip() for e in d.exercises) for d in body.days):
        raise HTTPException(422, "Проверьте название, упражнения и повторения")
    if program is None:
        program = Program(name=body.name.strip(), owner_user_id=user.id, goal="Своя программа", level="beginner", days_per_week=len(body.days), days=[])
        session.add(program)
    program.name = body.name.strip()
    program.days_per_week = len(body.days)
    existing_days = {day.id: day for day in program.days}
    requested_ids = [day.id for day in body.days if day.id is not None]
    if len(requested_ids) != len(set(requested_ids)) or any(day_id not in existing_days for day_id in requested_ids):
        raise HTTPException(422, "Тренировка не найдена в программе")
    for index, day_data in enumerate(body.days):
        if day_data.id is not None:
            day = existing_days[day_data.id]
            day.items.clear()
            await session.flush()
        else:
            day = ProgramDay(day_name=day_data.name.strip(), day_order=index + 1, items=[])
            program.days.append(day)
        day.day_name, day.day_order = day_data.name.strip(), index + 1
        for pos, item in enumerate(day_data.exercises, 1):
            day.items.append(ProgramExercise(exercise_id=item.exercise_id, sets=item.sets, reps=item.reps.strip(), rest_seconds=item.rest_seconds, position=pos, unit=item.unit, superset=item.superset, planned_weights=item.planned_weights))
    for day in existing_days.values():
        if day.id not in requested_ids:
            program.days.remove(day)
    await session.commit()
    rows = await list_programs(tg=tg, session=session)
    return next(p for p in rows if p["id"] == program.id)


@app.post("/api/programs")
async def create_personal_program(body: PersonalProgramIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    return await save_personal_program(body, await get_or_create_user(tg, session), session, tg)


@app.put("/api/programs/{program_id}")
async def edit_personal_program(program_id: int, body: PersonalProgramIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    program = await session.scalar(select(Program).where(Program.id == program_id, Program.owner_user_id == user.id).options(selectinload(Program.days).selectinload(ProgramDay.items)))
    if program is None:
        raise HTTPException(404, "Программа не найдена")
    return await save_personal_program(body, user, session, tg, program)


# ---- Food diary ----


class FoodLogIn(BaseModel):
    product_id: int
    amount_g: float = Field(gt=0, le=5000)
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]
    snack_slot: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")  # which snack of the day


def snack_slot(meal_type: str, slot: str | None) -> str | None:
    """Snacks without an explicit slot start a new one at the current time; other meals have none."""
    return (slot or datetime.now().strftime("%H:%M")) if meal_type == "snack" else None


def food_log_out(log: FoodLog) -> dict:
    k = log.amount_g / 100  # product nutrition is per 100 g
    p = log.product
    return {
        "id": log.id, "meal_type": log.meal_type, "snack_slot": log.snack_slot, "amount_g": log.amount_g, "logged_at": log.logged_at.isoformat(),
        "product": product_out(p),
        "kcal": round(p.kcal * k), "protein_g": round(p.protein_g * k, 1),
        "fat_g": round(p.fat_g * k, 1), "carbs_g": round(p.carbs_g * k, 1),
    }


@app.post("/api/food-logs")
async def add_food_log(body: FoodLogIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    product = await session.get(Product, body.product_id)
    if product is None or product.owner_user_id not in (None, user.id):
        raise HTTPException(404, "Продукт не найден")
    log = FoodLog(user_id=user.id, **{**body.model_dump(), "snack_slot": snack_slot(body.meal_type, body.snack_slot)})
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


@app.delete("/api/food-logs/{log_id}")
async def delete_food_log(log_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    # XP already granted for the meal is kept: it's per meal type per day, not per entry.
    user = await get_or_create_user(tg, session)
    log = await session.get(FoodLog, log_id)
    if log is None or log.user_id != user.id:
        raise HTTPException(404, "Запись не найдена")
    await session.delete(log)
    await session.commit()
    return {"ok": True}


# ---- Body measurements ----


class MeasurementIn(BaseModel):
    measured_on: date | None = None  # default: today
    weight_kg: float | None = Field(default=None, ge=30, le=300)
    waist_cm: float | None = Field(default=None, ge=30, le=250)
    chest_cm: float | None = Field(default=None, ge=40, le=250)
    hips_cm: float | None = Field(default=None, ge=40, le=250)
    body_fat_pct: float | None = Field(default=None, ge=2, le=70)


MEASURE_FIELDS = ("weight_kg", "waist_cm", "chest_cm", "hips_cm", "body_fat_pct")


def measurement_out(m: BodyMeasurement) -> dict:
    return {"id": m.id, "measured_on": m.measured_on.isoformat(), **{k: getattr(m, k) for k in MEASURE_FIELDS}}


@app.put("/api/measurements")
async def save_measurement(
    body: MeasurementIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    if all(getattr(body, k) is None for k in MEASURE_FIELDS):
        raise HTTPException(422, "Укажите хотя бы одно значение")
    day = body.measured_on or date.today()
    if day > date.today() + timedelta(days=1):  # +1: client may be ahead of the server's timezone
        raise HTTPException(422, "Дата в будущем")
    user = await get_or_create_user(tg, session)
    m = await session.scalar(
        select(BodyMeasurement).where(BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on == day)
    ) or BodyMeasurement(user_id=user.id, measured_on=day)
    for k in MEASURE_FIELDS:
        setattr(m, k, getattr(body, k))
    session.add(m)
    # Latest weight drives the daily targets, so keep the questionnaire in sync.
    if body.weight_kg is not None:
        latest = await session.scalar(
            select(func.max(BodyMeasurement.measured_on)).where(
                BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None)
            )
        )
        profile = await session.get(Profile, user.id)
        if profile and (latest is None or day >= latest):
            profile.weight_kg = body.weight_kg
    await session.commit()
    xp = await award_xp(session, user.id, "body_measurement", f"measure:{day}")
    return {**measurement_out(m), "xp_awarded": xp}


@app.get("/api/measurements")
async def list_measurements(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Newest first, last 365 entries."""
    user = await get_or_create_user(tg, session)
    rows = await session.scalars(
        select(BodyMeasurement)
        .where(BodyMeasurement.user_id == user.id)
        .order_by(BodyMeasurement.measured_on.desc())
        .limit(365)
    )
    return [measurement_out(m) for m in rows]


@app.delete("/api/measurements/{measurement_id}")
async def delete_measurement(
    measurement_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    user = await get_or_create_user(tg, session)
    m = await session.get(BodyMeasurement, measurement_id)
    if m is None or m.user_id != user.id:
        raise HTTPException(404, "Замер не найден")
    await session.delete(m)
    await session.commit()
    return {"ok": True}


# ---- Workout journal ----


class WorkoutLogIn(BaseModel):
    program_day_id: int | None = None
    title: str = Field(default="Тренировка", min_length=1, max_length=200)


class WorkoutSetIn(BaseModel):
    exercise_id: int
    set_number: int = Field(ge=1, le=50)
    reps: int | None = Field(default=None, gt=0, le=500)
    duration_seconds: int | None = Field(default=None, gt=0, le=86400)
    weight_kg: float = Field(default=0, ge=0, le=500)


async def own_workout(log_id: int, user: User, session: AsyncSession) -> WorkoutLog:
    w = await session.get(WorkoutLog, log_id)
    if w is None or w.user_id != user.id:
        raise HTTPException(404, "Тренировка не найдена")
    return w


@app.post("/api/workout-logs")
async def start_workout(body: WorkoutLogIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if body.program_day_id is not None:
        program = await session.scalar(select(Program).join(ProgramDay, ProgramDay.program_id == Program.id).where(ProgramDay.id == body.program_day_id))
        if program is None or program.owner_user_id not in (None, user.id):
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
    exercise = await session.get(Exercise, body.exercise_id)
    if exercise is None or exercise.owner_user_id not in (None, user.id):
        raise HTTPException(404, "Упражнение не найдено")
    if (body.reps is None) == (body.duration_seconds is None):
        raise HTTPException(422, "Укажите повторы или время")
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


@app.get("/api/exercises/last")
async def last_sets(
    ids: str = Query(..., max_length=500), tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    """For each exercise id: the sets from the latest workout where the user did it ("в прошлый раз 60 кг × 8")."""
    user = await get_or_create_user(tg, session)
    wanted = {int(x) for x in ids.split(",") if x.strip().isdigit()}
    rows = await session.execute(
        select(WorkoutSet, WorkoutLog.id, WorkoutLog.started_at)
        .join(WorkoutLog, WorkoutLog.id == WorkoutSet.workout_log_id)
        .where(WorkoutLog.user_id == user.id, WorkoutSet.exercise_id.in_(wanted))
        .order_by(WorkoutLog.started_at.desc(), WorkoutSet.set_number)
    )
    out: dict[int, dict] = {}
    for ws, log_id, at in rows:
        last = out.setdefault(ws.exercise_id, {"log_id": log_id, "date": at.astimezone().date().isoformat(), "sets": []})
        if last["log_id"] == log_id:
            last["sets"].append({"reps": ws.reps, "duration_seconds": ws.duration_seconds, "weight_kg": ws.weight_kg})
    return {str(k): {"date": v["date"], "sets": v["sets"]} for k, v in out.items()}


app.include_router(ai_router)
app.include_router(daily_router)
app.include_router(quick_food_router)
app.include_router(stats_router)


# Serve the built Mini App from the same origin, so one HTTPS tunnel covers UI + API.
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="webapp")
