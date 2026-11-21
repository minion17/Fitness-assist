"""Progress over time (charts) and achievements."""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.daily import is_active, local_start, streak_state, water_goal
from backend.api.deps import get_or_create_user, telegram_user
from backend.core.nutrition import daily_targets
from backend.core.gamification import EVOLUTIONS, level_progress
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.rewards import award_xp, sync_evolution
from backend.database.models import (
    BodyMeasurement, Exercise, FoodLog, Product, Profile, User, UserAchievement, WaterIntake, WorkoutLog, WorkoutSet, XpEvent,
)

router = APIRouter(prefix="/api")


def targets(profile: Profile | None) -> dict | None:
    if profile is None:
        return None
    return daily_targets(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity, profile.goal,
                         profile.kcal_override)


async def daily_series(session: AsyncSession, user: User, since: date, until: date) -> list[dict]:
    """One row per local day in [since, until]: kcal, macros, water, completed workouts (zeros for empty days)."""
    rows = {since + timedelta(days=i): {"kcal": 0.0, "protein": 0.0, "fat": 0.0, "carbs": 0.0, "water_ml": 0, "workouts": 0}
            for i in range((until - since).days + 1)}
    start, end = local_start(since), local_start(until + timedelta(days=1))
    food = await session.execute(
        select(FoodLog.logged_at, FoodLog.amount_g, Product.kcal, Product.protein_g, Product.fat_g, Product.carbs_g)
        .join(Product, Product.id == FoodLog.product_id)
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= start, FoodLog.logged_at < end)
    )
    for at, grams, kcal, p, f, c in food:
        r = rows.get(at.astimezone(clock.tz()).date())
        if r:
            k = grams / 100
            r["kcal"] += kcal * k
            r["protein"] += p * k
            r["fat"] += f * k
            r["carbs"] += c * k
    for w in await session.scalars(
        select(WaterIntake).where(WaterIntake.user_id == user.id, WaterIntake.day >= since, WaterIntake.day <= until)
    ):
        rows[w.day]["water_ml"] = w.ml
    for done in await session.scalars(
        select(WorkoutLog.completed_at).where(
            WorkoutLog.user_id == user.id, WorkoutLog.completed_at >= start, WorkoutLog.completed_at < end
        )
    ):
        r = rows.get(done.astimezone(clock.tz()).date())
        if r:
            r["workouts"] += 1
    return [{"date": d.isoformat(), **{k: round(v) if k != "water_ml" else v for k, v in r.items()}} for d, r in rows.items()]


@router.get("/food-calendar")
async def food_calendar(month: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"), tg: dict = Depends(telegram_user),
                        session: AsyncSession = Depends(get_session)):
    """The diary's month for the calendar: calories per logged day and the norm, to colour the days."""
    user = await get_or_create_user(tg, session)
    first = date.fromisoformat(f"{month}-01")
    last = min((first + timedelta(days=32)).replace(day=1) - timedelta(days=1), clock.today())
    if last < first or first < clock.today() - timedelta(days=400):
        return {"days": {}, "goal": None}
    t = targets(await session.get(Profile, user.id))
    series = await daily_series(session, user, first, last)
    return {"days": {r["date"]: r["kcal"] for r in series if r["kcal"] > 0}, "goal": t["calories"] if t else None}


