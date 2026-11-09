"""Friends (by invite link), a weekly leaderboard, friendly duels and a shareable progress card.

The API has no bot connection: anything to send in Telegram goes to the `outbox` table and the bot sends it.
"""
import secrets
from datetime import timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select

from backend.api.daily import streak_state
from backend.api.deps import get_or_create_user, telegram_user
from backend.core import clock
from backend.core.config import settings
from backend.core.gamification import level_progress
from backend.database.db import AsyncSession, get_session
from backend.database.models import Duel, Friendship, Outbox, User, WorkoutLog, XpEvent
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")
USERNAME_FILE = Path(__file__).resolve().parents[2] / ".bot_username"  # written by the bot at startup
MAX_FRIENDS = 100
METRICS = {"xp": "XP", "workouts": "тренировок"}


def name(u: User) -> str:
    return u.first_name or (u.username and f"@{u.username}") or "Друг"


def bot_username() -> str:
    try:
        return USERNAME_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return settings.bot_username


async def invite_code(session: AsyncSession, user: User) -> str:
    if not user.invite_code:
        user.invite_code = secrets.token_urlsafe(8)[:10].replace("-", "x").replace("_", "y")
        await session.commit()
    return user.invite_code


def notify(session: AsyncSession, user: User, text: str, kind: str = "text") -> None:
    session.add(Outbox(telegram_id=user.telegram_id, text=text, kind=kind, user_id=user.id))


async def befriend(session: AsyncSession, code: str, telegram_id: int, first_name: str | None) -> User | None:
    """The person with `telegram_id` opened someone's invite link: make them friends (both notified).
    Returns the inviter, or None for a bad code / own link / already friends."""
    inviter = await session.scalar(select(User).where(User.invite_code == code))
    if inviter is None or inviter.telegram_id == telegram_id:
        return None
    me = await session.scalar(select(User).where(User.telegram_id == telegram_id))
    if me is None:
        me = User(telegram_id=telegram_id, first_name=first_name)
        session.add(me)
        await session.flush()
    if await session.get(Friendship, (me.id, inviter.id)):
        return None
    if await session.scalar(select(func.count()).where(Friendship.user_id == inviter.id)) >= MAX_FRIENDS:
        return None
    session.add_all([Friendship(user_id=me.id, friend_id=inviter.id), Friendship(user_id=inviter.id, friend_id=me.id)])
    notify(session, inviter, f"🤝 {name(me)} теперь у вас в друзьях. Посмотрите рейтинг недели или вызовите на дуэль.")
    await session.commit()
    return inviter


async def week_xp(session: AsyncSession, user_ids: list[int]) -> dict[int, int]:
    monday = clock.today() - timedelta(days=clock.today().weekday())
    rows = await session.execute(
        select(XpEvent.user_id, func.sum(XpEvent.xp))
        .where(XpEvent.user_id.in_(user_ids), XpEvent.created_at >= clock.local_start(monday))
        .group_by(XpEvent.user_id)
    )
    return {uid: int(xp) for uid, xp in rows}


async def friends_of(session: AsyncSession, user: User) -> list[User]:
    return list(await session.scalars(
        select(User).join(Friendship, Friendship.friend_id == User.id).where(Friendship.user_id == user.id)
    ))


