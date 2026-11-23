"""Water tracker and the last-7-days overview (week rings + streak)."""
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import body_facts, clock
from backend.core.nutrition import daily_targets, day_goals
from backend.database.db import AsyncSession, get_session
from backend.database.models import DailyCheckin, FoodLog, FrozenDay, HabitCheck, Outbox, Product, Profile, ReminderSettings, User, WaterIntake, WorkoutLog
from backend.database.rewards import award_xp, revoke_xp, sync_evolution

router = APIRouter(prefix="/api")
GLASS_ML = 250
MAX_ML = 6000


def local_start(d: date) -> datetime:
    return clock.local_start(d)


def water_goal(profile: Profile | None) -> int:
    """~33 ml per kg, rounded to a glass, within 1.5–4 l."""
    if profile is None:
        return 2000
    ml = round(profile.weight_kg * 33 / GLASS_ML) * GLASS_ML
    return min(4000, max(1500, ml))


@router.get("/water")
async def get_water(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    row = await session.scalar(select(WaterIntake).where(WaterIntake.user_id == user.id, WaterIntake.day == clock.today()))
    return {"ml": row.ml if row else 0, "goal_ml": water_goal(await session.get(Profile, user.id))}


class WaterIn(BaseModel):
    delta_ml: int = Field(ge=-1000, le=1000)  # +250 a glass, -250 to undo
    day: date | None = None  # a glass logged offline goes to the day it was drunk (today or yesterday)


@router.post("/water")
async def add_water(body: WaterIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    today = clock.recent_day(body.day)
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
    if ml >= goal:
        xp = await award_xp(session, user.id, "water_goal", f"water:{today}")
    else:  # poured back below the goal: "+3 l, undo" doesn't pay
        xp = 0
        await revoke_xp(session, user.id, f"water:{today}", commit=False)
    await sync_evolution(session, user.id, "like_water")
    await session.commit()
    return {"ml": ml, "goal_ml": goal, "xp_awarded": xp}


async def active_days(session: AsyncSession, user: User, since: date) -> dict[date, dict]:
    """Per local day since `since`: kcal eaten, water ml, completed workouts, habits ticked."""
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
        bucket(logged_at.astimezone(clock.tz()).date())["kcal"] += kcal * grams / 100
    for w in await session.scalars(select(WaterIntake).where(WaterIntake.user_id == user.id, WaterIntake.day >= since)):
        bucket(w.day)["water_ml"] = w.ml
    for done in await session.scalars(
        select(WorkoutLog.completed_at).where(WorkoutLog.user_id == user.id, WorkoutLog.completed_at >= start)
    ):
        bucket(done.astimezone(clock.tz()).date())["workouts"] += 1
    for d in await session.scalars(select(HabitCheck.day).where(HabitCheck.user_id == user.id, HabitCheck.day >= since)):
        bucket(d)["habits"] = bucket(d).get("habits", 0) + 1
    return days


def is_active(v: dict) -> bool:
    return bool(v.get("frozen") or v["kcal"] > 0 or v["water_ml"] > 0 or v["workouts"] > 0 or v.get("habits"))


def streak(days: dict[date, dict], today: date) -> int:
    """Consecutive active (or frozen) days up to today; today may still be empty without breaking the streak."""
    active = {d for d, v in days.items() if is_active(v)}
    d = today if today in active else today - timedelta(days=1)
    n = 0
    while d in active:
        n += 1
        d -= timedelta(days=1)
    return n


MAX_FREEZES = 2


async def streak_state(session: AsyncSession, user: User, today: date) -> tuple[int, dict[date, dict]]:
    """Current streak and per-day activity, after spending freezes on a fresh gap and granting earned ones."""
    # shortcut: streak looks back at most a year; extend if anyone gets there
    days = await active_days(session, user, today - timedelta(days=365))
    for d in await session.scalars(select(FrozenDay.day).where(FrozenDay.user_id == user.id, FrozenDay.day >= today - timedelta(days=365))):
        days.setdefault(d, {"kcal": 0.0, "water_ml": 0, "workouts": 0})["frozen"] = True
    # missed days right before today (today itself can still be filled) are covered if there are enough freezes
    gap, d = [], today - timedelta(days=1)
    while d not in days and len(gap) < user.streak_freezes:
        gap.append(d)
        d -= timedelta(days=1)
    if gap and d in days and is_active(days[d]):
        for g in gap:
            await session.execute(insert(FrozenDay).values(user_id=user.id, day=g).on_conflict_do_nothing())
            days[g] = {"kcal": 0.0, "water_ml": 0, "workouts": 0, "frozen": True}
        user.streak_freezes -= len(gap)
        await session.commit()
    n = streak(days, today)
    if n >= 7:
        first = (today if today in days and is_active(days[today]) else today - timedelta(days=1)) - timedelta(days=n - 1)
        for k in range(7, n + 1, 7):  # each full week of this streak, once
            if await award_xp(session, user.id, "streak_week", f"streak:{first}:{k}"):
                await session.refresh(user)
                user.streak_freezes = min(MAX_FREEZES, user.streak_freezes + 1)
                await session.commit()
    return n, days


@router.get("/week")
async def week(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    today = clock.today()
    n, days = await streak_state(session, user, today)
    last7 = [today - timedelta(days=i) for i in range(6, -1, -1)]
    empty = {"kcal": 0.0, "water_ml": 0, "workouts": 0}
    rows = [{"date": d.isoformat(), **{**empty, **days.get(d, {})}, "kcal": round(days.get(d, empty)["kcal"]),
             "frozen": bool(days.get(d, {}).get("frozen"))} for d in last7]
    profile = await session.get(Profile, user.id)
    if profile:
        day_goals(daily_targets(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity,
                                profile.goal, profile.kcal_override), profile, rows)
    return {"streak": n, "freezes": user.streak_freezes, "days": rows}


# ---- Reminder settings (the bot sends them, see backend/bot/reminders.py) ----

HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
REMINDER_FIELDS = ("meals", "water", "streak", "weekly", "workout", "checkin", "breakfast_at", "lunch_at", "dinner_at", "streak_at",
                   "weekly_at", "workout_at", "checkin_at")
REMINDER_DEFAULTS = {"meals": True, "water": True, "streak": True, "weekly": True, "workout": True, "checkin": False,
                     "breakfast_at": "10:00", "lunch_at": "14:00", "dinner_at": "20:00", "streak_at": "21:00", "weekly_at": "19:00",
                     "workout_at": "09:00", "checkin_at": "09:00"}


class RemindersIn(BaseModel):
    meals: bool
    water: bool
    streak: bool
    weekly: bool = True  # optional: older clients don't send it
    weekly_at: str = Field(default="19:00", pattern=HHMM)
    workout: bool = True  # optional: older clients don't send it
    workout_at: str = Field(default="09:00", pattern=HHMM)
    checkin: bool = False  # optional: older clients don't send it
    checkin_at: str = Field(default="09:00", pattern=HHMM)
    breakfast_at: str = Field(pattern=HHMM)
    lunch_at: str = Field(pattern=HHMM)
    dinner_at: str = Field(pattern=HHMM)
    streak_at: str = Field(pattern=HHMM)


@router.get("/reminders")
async def get_reminders(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    cfg = await session.get(ReminderSettings, user.id)
    return {k: getattr(cfg, k) for k in REMINDER_FIELDS} if cfg else REMINDER_DEFAULTS


def next_reminder(cfg: dict, now: datetime) -> dict | None:
    """The nearest reminder time from the settings (local "HH:MM"), today or tomorrow. Whether it is sent depends on the
    day: a meal already logged or water on track sends nothing."""
    times = []
    if cfg["meals"]:
        times += [(cfg["breakfast_at"], "завтрак"), (cfg["lunch_at"], "обед"), (cfg["dinner_at"], "ужин")]
    if cfg["water"]:
        times += [("12:00", "вода"), ("16:00", "вода"), ("19:00", "вода")]
    if cfg["streak"]:
        times.append((cfg["streak_at"], "серия дней"))
    if cfg.get("workout", True) and now.weekday() in (cfg.get("training_days") or []):  # today is a training day
        times.append((cfg.get("workout_at") or "09:00", "тренировка"))
    if cfg.get("checkin"):
        times.append((cfg.get("checkin_at") or "09:00", "как спалось"))
    if not times:
        return None
    hm = now.strftime("%H:%M")
    later = sorted(t for t in times if t[0] > hm)
    at, what = later[0] if later else min(times)
    return {"at": at, "what": what, "tomorrow": not later}


@router.get("/reminders/next")
async def get_next_reminder(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    cfg = await session.get(ReminderSettings, user.id)
    p = await session.get(Profile, user.id)
    settings = {k: getattr(cfg, k) for k in REMINDER_FIELDS} if cfg else REMINDER_DEFAULTS
    return next_reminder({**settings, "training_days": p.training_days if p else None}, clock.now())


@router.post("/reminders/test")
async def test_reminder(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """A message through the bot right now: shows the whole path works (the bot is running and may write to the chat)."""
    user = await get_or_create_user(tg, session)
    m = Outbox(telegram_id=user.telegram_id, kind="text", text="🔔 Проверка: напоминания Setly приходят в этот чат.")
    session.add(m)
    await session.commit()
    return {"id": m.id}


@router.get("/reminders/test/{mid}")
async def test_reminder_state(mid: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    m = await session.get(Outbox, mid)
    if m is None or m.telegram_id != user.telegram_id:
        return {"sent": False}
    return {"sent": m.sent_at is not None}


@router.put("/reminders")
async def save_reminders(body: RemindersIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    await session.execute(
        insert(ReminderSettings).values(user_id=user.id, **body.model_dump())
        .on_conflict_do_update(index_elements=["user_id"], set_=body.model_dump())
    )
    await session.commit()
    return body.model_dump()


# ---- Morning check-in: sleep and energy ----

SLEEP = {1: "меньше 6 ч", 2: "6–7 ч", 3: "7–8 ч", 4: "8+ ч"}
ENERGY = {1: "мало сил", 2: "нормально", 3: "бодро"}


class CheckinIn(BaseModel):
    sleep: int | None = Field(default=None, ge=1, le=4)
    energy: int | None = Field(default=None, ge=1, le=3)


async def save_checkin(session: AsyncSession, user, sleep: int | None, energy: int | None) -> None:
    """Today's answers; one call may carry only one of them (the bot asks sleep, then energy)."""
    values = {k: v for k, v in (("sleep", sleep), ("energy", energy)) if v is not None}
    stmt = insert(DailyCheckin).values(user_id=user.id, day=clock.today(), **values)
    await session.execute(stmt.on_conflict_do_update(index_elements=["user_id", "day"], set_=values) if values else stmt.on_conflict_do_nothing())
    await session.commit()


async def checkin_insight(session: AsyncSession, user) -> str | None:
    """After a few weeks: how sleep goes with eating and training. None until both kinds of nights have 4+ days each."""
    from backend.database.models import WorkoutSet

    since = clock.today() - timedelta(days=42)
    rows = list(await session.execute(select(DailyCheckin.day, DailyCheckin.sleep).where(
        DailyCheckin.user_id == user.id, DailyCheckin.day >= since, DailyCheckin.day < clock.today(), DailyCheckin.sleep.is_not(None))))
    good = {d for d, s in rows if s >= 3}
    bad = {d for d, s in rows if s <= 2}
    if len(good) < 4 or len(bad) < 4:
        return None
    kcal: dict = {}
    for at, g, k in await session.execute(select(FoodLog.logged_at, FoodLog.amount_g, Product.kcal).join(Product, Product.id == FoodLog.product_id)
                                          .where(FoodLog.user_id == user.id, FoodLog.logged_at >= local_start(since))):
        d = clock.local(at).date()
        kcal[d] = kcal.get(d, 0) + g * k / 100
    volume: dict = {}
    for at, w, r in await session.execute(select(WorkoutLog.started_at, WorkoutSet.weight_kg, WorkoutSet.reps)
                                          .join(WorkoutSet, WorkoutSet.workout_log_id == WorkoutLog.id)
                                          .where(WorkoutLog.user_id == user.id, WorkoutLog.started_at >= local_start(since))):
        d = clock.local(at).date()
        volume[d] = volume.get(d, 0) + (w or 0) * (r or 0)

    def avg(days, data):
        vals = [data[d] for d in days if data.get(d)]
        return sum(vals) / len(vals) if len(vals) >= 3 else None

    parts = []
    kg, kb = avg(good, kcal), avg(bad, kcal)
    if kg and kb and abs(kb - kg) >= 150:
        parts.append(f"съедаешь на {round(abs(kb - kg), -1):.0f} ккал {'меньше' if kg < kb else 'больше'}")
    vg, vb = avg(good, volume), avg(bad, volume)
    if vg and vb and abs(vg - vb) / max(vg, vb) >= 0.1:
        parts.append(f"поднимаешь за тренировку на {abs(round((vg - vb) / vb * 100))}% {'больше' if vg > vb else 'меньше'}")
    return f"В дни после сна 7+ часов ты {' и '.join(parts)}." if parts else None


@router.get("/checkin")
async def get_checkin(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    c = await session.get(DailyCheckin, (user.id, clock.today()))
    profile = await session.get(Profile, user.id)
    tip = c and profile and body_facts.sleep_tip(profile.sex, c.sleep)  # a short night today: why sleep matters
    return {"sleep": c and c.sleep, "energy": c and c.energy, "insight": tip or await checkin_insight(session, user)}


@router.post("/checkin")
async def post_checkin(body: CheckinIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    await save_checkin(session, user, body.sleep, body.energy)
    return await get_checkin(tg, session)
