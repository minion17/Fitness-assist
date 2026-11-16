"""Weekly leagues: groups of up to 20 people of the same tier compete by XP earned this week (Monday–Sunday, UTC).
Top 5 go up a tier, bottom 5 go down. You join when you first open the league in a week, so idle accounts don't
take places."""
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.social import name, notify
from backend.database.db import AsyncSession, get_session
from backend.database.models import League, LeagueMember, User, XpEvent

router = APIRouter(prefix="/api")
TIERS = ["Бронза", "Серебро", "Золото", "Платина", "Алмаз"]
SIZE = 20
MOVE = 5  # promoted / demoted per group
MIN_TO_DEMOTE = 10  # a small group only promotes: being last of 4 shouldn't cost a tier


def week_start(now: datetime | None = None) -> date:
    d = (now or datetime.now(timezone.utc)).date()
    return d - timedelta(days=d.weekday())


def bounds(start: date) -> tuple[datetime, datetime]:
    a = datetime.combine(start, time(0), tzinfo=timezone.utc)
    return a, a + timedelta(days=7)


async def standings(session: AsyncSession, league: League) -> list[tuple[User, int]]:
    """Members by this week's XP, most first; ties: who joined earlier keeps the place (stable by user id)."""
    a, b = bounds(league.week_start)
    xp = (select(func.coalesce(func.sum(XpEvent.xp), 0)).where(XpEvent.user_id == User.id, XpEvent.created_at >= a,
                                                               XpEvent.created_at < b).scalar_subquery())
    rows = await session.execute(select(User, xp).join(LeagueMember, LeagueMember.user_id == User.id)
                                 .where(LeagueMember.league_id == league.id).order_by(xp.desc(), User.id))
    return [(u, int(x)) for u, x in rows]


async def my_league(session: AsyncSession, user: User) -> League:
    """This week's group, joining one (an open group of my tier, or a new one) on the first visit."""
    start = week_start()
    league = await session.scalar(select(League).join(LeagueMember, LeagueMember.league_id == League.id)
                                  .where(LeagueMember.user_id == user.id, League.week_start == start))
    if league:
        return league
    size = select(func.count()).where(LeagueMember.league_id == League.id).scalar_subquery()
    # shortcut: two people joining the same last place at once can make a group of 21; harmless
    league = await session.scalar(select(League).where(League.week_start == start, League.tier == user.league_tier,
                                                       size < SIZE).order_by(League.id).limit(1))
    if league is None:
        league = League(week_start=start, tier=user.league_tier)
        session.add(league)
        await session.flush()
    session.add(LeagueMember(league_id=league.id, user_id=user.id))
    await session.commit()
    return league


def short(u: User) -> str:
    """Strangers see a first name and nothing else."""
    return name(u).split()[0][:20]


@router.get("/league")
async def league(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    lg = await my_league(session, user)
    rows = await standings(session, lg)
    n = len(rows)
    return {
        "tier": lg.tier, "tier_name": TIERS[lg.tier], "next_tier": TIERS[lg.tier + 1] if lg.tier < len(TIERS) - 1 else None,
        "ends_at": bounds(lg.week_start)[1].isoformat(), "promote": MOVE if lg.tier < len(TIERS) - 1 else 0,
        "demote": MOVE if lg.tier > 0 and n >= MIN_TO_DEMOTE else 0,
        "members": [{"rank": i + 1, "name": short(u) if u.id != user.id else "Вы", "xp": x, "me": u.id == user.id}
                    for i, (u, x) in enumerate(rows)],
    }


async def finish_leagues(session: AsyncSession) -> int:
    """Close the groups of past weeks: move tiers and tell everyone how it went. Run by the bot every minute."""
    done = 0
    for lg in list(await session.scalars(select(League).where(League.closed.is_(False), League.week_start < week_start()))):
        rows = await standings(session, lg)
        n, top = len(rows), len(TIERS) - 1
        for i, (u, x) in enumerate(rows):
            place = f"{i + 1}-е место из {n} в лиге «{TIERS[lg.tier]}» ({x} XP)"
            if i < MOVE and lg.tier < top and x > 0:
                u.league_tier = lg.tier + 1
                notify(session, u, f"🏆 Неделя закончилась: {place}. Поднимаетесь в лигу «{TIERS[lg.tier + 1]}»!")
            elif n >= MIN_TO_DEMOTE and i >= n - MOVE and lg.tier > 0:
                u.league_tier = lg.tier - 1
                notify(session, u, f"Неделя закончилась: {place}. Опускаетесь в «{TIERS[lg.tier - 1]}» — на этой неделе можно вернуться.")
            elif x > 0:
                notify(session, u, f"Неделя закончилась: {place}. Остаётесь в лиге — новая неделя уже началась.")
        lg.closed = True
        await session.commit()
        done += 1
    return done