@router.get("/friends")
async def friends(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Invite link and the weekly leaderboard (you included)."""
    user = await get_or_create_user(tg, session)
    people = [user, *await friends_of(session, user)]
    xp = await week_xp(session, [u.id for u in people])
    board = []
    for u in people:
        clock.use_tz(u.timezone or u.device_tz)  # each person's streak by their own calendar
        streak, _ = await streak_state(session, u, clock.today())
        board.append({"id": u.id, "name": name(u), "me": u.id == user.id, "level": level_progress(u.xp)["level"],
                      "week_xp": xp.get(u.id, 0), "streak": streak})
    clock.use_tz(user.timezone or user.device_tz)
    board.sort(key=lambda r: (-r["week_xp"], -r["streak"], not r["me"]))
    code, bot = await invite_code(session, user), bot_username()
    return {"invite_link": f"https://t.me/{bot}?start=f{code}" if bot else None, "board": board}


@router.delete("/friends/{friend_id}")
async def remove_friend(friend_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    await session.execute(delete(Friendship).where(
        or_((Friendship.user_id == user.id) & (Friendship.friend_id == friend_id),
            (Friendship.user_id == friend_id) & (Friendship.friend_id == user.id))
    ))
    await session.commit()
    return {"ok": True}


# ---- Duels ----

async def score(session: AsyncSession, user_id: int, metric: str, start, end) -> int:
    if metric == "xp":  # the duel bonus itself doesn't count towards other duels
        q = select(func.coalesce(func.sum(XpEvent.xp), 0)).where(
            XpEvent.user_id == user_id, XpEvent.created_at >= start, XpEvent.created_at < end, XpEvent.event_type != "duel_win")
    else:
        q = select(func.count(WorkoutLog.id)).where(
            WorkoutLog.user_id == user_id, WorkoutLog.completed_at >= start, WorkoutLog.completed_at < end)
    return int(await session.scalar(q) or 0)


def plural_days(n: int) -> str:
    return f"{n} {'день' if n % 10 == 1 and n % 100 != 11 else 'дня' if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else 'дней'}"


async def finish_duels(session: AsyncSession) -> int:
    """Close duels whose time is up: pick the winner, give the bonus, tell both. Called by the API and the bot."""
    done = 0
    for d in await session.scalars(select(Duel).where(Duel.status == "active", Duel.ends_at <= func.now()).with_for_update(skip_locked=True)):
        a, b = await session.get(User, d.challenger_id), await session.get(User, d.opponent_id)
        sa, sb = await score(session, a.id, d.metric, d.starts_at, d.ends_at), await score(session, b.id, d.metric, d.starts_at, d.ends_at)
        d.status, d.winner_id = "done", (a.id if sa > sb else b.id if sb > sa else None)
        for me, other, mine, theirs in ((a, b, sa, sb), (b, a, sb, sa)):
            result = ("🏆 Победа! +40 XP." if mine > theirs else "Ничья — оба молодцы." if mine == theirs
                      else f"В этот раз победа за {name(other)}. Реванш?")
            notify(session, me, f"⚔️ Дуэль с {name(other)} окончена: {mine} : {theirs} {METRICS[d.metric]}. {result}")
        await session.commit()
        if d.winner_id:
            await award_xp(session, d.winner_id, "duel_win", f"duel:{d.id}")
        done += 1
    return done


async def duel_out(session: AsyncSession, d: Duel, user: User) -> dict:
    other = await session.get(User, d.opponent_id if d.challenger_id == user.id else d.challenger_id)
    out = {"id": d.id, "metric": d.metric, "days": d.days, "status": d.status, "incoming": d.opponent_id == user.id,
           "rival": name(other), "rival_id": other.id,
           "ends_at": d.ends_at.isoformat() if d.ends_at else None,
           "result": None if d.status != "done" else "draw" if d.winner_id is None else "win" if d.winner_id == user.id else "loss"}
    if d.status in ("active", "done"):
        end = min(d.ends_at, clock.now())
        out["me"] = await score(session, user.id, d.metric, d.starts_at, end)
        out["them"] = await score(session, other.id, d.metric, d.starts_at, end)
    return out


@router.get("/duels")
async def duels(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    await finish_duels(session)
    rows = await session.scalars(
        select(Duel).where(or_(Duel.challenger_id == user.id, Duel.opponent_id == user.id), Duel.status != "declined")
        .order_by(Duel.created_at.desc()).limit(20)
    )
    return [await duel_out(session, d, user) for d in rows]


class DuelIn(BaseModel):
    friend_id: int
    metric: Literal["xp", "workouts"]
    days: Literal[3, 7]


@router.post("/duels")
async def challenge(body: DuelIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if not await session.get(Friendship, (user.id, body.friend_id)):
        raise HTTPException(404, "Сначала добавьте друга по ссылке")
    pair = or_((Duel.challenger_id == user.id) & (Duel.opponent_id == body.friend_id),
               (Duel.challenger_id == body.friend_id) & (Duel.opponent_id == user.id))
    if await session.scalar(select(Duel.id).where(pair, Duel.status.in_(("pending", "active"))).limit(1)):
        raise HTTPException(409, "С этим другом уже идёт дуэль")
    d = Duel(challenger_id=user.id, opponent_id=body.friend_id, metric=body.metric, days=body.days)
    session.add(d)
    goal = "больше XP" if body.metric == "xp" else "больше тренировок"
    notify(session, await session.get(User, body.friend_id),
           f"⚔️ {name(user)} вызывает вас на дуэль: кто наберёт {goal} за {plural_days(body.days)}. Принять можно в приложении: Прогресс → Друзья.")
    await session.commit()
    return await duel_out(session, d, user)


async def incoming(session: AsyncSession, duel_id: int, user: User) -> Duel:
    d = await session.get(Duel, duel_id)
    if d is None or d.opponent_id != user.id:
        raise HTTPException(404, "Дуэль не найдена")
    if d.status != "pending":
        raise HTTPException(409, "На этот вызов уже ответили")
    return d


@router.post("/duels/{duel_id}/accept")
async def accept(duel_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    d = await incoming(session, duel_id, user)
    d.status, d.starts_at = "active", clock.now()
    d.ends_at = d.starts_at + timedelta(days=d.days)
    notify(session, await session.get(User, d.challenger_id), f"⚔️ {name(user)} принял(а) вызов. Дуэль началась — {plural_days(d.days)}, вперёд!")
    await session.commit()
    return await duel_out(session, d, user)


@router.post("/duels/{duel_id}/decline")
async def decline(duel_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    d = await incoming(session, duel_id, user)
    d.status = "declined"
    await session.commit()
    return {"ok": True}


# ---- Share: the bot sends you a card with this week's results and your invite link, ready to forward ----

@router.post("/share")
async def share(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    waiting = await session.scalar(select(Outbox.id).where(Outbox.user_id == user.id, Outbox.kind == "share", Outbox.sent_at.is_(None)).limit(1))
    if not waiting:  # a double tap doesn't send two cards
        code, bot = await invite_code(session, user), bot_username()
        link = f"\n\nПрисоединяйся: https://t.me/{bot}?start=f{code}" if bot else ""
        notify(session, user, f"Моя неделя в Setly 💪{link}", kind="share")
        await session.commit()
    return {"ok": True}


async def pending_messages(session: AsyncSession, limit: int = 30) -> list[Outbox]:
    return list(await session.scalars(select(Outbox).where(Outbox.sent_at.is_(None)).order_by(Outbox.id).limit(limit)))


__all__ = ["router", "befriend", "finish_duels", "pending_messages"]
