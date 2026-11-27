"""Group challenges among friends: a daily tick for 7/14/30 days ("Без сладкого", "Зарядка"). Everyone sees everyone's
progress; at the end the bot sums up and those with 80%+ of the days get XP. Ticks are on trust: it's among friends."""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.social import friends_of, name, notify, plural_days
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import Challenge, ChallengeCheck, ChallengeMember, User
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")
MAX_MEMBERS = 10
MAX_ACTIVE = 3  # challenges one person can be in at once
DONE_SHARE = 0.8


def end_day(c: Challenge) -> date:
    return c.start_day + timedelta(days=c.days - 1)


async def challenge_out(session: AsyncSession, c: Challenge, me: User) -> dict:
    today = clock.today()
    rows = (await session.execute(select(User, ChallengeMember.joined).join(ChallengeMember, ChallengeMember.user_id == User.id)
                                  .where(ChallengeMember.challenge_id == c.id))).all()
    checks: dict[int, set[date]] = {}
    for uid, d in await session.execute(select(ChallengeCheck.user_id, ChallengeCheck.day).where(ChallengeCheck.challenge_id == c.id)):
        checks.setdefault(uid, set()).add(d)
    day_n = min(max((today - c.start_day).days + 1, 0), c.days)
    members = sorted(({"name": "Ты" if u.id == me.id else name(u), "me": u.id == me.id, "joined": joined,
                       "done": len(checks.get(u.id, ())), "today": today in checks.get(u.id, ())} for u, joined in rows),
                     key=lambda m: (not m["joined"], -m["done"], not m["me"]))
    mine = next((m for m in members if m["me"]), None)
    return {"id": c.id, "title": c.title, "emoji": c.emoji, "days": c.days, "day": day_n, "start_day": c.start_day.isoformat(),
            "end_day": end_day(c).isoformat(), "finished": c.closed or today > end_day(c), "mine": c.creator_id == me.id,
            "invited": bool(mine and not mine["joined"]), "members": members}