@router.get("/stats")
async def stats(
    days: int = Query(30, ge=7, le=365), tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)
):
    user = await get_or_create_user(tg, session)
    today = clock.today()
    since = today - timedelta(days=days - 1)
    profile = await session.get(Profile, user.id)
    t = targets(profile)

    weight = await session.execute(
        select(BodyMeasurement.measured_on, BodyMeasurement.weight_kg)
        .where(BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None), BodyMeasurement.measured_on >= since)
        .order_by(BodyMeasurement.measured_on)
    )

    # best working set per exercise per workout day: heaviest weight, then most reps
    sets = await session.execute(
        select(Exercise.id, Exercise.name, WorkoutLog.started_at, WorkoutSet.weight_kg, WorkoutSet.reps)
        .join(WorkoutLog, WorkoutLog.id == WorkoutSet.workout_log_id)
        .join(Exercise, Exercise.id == WorkoutSet.exercise_id)
        .where(WorkoutLog.user_id == user.id, WorkoutLog.started_at >= local_start(since), WorkoutSet.reps.is_not(None))
        .order_by(WorkoutLog.started_at)
    )
    best: dict[int, dict] = {}
    for ex_id, name, at, kg, reps in sets:
        e = best.setdefault(ex_id, {"id": ex_id, "name": name, "points": {}})
        d = at.astimezone(clock.tz()).date().isoformat()
        cur = e["points"].get(d)
        if cur is None or (kg, reps) > (cur["kg"], cur["reps"]):
            e["points"][d] = {"date": d, "kg": kg, "reps": reps}
    exercises = sorted(
        ({**e, "points": list(e["points"].values())} for e in best.values()), key=lambda e: -len(e["points"])
    )[:12]

    return {
        "days": await daily_series(session, user, since, today),
        "goal": {"calories": t["calories"], "protein": t["protein"], "fat": t["fat"], "carbs": t["carbs"],
                 "water_ml": water_goal(profile)} if t else None,
        "weight": [{"date": d.isoformat(), "kg": kg} for d, kg in weight],
        "exercises": exercises,
    }



# ---- Achievements: computed from the user's data; unlocking is stored once (+25 XP, celebration shown once) ----

# code -> (icon, title, what to do, metric, target)
ACHIEVEMENTS = [
    ("first_water", "💧", "Первая вода", "Запишите первый приём воды", "water_first", 1),
    ("first_meal", "🥄", "Первый шаг", "Запишите первый приём пищи", "meals", 1),
    ("first_workout", "💪", "Первая тренировка", "Завершите тренировку", "workouts", 1),
    ("streak_3", "🔥", "Разогрев", "3 дня подряд", "best_streak", 3),
    ("streak_7", "🔥", "Неделя", "7 дней подряд", "best_streak", 7),
    ("streak_30", "🏆", "Месяц без пропусков", "30 дней подряд", "best_streak", 30),
    ("streak_100", "💎", "Сотня", "100 дней подряд", "best_streak", 100),
    ("water_7", "💧", "Водный баланс", "7 дней с нормой воды", "water_days", 7),
    ("glasses_100", "🥛", "100 стаканов", "Выпейте 25 литров воды", "water_glasses", 100),
    ("norm_7", "🎯", "Точно в цель", "7 дней в норме калорий (±10%)", "norm_days", 7),
    ("workouts_10", "🏋️", "Десятка", "10 тренировок", "workouts", 10),
    ("workouts_50", "🦾", "Железный", "50 тренировок", "workouts", 50),
    ("measure_4", "📏", "Под контролем", "4 замера веса", "weighings", 4),
    ("level_5", "⭐", "Пятый уровень", "Достигните 5 уровня", "level", 5),
]


async def metrics(session: AsyncSession, user: User) -> dict[str, int]:
    today = clock.today()
    _, days = await streak_state(session, user, today)
    best, run = 0, 0
    for i in range(366):  # longest run of active days in the last year
        d = today - timedelta(days=365 - i)
        run = run + 1 if d in days and is_active(days[d]) else 0
        best = max(best, run)
    profile = await session.get(Profile, user.id)
    t, w_goal = targets(profile), water_goal(profile)
    water = list(await session.scalars(select(WaterIntake.ml).where(WaterIntake.user_id == user.id)))
    return {
        "meals": await session.scalar(select(func.count(FoodLog.id)).where(FoodLog.user_id == user.id)) or 0,
        "workouts": await session.scalar(
            select(func.count(WorkoutLog.id)).where(WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None))
        ) or 0,
        "best_streak": best,
        "water_days": sum(ml >= w_goal for ml in water),
        "water_glasses": sum(water) // 250,
        "water_first": int(any(ml > 0 for ml in water)),
        "norm_days": sum(1 for v in days.values() if t and abs(v["kcal"] - t["calories"]) <= 0.1 * t["calories"]),
        "weighings": await session.scalar(
            select(func.count(BodyMeasurement.id)).where(BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None))
        ) or 0,
        "level": level_progress(user.xp)["level"],
    }


