"""The challenge of the month: one theme for everyone (it changes each month), a leaderboard of all participants and
of friends, XP for reaching the goal, and a Stories card at the end.

The score counts days, not amounts, so a beginner and an athlete compete on consistency: days with a workout, with a
full food diary, with the water goal, with enough protein. Nothing to tick by hand — it comes from what's logged.
Months follow UTC dates for the boundaries; each day is counted in the user's own time zone.
"""
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from backend.api.daily import water_goal
from backend.api.deps import get_or_create_user, telegram_user
from backend.api.leagues import short
from backend.api.social import name, notify
from backend.api.stats import targets
from backend.database.db import AsyncSession, get_session
from backend.database.models import FoodLog, Friendship, MonthEntry, Product, Profile, User, WaterIntake, WorkoutLog
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")
THEMES = [
    {"key": "workouts", "emoji": "🏋️", "title": "Месяц тренировок", "goal": 12, "unit": "с тренировкой",
     "hint": "Считаются дни с завершённой тренировкой — любой: в зале, дома, на улице."},
    {"key": "diary", "emoji": "📒", "title": "Месяц честного дневника", "goal": 25, "unit": "с дневником",
     "hint": "Считаются дни, когда записано всё за день — от 800 ккал."},
    {"key": "water", "emoji": "💧", "title": "Месяц воды", "goal": 20, "unit": "с нормой воды",
     "hint": "Считаются дни, когда выпита твоя норма воды."},
    {"key": "protein", "emoji": "🥩", "title": "Месяц белка", "goal": 20, "unit": "с нормой белка",
     "hint": "Считаются дни, когда съедено 90 % твоей нормы белка и больше."},
]
TOP = 10
FULL_DAY = 800
STORY_DAYS = 7  # the first week of a month still shares last month's final


def days(n: int, t: dict) -> str:
    """"3 дня с тренировкой": the unit is what follows the day count."""
    from backend.bot.cards import plural_days

    return f"{n} {plural_days(n)} {t['unit']}"


def month_of(d: date) -> date:
    return d.replace(day=1)


def next_month(m: date) -> date:
    return (m + timedelta(days=32)).replace(day=1)


def theme(m: date) -> dict:
    return THEMES[(m.year * 12 + m.month) % len(THEMES)]


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def tz_of(u: User):
    try:
        return ZoneInfo(u.device_tz) if u.device_tz else timezone.utc
    except Exception:
        return timezone.utc


async def scores(session: AsyncSession, m: date, users: list[User]) -> dict[int, int]:
    """Days that count this month for each user. shortcut: recomputed per request; cache per hour past a few thousand people."""
    if not users:
        return {}
    key, ids, end = theme(m)["key"], [u.id for u in users], next_month(m)
    zones = {u.id: tz_of(u) for u in users}
    a = datetime.combine(m - timedelta(days=1), time(0), tzinfo=timezone.utc)  # a day of slack each side for time zones
    b = datetime.combine(end + timedelta(days=1), time(0), tzinfo=timezone.utc)
    local = lambda uid, at: at.astimezone(zones[uid]).date()  # noqa: E731
    days: dict[int, set] = {i: set() for i in ids}
    if key == "workouts":
        for uid, at in await session.execute(select(WorkoutLog.user_id, WorkoutLog.completed_at).where(
                WorkoutLog.user_id.in_(ids), WorkoutLog.completed_at >= a, WorkoutLog.completed_at < b)):
            days[uid].add(local(uid, at))
    elif key == "water":
        profiles = {p.user_id: p for p in await session.scalars(select(Profile).where(Profile.user_id.in_(ids)))}
        for uid, day, ml in await session.execute(select(WaterIntake.user_id, WaterIntake.day, WaterIntake.ml).where(
                WaterIntake.user_id.in_(ids), WaterIntake.day >= m, WaterIntake.day < end)):
            if ml >= water_goal(profiles.get(uid)):
                days[uid].add(day)
    else:
        sums: dict[tuple[int, date], list[float]] = {}
        for uid, at, g, kcal, protein in await session.execute(
                select(FoodLog.user_id, FoodLog.logged_at, FoodLog.amount_g, Product.kcal, Product.protein_g)
                .join(Product, Product.id == FoodLog.product_id)
                .where(FoodLog.user_id.in_(ids), FoodLog.logged_at >= a, FoodLog.logged_at < b)):
            s = sums.setdefault((uid, local(uid, at)), [0.0, 0.0])
            s[0] += kcal * g / 100
            s[1] += protein * g / 100
        need = {}
        if key == "protein":
            need = {p.user_id: targets(p)["protein"] * 0.9 for p in await session.scalars(select(Profile).where(Profile.user_id.in_(ids)))}
        for (uid, day), (kcal, protein) in sums.items():
            if (kcal >= FULL_DAY) if key == "diary" else (uid in need and protein >= need[uid]):
                days[uid].add(day)
    return {uid: sum(1 for d in ds if m <= d < end) for uid, ds in days.items()}