@router.get("/challenges")
async def list_challenges(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Mine: invitations, the running ones, and the ones finished in the last week."""
    user = await get_or_create_user(tg, session)
    week_ago = clock.today() - timedelta(days=7)
    cs = await session.scalars(select(Challenge).join(ChallengeMember, ChallengeMember.challenge_id == Challenge.id)
                               .where(ChallengeMember.user_id == user.id).order_by(Challenge.id.desc()))
    return [await challenge_out(session, c, user) for c in cs if not (c.closed and end_day(c) < week_ago)]


class ChallengeIn(BaseModel):
    title: str = Field(min_length=2, max_length=60)
    emoji: str = Field(default="🔥", max_length=8)
    days: int
    friend_ids: list[int] = Field(min_length=1, max_length=MAX_MEMBERS - 1)

    @field_validator("days")
    @classmethod
    def length(cls, v: int) -> int:
        if v not in (7, 14, 30):
            raise ValueError("7, 14 или 30 дней")
        return v


async def active_count(session: AsyncSession, user: User) -> int:
    return await session.scalar(select(func.count()).select_from(ChallengeMember).join(Challenge, Challenge.id == ChallengeMember.challenge_id)
                                .where(ChallengeMember.user_id == user.id, ChallengeMember.joined.is_(True), Challenge.closed.is_(False)))


@router.post("/challenges")
async def create_challenge(body: ChallengeIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if await active_count(session, user) >= MAX_ACTIVE:
        raise HTTPException(409, f"Не больше {MAX_ACTIVE} челленджей одновременно")
    friends = {f.id: f for f in await friends_of(session, user)}
    invited = [friends[i] for i in dict.fromkeys(body.friend_ids) if i in friends]
    if not invited:
        raise HTTPException(422, "Позови хотя бы одного друга")
    c = Challenge(creator_id=user.id, title=body.title.strip(), emoji=body.emoji.strip() or "🔥", days=body.days, start_day=clock.today())
    session.add(c)
    await session.flush()
    session.add(ChallengeMember(challenge_id=c.id, user_id=user.id, joined=True))
    for f in invited:
        session.add(ChallengeMember(challenge_id=c.id, user_id=f.id, joined=False))
        notify(session, f, f"{c.emoji} {name(user)} зовёт тебя в челлендж «{c.title}» на {plural_days(c.days)}. Принять — в Nextly: Прогресс → Друзья.")
    await session.commit()
    return await challenge_out(session, c, user)


async def membership(session: AsyncSession, cid: int, user: User) -> tuple[Challenge, ChallengeMember]:
    c = await session.get(Challenge, cid)
    m = await session.get(ChallengeMember, (cid, user.id))
    if c is None or m is None:
        raise HTTPException(404, "Челлендж не найден")
    return c, m


@router.post("/challenges/{cid}/join")
async def join(cid: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    c, m = await membership(session, cid, user)
    if c.closed or clock.today() > end_day(c):
        raise HTTPException(409, "Челлендж уже закончился")
    if not m.joined:
        if await active_count(session, user) >= MAX_ACTIVE:
            raise HTTPException(409, f"Не больше {MAX_ACTIVE} челленджей одновременно")
        m.joined = True
        creator = await session.get(User, c.creator_id)
        if creator:
            notify(session, creator, f"{c.emoji} {name(user)} принял(а) челлендж «{c.title}»")
        await session.commit()
    return await challenge_out(session, c, user)


@router.post("/challenges/{cid}/leave")
async def leave(cid: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Decline an invitation or quit."""
    user = await get_or_create_user(tg, session)
    c, m = await membership(session, cid, user)
    await session.delete(m)
    await session.execute(delete(ChallengeCheck).where(ChallengeCheck.challenge_id == cid, ChallengeCheck.user_id == user.id))
    await session.commit()
    return {"ok": True}


class TickIn(BaseModel):
    done: bool


@router.post("/challenges/{cid}/check")
async def tick(cid: int, body: TickIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Today only: yesterday can't be filled in afterwards."""
    user = await get_or_create_user(tg, session)
    c, m = await membership(session, cid, user)
    today = clock.today()
    if not m.joined:
        raise HTTPException(409, "Сначала прими челлендж")
    if c.closed or not c.start_day <= today <= end_day(c):
        raise HTTPException(409, "Челлендж уже закончился")
    if body.done:
        await session.execute(insert(ChallengeCheck).values(challenge_id=cid, user_id=user.id, day=today).on_conflict_do_nothing())
    else:
        await session.execute(delete(ChallengeCheck).where(ChallengeCheck.challenge_id == cid, ChallengeCheck.user_id == user.id,
                                                           ChallengeCheck.day == today))
    await session.commit()
    return await challenge_out(session, c, user)


async def finish_challenges(session: AsyncSession) -> int:
    """Close the challenges whose last day is over (with a day's slack for other time zones). Run by the bot."""
    done = 0
    yesterday = date.today() - timedelta(days=1)
    for c in list(await session.scalars(select(Challenge).where(Challenge.closed.is_(False)))):
        if end_day(c) >= yesterday:
            continue
        rows = (await session.execute(
            select(User, func.count(ChallengeCheck.day)).join(ChallengeMember, ChallengeMember.user_id == User.id)
            .outerjoin(ChallengeCheck, (ChallengeCheck.challenge_id == c.id) & (ChallengeCheck.user_id == User.id))
            .where(ChallengeMember.challenge_id == c.id, ChallengeMember.joined.is_(True)).group_by(User.id))).all()
        board = ", ".join(f"{name(u)} {n}/{c.days}" for u, n in sorted(rows, key=lambda r: -r[1]))
        for u, n in rows:
            if n >= DONE_SHARE * c.days:
                xp = await award_xp(session, u.id, "challenge_done", f"challenge:{c.id}")
                notify(session, u, f"{c.emoji} Челлендж «{c.title}» завершён, цель выполнена: {n} из {c.days} {'дня' if c.days % 10 == 1 and c.days % 100 != 11 else 'дней'}! +{xp} XP\nИтоги: {board}")
            else:
                notify(session, u, f"{c.emoji} Челлендж «{c.title}» завершён: {n} из {c.days} {'дня' if c.days % 10 == 1 and c.days % 100 != 11 else 'дней'}. Итоги: {board}. Попробуем ещё раз?")
        c.closed = True
        await session.commit()
        done += 1
    return done
