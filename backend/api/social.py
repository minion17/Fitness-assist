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

from backend.api.daily import active_days, is_active, streak_state
from backend.api.deps import get_or_create_user, telegram_user
from backend.core import clock
from backend.core.config import settings
from backend.core.gamification import BOOST_HOURS, MAX_INVITE_REWARDS, level_progress
from backend.database.db import AsyncSession, get_session
from backend.database.models import Duel, Friendship, Outbox, Profile, User, WorkoutLog, WorkoutSet, XpEvent
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")
USERNAME_FILE = Path(__file__).resolve().parents[2] / ".bot_username"  # written by the bot at startup
MAX_FRIENDS = 100
METRICS = {"xp": "XP", "workouts": "тренировок"}

# Anti-abuse. A second (fake) Telegram account costs nothing, so rewards go only for real, sustained activity:
INVITE_ACTIVE_DAYS = 3        # an invited friend earns the inviter XP after 3 active days within 14 days of joining
INVITE_WINDOW_DAYS = 14
MIN_ACCOUNT_AGE_DAYS = 7      # both duelists must have used Setly for a week before the duel starts
WIN_MIN = {"xp": 25, "workouts": 1}    # per 3 days: the winner must really have done something...
LOSER_MIN = {"xp": 10, "workouts": 0}  # ...and so must the loser (an idle fake opponent gives no reward)
WORKOUT_MIN_SETS = 3          # a duel workout counts with 3+ sets, at most one per day
PAIR_COOLDOWN_DAYS = 14       # one rewarded win per pair of friends per two weeks
MAX_REWARDED_WINS_PER_WEEK = 2
MAX_PENDING_CHALLENGES = 3


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
    new = me is None
    if new:
        me = User(telegram_id=telegram_id, first_name=first_name)
        session.add(me)
        await session.flush()
    if await session.get(Friendship, (me.id, inviter.id)):
        return None
    if await session.scalar(select(func.count()).where(Friendship.user_id == inviter.id)) >= MAX_FRIENDS:
        return None
    session.add_all([Friendship(user_id=me.id, friend_id=inviter.id), Friendship(user_id=inviter.id, friend_id=me.id)])
    if new:  # only people who never used Setly before count as invited (no re-inviting existing friends for XP)
        me.invited_by_id = inviter.id
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
                      "week_xp": xp.get(u.id, 0), "streak": streak,
                      "registered": await session.get(Profile, u.id) is not None})
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


async def reward_invites(session: AsyncSession) -> int:
    """Inviters get XP once their invited friend has really used Setly: registered and active on INVITE_ACTIVE_DAYS
    different days within INVITE_WINDOW_DAYS of joining (up to MAX_INVITE_REWARDS friends). Run by the bot."""
    since = clock.now() - timedelta(days=INVITE_WINDOW_DAYS)
    given = 0
    for user in await session.scalars(
        select(User).join(Profile, Profile.user_id == User.id).where(User.invited_by_id.is_not(None), User.created_at >= since)
    ):
        key = f"invite:{user.id}"
        if await session.scalar(select(XpEvent.id).where(XpEvent.event_key == key)):
            continue
        clock.use_tz(user.timezone or user.device_tz)
        days = await active_days(session, user, clock.local(user.created_at).date())
        clock.use_tz(None)
        if sum(map(is_active, days.values())) < INVITE_ACTIVE_DAYS:
            continue
        inviter = await session.get(User, user.invited_by_id)
        if inviter is None or await session.scalar(
            select(func.count()).where(XpEvent.user_id == inviter.id, XpEvent.event_type == "friend_invited")
        ) >= MAX_INVITE_REWARDS:
            continue
        if await award_xp(session, inviter.id, "friend_invited", key):
            notify(session, inviter, f"🎉 {name(user)} уже {INVITE_ACTIVE_DAYS} дня с Setly по вашему приглашению — +50 XP!")
            await session.commit()
            given += 1
    return given


# ---- Duels ----

async def score(session: AsyncSession, user_id: int, metric: str, start, end) -> int:
    if metric == "xp":  # the duel bonus itself doesn't count towards other duels
        q = select(func.coalesce(func.sum(XpEvent.xp), 0)).where(
            XpEvent.user_id == user_id, XpEvent.created_at >= start, XpEvent.created_at < end, XpEvent.event_type != "duel_win")
    else:  # real workouts only: 3+ sets, at most one counted per day
        real = (select(WorkoutLog.completed_at).join(WorkoutSet, WorkoutSet.workout_log_id == WorkoutLog.id)
                .where(WorkoutLog.user_id == user_id, WorkoutLog.completed_at >= start, WorkoutLog.completed_at < end)
                .group_by(WorkoutLog.id).having(func.count(WorkoutSet.id) >= WORKOUT_MIN_SETS).subquery())
        q = select(func.count(func.distinct(func.date(real.c.completed_at))))
    return int(await session.scalar(q) or 0)


