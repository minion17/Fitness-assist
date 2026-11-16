"""PDF report for a coach or doctor: the app asks, the bot draws it and sends it to the chat as a file."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.social import name
from backend.api.stats import daily_series, targets
from backend.core import clock
from backend.core.nutrition import GOAL_RU, OLD_GOALS
from backend.database.db import AsyncSession, get_session
from backend.database.models import BodyMeasurement, Outbox, Profile, User, WorkoutLog

router = APIRouter(prefix="/api")


async def gather(session: AsyncSession, user: User, days: int) -> dict:
    """Everything the report shows, in the user's calendar (call with their zone set)."""
    until = clock.today()
    since = until - timedelta(days=days - 1)
    series = await daily_series(session, user, since, until)
    profile = await session.get(Profile, user.id)
    t = targets(profile)
    logged = [s for s in series if s["kcal"] > 0]
    avg = lambda k: sum(s[k] for s in logged) / len(logged) if logged else 0  # noqa: E731
    in_norm = sum(1 for s in logged if t and abs(s["kcal"] - t["calories"]) <= 0.1 * t["calories"])
    ms = list(await session.scalars(select(BodyMeasurement).where(
        BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on >= since, BodyMeasurement.measured_on <= until)
        .order_by(BodyMeasurement.measured_on)))
    fields = ("weight_kg", "waist_cm", "hips_cm", "chest_cm", "body_fat_pct")

    def edge(rows):  # first / last known value of each field
        return {f: next((getattr(m, f) for m in rows if getattr(m, f)), None) for f in fields}
    logs = list(await session.scalars(select(WorkoutLog).options(selectinload(WorkoutLog.sets)).where(
        WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None), WorkoutLog.completed_at >= clock.local_start(since))
        .order_by(WorkoutLog.completed_at)))
    water = [s["water_ml"] for s in series if s["water_ml"]]
    return {
        "name": name(user), "since": since, "until": until, "span": days,
        "profile": {"goal": GOAL_RU.get(OLD_GOALS.get(profile.goal, profile.goal), profile.goal), "height": profile.height_cm,
                    "kcal": t["calories"], "protein": t["protein"], "fat": t["fat"], "carbs": t["carbs"]} if profile and t else None,
        "nutrition": {"days": len(logged), "in_norm": in_norm, "kcal": avg("kcal"), "protein": avg("protein"), "fat": avg("fat"),
                      "carbs": avg("carbs"), "daily": [s["kcal"] for s in series]},
        "body": {"points": [((m.measured_on - since).days, m.weight_kg) for m in ms if m.weight_kg],
                 "first": edge(ms), "last": edge(list(reversed(ms)))},
        "workouts": {"sessions": [{"date": w.completed_at.astimezone(clock.tz()).date(), "title": w.title or "Тренировка",
                                   "sets": len(w.sets)} for w in logs], "sets": sum(len(w.sets) for w in logs)},
        "water_ml": sum(water) / len(water) if water else 0,
    }


class ReportIn(BaseModel):
    days: int = 30


@router.post("/report")
async def order_report(body: ReportIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    if body.days not in (7, 30, 90):
        raise HTTPException(422, "Период: 7, 30 или 90 дней")
    user = await get_or_create_user(tg, session)
    recent = await session.scalar(select(func.count()).where(
        Outbox.telegram_id == user.telegram_id, Outbox.kind == "report", Outbox.created_at > func.now() - timedelta(minutes=2)))
    if recent:
        raise HTTPException(429, "Отчёт уже готовится — загляните в чат с ботом")
    session.add(Outbox(telegram_id=user.telegram_id, kind="report", text=str(body.days), user_id=user.id))
    await session.commit()
    return {"ok": True}
