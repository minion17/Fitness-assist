"""Intermittent fasting (time-restricted eating): a daily eating window and a timer since the last logged meal.

What the evidence supports (see the Mini App's explainer): it's a way to keep a calorie deficit, not extra fat burning —
with the same calories the results match a regular diet (BMJ 2025 network meta-analysis, 99 RCTs; ChronoFast 2025).
With resistance training and protein ≥1.6 g/kg, an 8-hour window keeps lean mass. So the norm stays the same;
the window only decides when it is eaten.
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.daily import HHMM
from backend.api.deps import get_or_create_user, telegram_user
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import FastingPlan, FoodLog

router = APIRouter(prefix="/api")
PROTOCOLS = (12, 14, 16, 18)
STALE = timedelta(hours=36)  # an older last meal means they just stopped logging: count from the last window close


def minutes(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def eat_to(plan: FastingPlan) -> str:
    m = (minutes(plan.eat_from) + (24 - plan.hours) * 60) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def in_window(plan: FastingPlan, local: datetime) -> bool:
    m, a, b = local.hour * 60 + local.minute, minutes(plan.eat_from), minutes(eat_to(plan))
    return a <= m < b if a < b else m >= a or m < b


def last_boundary(local: datetime, hhmm: str) -> datetime:
    """The latest moment at hh:mm not after `local`."""
    h, m = map(int, hhmm.split(":"))
    t = local.replace(hour=h, minute=m, second=0, microsecond=0)
    return t if t <= local else t - timedelta(days=1)


def state(plan: FastingPlan, last_meal: datetime | None, now: datetime) -> dict:
    """eating: the window is open now; fast_start: when the current fast began (the last meal, or the last window
    close if the meal is older than that or missing); fasted_h: hours since then; change_in: minutes to the next
    open/close."""
    local = clock.local(now)
    closed = last_boundary(local, eat_to(plan))
    start = last_meal if last_meal and now - last_meal < STALE else closed
    if start > now:
        start = closed
    eating = in_window(plan, local)
    nxt = last_boundary(local, eat_to(plan) if eating else plan.eat_from) + timedelta(days=1)
    return {"eating": eating, "fast_start": start.isoformat(), "fasted_h": round((now - start).total_seconds() / 3600, 1),
            "change_in": round((nxt - local).total_seconds() / 60)}


def text(plan: FastingPlan, st: dict) -> str:
    """One line for the bot."""
    h = st["fasted_h"]
    left = f"{st['change_in'] // 60} ч {st['change_in'] % 60} мин"
    if st["eating"]:
        if h >= plan.hours:
            return f"🍽 Окно питания открыто до {eat_to(plan)}. Голод {h:g} ч позади — начни с белка."
        return f"🍽 Окно питания открыто ещё {left} (до {eat_to(plan)})."
    if h >= plan.hours:
        return f"✅ Голод {h:g} ч — цель {plan.hours} ч достигнута. Окно откроется в {plan.eat_from}."
    return f"⏱ Голод {h:g} ч из {plan.hours}. Окно откроется через {left}, в {plan.eat_from}. Вода, чай и кофе без сахара — можно."


async def last_meal(session: AsyncSession, user_id: int) -> datetime | None:
    return await session.scalar(select(func.max(FoodLog.logged_at)).where(FoodLog.user_id == user_id))


async def kept(session: AsyncSession, plan: FastingPlan, user_id: int) -> tuple[int, int]:
    """Of the last 7 full days with food logged, how many had every entry inside the window."""
    today = clock.today()
    rows = await session.scalars(select(FoodLog.logged_at).where(
        FoodLog.user_id == user_id, FoodLog.logged_at >= clock.local_start(today - timedelta(days=7)),
        FoodLog.logged_at < clock.local_start(today)))
    days: dict = {}
    for at in rows:
        local = clock.local(at)
        days[local.date()] = days.get(local.date(), True) and in_window(plan, local)
    return sum(days.values()), len(days)


async def status(session: AsyncSession, user_id: int) -> dict:
    plan = await session.get(FastingPlan, user_id)
    if plan is None:
        return {"plan": None}
    ok, logged = await kept(session, plan, user_id)
    return {"plan": {"hours": plan.hours, "eat_from": plan.eat_from, "eat_to": eat_to(plan), "remind": plan.remind},
            **state(plan, await last_meal(session, user_id), clock.now()), "kept": ok, "logged": logged}


class PlanIn(BaseModel):
    hours: int
    eat_from: str = Field(pattern=HHMM)
    remind: bool = True
    safe: bool  # "ничего из списка противопоказаний не про меня" — the app asks before enabling


@router.get("/fasting")
async def get_fasting(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    return await status(session, user.id)


@router.put("/fasting")
async def put_fasting(body: PlanIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    if body.hours not in PROTOCOLS:
        raise HTTPException(422, "hours must be 12, 14, 16 or 18")
    if not body.safe:
        raise HTTPException(422, "contraindications not confirmed")
    user = await get_or_create_user(tg, session)
    values = body.model_dump(exclude={"safe"})
    await session.execute(insert(FastingPlan).values(user_id=user.id, **values)
                          .on_conflict_do_update(index_elements=["user_id"], set_=values))
    await session.commit()
    return await status(session, user.id)


@router.delete("/fasting")
async def delete_fasting(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    await session.execute(delete(FastingPlan).where(FastingPlan.user_id == user.id))
    await session.commit()
    return {"plan": None}