async def no_reward_reason(session: AsyncSession, d: Duel, winner: User, loser: User, won: int, lost: int) -> str | None:
    """Why this win earns nothing (anti-abuse), or None if it is rewarded."""
    scale = d.days / 3
    for u in (winner, loser):
        if not await session.get(Profile, u.id) or u.created_at > d.starts_at - timedelta(days=MIN_ACCOUNT_AGE_DAYS):
            return "награда — только когда оба пользуются Setly хотя бы неделю"
    if won < WIN_MIN[d.metric] * scale:
        return "для награды победителю нужно больше активности"
    if lost < LOSER_MIN[d.metric] * scale:
        return "соперник почти не участвовал"
    pair = or_((Duel.challenger_id == d.challenger_id) & (Duel.opponent_id == d.opponent_id),
               (Duel.challenger_id == d.opponent_id) & (Duel.opponent_id == d.challenger_id))
    if await session.scalar(select(Duel.id).where(pair, Duel.rewarded, Duel.ends_at > d.ends_at - timedelta(days=PAIR_COOLDOWN_DAYS)).limit(1)):
        return f"с этим другом награда бывает раз в {PAIR_COOLDOWN_DAYS} дней"
    if await session.scalar(select(func.count()).where(Duel.winner_id == winner.id, Duel.rewarded,
                                                       Duel.ends_at > d.ends_at - timedelta(days=7))) >= MAX_REWARDED_WINS_PER_WEEK:
        return f"наград за победы — не больше {MAX_REWARDED_WINS_PER_WEEK} в неделю"
    return None


def plural_days(n: int) -> str:
    return f"{n} {'день' if n % 10 == 1 and n % 100 != 11 else 'дня' if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else 'дней'}"


async def finish_duels(session: AsyncSession) -> int:
    """Close duels whose time is up: pick the winner, give the bonus, tell both. Called by the API and the bot."""
    done = 0
    for d in await session.scalars(select(Duel).where(Duel.status == "active", Duel.ends_at <= func.now()).with_for_update(skip_locked=True)):
        a, b = await session.get(User, d.challenger_id), await session.get(User, d.opponent_id)
        sa, sb = await score(session, a.id, d.metric, d.starts_at, d.ends_at), await score(session, b.id, d.metric, d.starts_at, d.ends_at)
        d.status, d.winner_id = "done", (a.id if sa > sb else b.id if sb > sa else None)
        why = None
        if d.winner_id:
            winner, loser = (a, b) if d.winner_id == a.id else (b, a)
            why = await no_reward_reason(session, d, winner, loser, max(sa, sb), min(sa, sb))
            d.rewarded = why is None
        for me, other, mine, theirs in ((a, b, sa, sb), (b, a, sb, sa)):
            result = ("Ничья — оба молодцы." if mine == theirs else f"В этот раз победа за {name(other)}. Реванш?" if mine < theirs
                      else f"🏆 Победа! +40 XP и бустер ×1,5 XP на {BOOST_HOURS} часа." if d.rewarded
                      else f"🏆 Победа! Без награды: {why}.")
            notify(session, me, f"⚔️ Дуэль с {name(other)} окончена: {mine} : {theirs} {METRICS[d.metric]}. {result}")
        await session.commit()
        if d.rewarded and await award_xp(session, d.winner_id, "duel_win", f"duel:{d.id}"):
            winner = await session.get(User, d.winner_id)
            if not (winner.boost_until and winner.boost_until > clock.now()):  # an active boost isn't extended
                winner.boost_until = clock.now() + timedelta(hours=BOOST_HOURS)
            await session.commit()
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
    if not await session.get(Profile, user.id):
        raise HTTPException(403, "Заполните анкету, чтобы участвовать в дуэлях")
    if not await session.get(Profile, body.friend_id):
        raise HTTPException(403, "Друг ещё не заполнил анкету — дуэли только между зарегистрированными")
    if await session.scalar(select(func.count()).where(Duel.challenger_id == user.id, Duel.status == "pending")) >= MAX_PENDING_CHALLENGES:
        raise HTTPException(429, "Дождитесь ответа на уже отправленные вызовы")
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


__all__ = ["router", "befriend", "finish_duels", "pending_messages", "reward_invites"]
