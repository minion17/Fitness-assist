"""Habits: the user's own daily checks (sleep, steps, no sweets, vitamins). A ticked habit keeps the streak going.

No XP for ticks: a tick costs nothing to fake, so it only counts toward the streak (like a glass of water).
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import Habit, HabitCheck, User

router = APIRouter(prefix="/api")
MAX_HABITS = 8


def run(days: set[date], today: date) -> int:
    """Days in a row ending today (or yesterday, while today isn't ticked yet)."""
    d = today if today in days else today - timedelta(days=1)
    n = 0
    while d in days:
        n += 1
        d -= timedelta(days=1)
    return n


async def habit_list(session: AsyncSession, user: User) -> list[dict]:
    today = clock.today()
    habits = list(await session.scalars(select(Habit).where(Habit.user_id == user.id, Habit.archived.is_(False)).order_by(Habit.id)))
    checks: dict[int, set[date]] = {}
    # shortcut: a habit's streak looks back a year at most
    for hid, d in await session.execute(select(HabitCheck.habit_id, HabitCheck.day).where(
            HabitCheck.user_id == user.id, HabitCheck.day >= today - timedelta(days=365))):
        checks.setdefault(hid, set()).add(d)
    return [{"id": h.id, "title": h.title, "emoji": h.emoji, "done": today in checks.get(h.id, ()),
             "streak": run(checks.get(h.id, set()), today), "remind_at": h.remind_at} for h in habits]


@router.get("/habits")
async def list_habits(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    return await habit_list(session, await get_or_create_user(tg, session))


class HabitIn(BaseModel):
    title: str = Field(min_length=1, max_length=40)
    emoji: str = Field(default="✅", max_length=8)

    @field_validator("title")
    @classmethod
    def strip(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("empty")
        return v.strip()


@router.post("/habits")
async def add_habit(body: HabitIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    active = select(func.count()).where(Habit.user_id == user.id, Habit.archived.is_(False))
    if await session.scalar(active) >= MAX_HABITS:
        raise HTTPException(409, f"Не больше {MAX_HABITS} привычек — уберите одну, чтобы добавить новую")
    if await session.scalar(select(Habit.id).where(Habit.user_id == user.id, Habit.archived.is_(False),
                                                   func.lower(Habit.title) == body.title.lower()).limit(1)):
        raise HTTPException(409, "Такая привычка уже есть")
    session.add(Habit(user_id=user.id, title=body.title, emoji=body.emoji.strip() or "✅"))
    await session.commit()
    return await habit_list(session, user)


async def own(session: AsyncSession, habit_id: int, user: User) -> Habit:
    h = await session.get(Habit, habit_id)
    if h is None or h.user_id != user.id or h.archived:
        raise HTTPException(404, "Привычка не найдена")
    return h


@router.delete("/habits/{habit_id}")
async def remove_habit(habit_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    (await own(session, habit_id, user)).archived = True
    await session.commit()
    return await habit_list(session, user)


class HabitPatch(BaseModel):
    remind_at: str | None = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")  # None turns the reminder off


@router.patch("/habits/{habit_id}")
async def patch_habit(habit_id: int, body: HabitPatch, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    (await own(session, habit_id, user)).remind_at = body.remind_at
    await session.commit()
    return await habit_list(session, user)


async def tick_from_bot(session: AsyncSession, telegram_id: int, habit_id: int) -> Habit | None:
    """The "✓" button under a habit reminder: ticks today (in the user's zone). None if it isn't theirs any more."""
    user = await session.scalar(select(User).where(User.telegram_id == telegram_id))
    h = await session.get(Habit, habit_id)
    if user is None or h is None or h.user_id != user.id or h.archived:
        return None
    clock.use_tz(user.device_tz)
    try:
        today = clock.today()
    finally:
        clock.use_tz(None)
    await session.execute(insert(HabitCheck).values(habit_id=h.id, day=today, user_id=user.id).on_conflict_do_nothing())
    await session.commit()
    return h


class CheckIn(BaseModel):
    done: bool  # a state, not a toggle: a double tap can't undo itself


@router.post("/habits/{habit_id}/check")
async def check(habit_id: int, body: CheckIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    await own(session, habit_id, user)
    today = clock.today()
    if body.done:
        await session.execute(insert(HabitCheck).values(habit_id=habit_id, day=today, user_id=user.id).on_conflict_do_nothing())
    else:
        await session.execute(delete(HabitCheck).where(HabitCheck.habit_id == habit_id, HabitCheck.day == today))
    await session.commit()
    return await habit_list(session, user)
