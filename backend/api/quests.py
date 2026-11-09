"""Weekly tasks: three per week (food, training, habit), XP for each and a bonus for all three.

Progress is computed from the diary itself, so there is nothing to "tick off" by hand and nothing to fake
beyond what the diary rules already allow (rolling XP caps, one weighing per day, workouts need sets).
"""
import hashlib
import math
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.daily import water_goal
from backend.api.deps import get_or_create_user, telegram_user
from backend.api.stats import daily_series, targets
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import BodyMeasurement, FoodLog, Profile, User, WeeklyQuest
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")

# code -> (title with {n}, reward rule, default target, counts days (target shrinks for a late start))
QUESTS = {
    "diary_days": ("Ведите дневник питания {n} дн.", "quest_50", 5, True),
    "full_days": ("{n} дн. с завтраком, обедом и ужином", "quest_50", 3, True),
    "norm_days": ("{n} дн. в норме калорий (±10%)", "quest_80", 3, True),
    "workouts": ("Проведите {n} {трениров}", "quest_80", 3, False),
    "weigh": ("Взвесьтесь {n} {раз}", "quest_30", 2, True),
    "water_days": ("{n} дн. с нормой воды", "quest_50", 4, True),
    "active_days": ("Отмечайте что-нибудь {n} дн. за неделю", "quest_80", 6, True),
}
SLOTS = (("diary_days", "full_days", "norm_days"), ("workouts", "weigh"), ("water_days", "active_days"))


def plural(n: int, one: str, few: str, many: str) -> str:
    return one if n % 10 == 1 and n % 100 != 11 else few if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else many


def title(code: str, n: int) -> str:
    return QUESTS[code][0].format(n=n, трениров=plural(n, "тренировку", "тренировки", "тренировок"), раз=plural(n, "раз", "раза", "раз"))


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def pick(user_id: int, week: date, options: tuple[str, ...]) -> str:
    """Same user + week -> same choice; different weeks rotate."""
    return options[int(hashlib.sha256(f"{user_id}:{week}:{options}".encode()).hexdigest(), 16) % len(options)]


async def assign(session: AsyncSession, user: User, week: date, today: date) -> list[WeeklyQuest]:
    rows = list(await session.scalars(select(WeeklyQuest).where(WeeklyQuest.user_id == user.id, WeeklyQuest.week == week).order_by(WeeklyQuest.slot)))
    if rows:
        return rows
    profile = await session.get(Profile, user.id)
    days_left = 7 - (today - week).days  # today included
    food = SLOTS[0] if profile else ("diary_days", "full_days")  # "norm" needs the profile's calorie target
    training = ("workouts",) if user.program_id else ("weigh",)
    chosen = [pick(user.id, week, food), pick(user.id, week, training), pick(user.id, week, SLOTS[2])]
    for slot, code in enumerate(chosen):
        target = QUESTS[code][2]
        target = min(target, days_left) if QUESTS[code][3] else min(target, max(1, math.ceil(days_left / 2)))
        await session.execute(insert(WeeklyQuest).values(user_id=user.id, week=week, code=code, target=max(1, target), slot=slot)
                              .on_conflict_do_nothing())
    await session.commit()
    return list(await session.scalars(select(WeeklyQuest).where(WeeklyQuest.user_id == user.id, WeeklyQuest.week == week).order_by(WeeklyQuest.slot)))


async def progress(session: AsyncSession, user: User, week: date, until: date) -> dict[str, int]:
    days = await daily_series(session, user, week, until)
    profile = await session.get(Profile, user.id)
    t, w_goal = targets(profile), water_goal(profile)
    start, end = clock.local_start(week), clock.local_start(until + timedelta(days=1))
    meals: dict[date, set[str]] = {}
    for at, kind in await session.execute(select(FoodLog.logged_at, FoodLog.meal_type).where(
            FoodLog.user_id == user.id, FoodLog.logged_at >= start, FoodLog.logged_at < end)):
        meals.setdefault(clock.local(at).date(), set()).add(kind)
    return {
        "diary_days": sum(d["kcal"] > 0 for d in days),
        "full_days": sum({"breakfast", "lunch", "dinner"} <= m for m in meals.values()),
        "norm_days": sum(bool(t) and abs(d["kcal"] - t["calories"]) <= 0.1 * t["calories"] for d in days),
        "workouts": sum(d["workouts"] for d in days),
        "weigh": await session.scalar(select(func.count(BodyMeasurement.id)).where(
            BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None),
            BodyMeasurement.measured_on >= week, BodyMeasurement.measured_on <= until)) or 0,
        "water_days": sum(d["water_ml"] >= w_goal for d in days),
        "active_days": sum(d["kcal"] > 0 or d["water_ml"] > 0 or d["workouts"] > 0 for d in days),
    }


async def settle(session: AsyncSession, user: User, week: date, until: date) -> tuple[list[dict], int]:
    """Quests with progress; awards XP for newly finished ones (once each). Returns (quests, xp awarded now)."""
    quests = await assign(session, user, week, until) if until >= week else []
    have = await progress(session, user, week, until)
    out, awarded = [], 0
    for q in quests:
        rule = QUESTS[q.code][1]
        done = have[q.code] >= q.target
        if done:
            awarded += await award_xp(session, user.id, rule, f"quest:{week}:{q.code}")
        out.append({"code": q.code, "title": title(q.code, q.target), "progress": min(have[q.code], q.target),
                    "target": q.target, "xp": int(rule.split("_")[1]), "done": done})
    if out and all(q["done"] for q in out):
        awarded += await award_xp(session, user.id, "quests_all", f"quests:{week}")
    return out, awarded


@router.get("/quests")
async def quests(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    today = clock.today()
    week = monday(today)
    # last week's tasks finished on Sunday night are still paid when the app is opened next
    last = week - timedelta(days=7)
    _, late = (await settle(session, user, last, last + timedelta(days=6))) if await session.scalar(
        select(WeeklyQuest.code).where(WeeklyQuest.user_id == user.id, WeeklyQuest.week == last).limit(1)) else ([], 0)
    items, now = await settle(session, user, week, today)
    return {"week": week.isoformat(), "days_left": 7 - (today - week).days, "items": items,
            "bonus": 50, "xp_awarded": late + now}