@router.get("/achievements")
async def achievements(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """All badges with progress. `new` lists ones unlocked but not celebrated yet; POST /achievements/seen clears it."""
    user = await get_or_create_user(tg, session)
    await session.scalar(select(User.id).where(User.id == user.id).with_for_update())
    m = await metrics(session, user)
    for code, *_, metric, target in ACHIEVEMENTS:
        if m[metric] >= target:
            if await session.scalar(insert(UserAchievement).values(user_id=user.id, code=code).on_conflict_do_nothing()
                                    .returning(UserAchievement.code)):
                await award_xp(session, user.id, "achievement", f"achievement:{code}", commit=False)
    got = {a.code: a for a in await session.scalars(select(UserAchievement).where(UserAchievement.user_id == user.id))}
    items = [{"code": code, "icon": icon, "title": title, "hint": hint, "progress": min(m[metric], target), "target": target,
              "unlocked_at": got[code].unlocked_at.isoformat() if code in got else None}
             for code, icon, title, hint, metric, target in ACHIEVEMENTS]
    new = [i for i in items if i["code"] in got and not got[i["code"]].seen]
    for code in EVOLUTIONS:
        evolved = await sync_evolution(session, user.id, code)
        if evolved.pop("unseen"):
            new.append(evolved)
        items.append(evolved)
    # Active means a user with a recorded activity reward during the last 30 days.
    active = select(XpEvent.user_id).where(
        XpEvent.created_at >= func.now() - timedelta(days=30),
        XpEvent.event_type != "achievement",
    ).distinct().subquery()
    active_count = await session.scalar(select(func.count()).select_from(active))
    rarity = {}
    if active_count >= 10:
        rows = await session.execute(
            select(UserAchievement.code, func.count(func.distinct(UserAchievement.user_id)))
            .join(active, active.c.user_id == UserAchievement.user_id)
            .group_by(UserAchievement.code)
        )
        rarity = dict(rows.all())
    for item in items:
        rarity_code = f'{item["code"]}:{item["stage"]}' if item.get("stage", 0) > 0 else item["code"]
        item["holder_percent"] = round(100 * rarity.get(rarity_code, 0) / active_count, 1) if active_count >= 10 and item["unlocked_at"] else None
        item["featured"] = item["code"] in user.showcase
        item["pinned"] = item["code"] == user.pinned_badge
        item["title_selected"] = item["code"] == user.selected_title
    await session.commit()
    return {"items": items, "new": new,
            "freezes": user.streak_freezes}


@router.post("/achievements/seen")
async def achievements_seen(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    for a in await session.scalars(select(UserAchievement).where(UserAchievement.user_id == user.id, UserAchievement.seen.is_(False))):
        a.seen = True
    await session.commit()
    return {"ok": True}

class ShowcaseSettings(BaseModel):
    showcase: list[str] = Field(max_length=3)
    pinned: str | None = None


@router.put("/achievements/showcase")
async def update_showcase(body: ShowcaseSettings, tg: dict = Depends(telegram_user),
                          session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    owned = {key.split(":")[0] for key in await session.scalars(
        select(UserAchievement.code).where(UserAchievement.user_id == user.id))}
    selected = set(body.showcase)
    if len(selected) != len(body.showcase) or not selected <= owned or (body.pinned is not None and body.pinned not in owned):
        raise HTTPException(400, "Выберите полученные награды без повторов")
    user.showcase = body.showcase
    user.pinned_badge = body.pinned
    await session.commit()
    return {"ok": True}


class TitleSettings(BaseModel):
    code: str | None = None


@router.put("/achievements/title")
async def update_title(body: TitleSettings, tg: dict = Depends(telegram_user),
                       session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if body.code is not None:
        owned = await session.scalar(select(UserAchievement.code).where(
            UserAchievement.user_id == user.id,
            (UserAchievement.code == body.code) | (UserAchievement.code == f"{body.code}:1"),
        ).limit(1))
        if not owned:
            raise HTTPException(400, "Сначала получите достижение")
    user.selected_title = body.code
    await session.commit()
    return {"ok": True}