async def board(session: AsyncSession, m: date) -> list[tuple[User, MonthEntry, int]]:
    """Participants by score, most first; ties: who joined first."""
    rows = list(await session.execute(select(User, MonthEntry).join(MonthEntry, MonthEntry.user_id == User.id)
                                      .where(MonthEntry.month == m).order_by(MonthEntry.joined_at, User.id)))
    sc = await scores(session, m, [u for u, _ in rows])
    return sorted(((u, e, sc[u.id]) for u, e in rows), key=lambda r: -r[2])


def places(rows: list) -> list[int]:
    """Equal days, equal place (1, 2, 2, 4): order among a tie is only who joined first."""
    out = []
    for i, r in enumerate(rows):
        out.append(out[-1] if i and r[2] == rows[i - 1][2] else i + 1)
    return out


def theme_out(m: date) -> dict:
    t = theme(m)
    return {**t, "month": m.isoformat(), "ends_at": datetime.combine(next_month(m), time(0), tzinfo=timezone.utc).isoformat()}


@router.get("/month")
async def month(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    m = month_of(utc_today())
    rows = await board(session, m)
    friends = set(await session.scalars(select(Friendship.friend_id).where(Friendship.user_id == user.id)))
    me = next((i for i, (u, _, _) in enumerate(rows) if u.id == user.id), None)
    place = places(rows)
    row = lambda i, u, s, full: {"rank": place[i], "name": "Ты" if u.id == user.id else (name(u) if full else short(u)),  # noqa: E731
                                 "score": s, "me": u.id == user.id}
    out = {**theme_out(m), "joined": me is not None, "total": len(rows),
           "top": [row(i, u, s, False) for i, (u, _, s) in enumerate(rows[:TOP])],
           "friends": [{**row(i, u, s, True), "rank": k + 1} for k, (i, (u, _, s)) in
                       enumerate((i, r) for i, r in enumerate(rows) if r[0].id in friends or r[0].id == user.id)]
           if friends else [],
           "me": None, "last": None}
    if me is not None:
        out["me"] = {"rank": place[me], "score": rows[me][2], "top_percent": max(1, round(place[me] / len(rows) * 100))}
    last = await session.get(MonthEntry, (user.id, month_of(m - timedelta(days=1))))
    if last and last.closed:
        t = theme(last.month)
        out["last"] = {"month": last.month.isoformat(), "emoji": t["emoji"], "title": t["title"], "unit": t["unit"], "goal": t["goal"],
                       "score": last.score, "rank": last.rank, "total": last.total, "done": (last.score or 0) >= t["goal"]}
    return out


@router.post("/month/join")
async def join(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    m = month_of(utc_today())
    if not await session.get(MonthEntry, (user.id, m)):
        session.add(MonthEntry(user_id=user.id, month=m))
        await session.commit()
    return await month(tg, session)


async def story_numbers(session: AsyncSession, user: User) -> dict:
    """For the Stories card: last month's final during the first week of a new month, otherwise this month so far."""
    today = utc_today()
    m = month_of(today)
    last = await session.get(MonthEntry, (user.id, month_of(m - timedelta(days=1))))
    if last and last.closed and today.day <= STORY_DAYS:
        t = theme(last.month)
        return {**t, "score": last.score or 0, "rank": last.rank, "total": last.total, "final": True}
    rows = await board(session, m)
    me = next((i for i, (u, _, _) in enumerate(rows) if u.id == user.id), None)
    if me is None:
        raise HTTPException(404, "Сначала присоединись к челленджу месяца")
    return {**theme(m), "score": rows[me][2], "rank": places(rows)[me], "total": len(rows), "final": False}


async def finish_months(session: AsyncSession) -> int:
    """Close past months: final places, XP for the goal, a message with the new theme. Run by the bot every minute."""
    current = month_of(utc_today())
    months = list(await session.scalars(select(MonthEntry.month).where(MonthEntry.closed.is_(False), MonthEntry.month < current)
                                        .group_by(MonthEntry.month)))
    for m in months:
        rows = await board(session, m)
        t, new, n, place = theme(m), theme(current), len(rows), places(rows)
        for i, (u, e, s) in enumerate(rows):
            if e.closed:  # already told (a late joiner's month closed again): keep their final
                continue
            e.closed, e.score, e.rank, e.total = True, s, place[i], n
            top = max(1, round(place[i] / n * 100))
            text = f"{t['emoji']} «{t['title']}» закончился: {days(s, t)}, {place[i]}-е место из {n}" + (f" (топ-{top} %)" if n >= 10 else "") + "."
            if s >= t["goal"]:
                xp = await award_xp(session, u.id, "month_done", f"month:{m.isoformat()}", commit=False)
                text += f" Цель {t['goal']} взята — +{xp} XP! 🎉"
            text += (f"\n\nКарточка для истории — в приложении: Прогресс → Челлендж.\nНовый челлендж уже идёт: {new['emoji']} «{new['title']}», "
                     f"цель — {days(new['goal'], new)}.")
            notify(session, u, text)
        await session.commit()
    return len(months)
