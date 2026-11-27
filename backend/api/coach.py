"""A coach sees a client's diary, workouts and weight — because the client invited them.

The client makes an invite link (t.me/<bot>?start=c<code>) and sends it to the coach; the coach opens it and gets the
client on their list. A coach with 20 clients sees them all on one screen (the week in numbers, who needs attention),
opens one for the last two weeks day by day, can get the client's PDF report, and on Monday morning gets one
Telegram message with everyone's week. The client sees who has access and can end it any time.
"""
import secrets
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.social import bot_username, name
from backend.api.stats import daily_series, targets
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import BodyMeasurement, CoachLink, Outbox, Profile, User, WorkoutLog, WorkoutSet

router = APIRouter(prefix="/api/coach")
MAX_COACHES = 3  # per client
MAX_CLIENTS = 100  # per coach
FULL_DAY = 800  # kcal: a day logged completely enough to judge
SUMMARY_AT = (0, 9)  # Monday 09:00 in the coach's zone


def link(code: str) -> str | None:
    bot = bot_username()
    return f"https://t.me/{bot}?start=c{code}" if bot else None


async def client_of(session: AsyncSession, coach: User, client_id: int) -> User:
    if not await session.scalar(select(CoachLink.id).where(CoachLink.coach_id == coach.id, CoachLink.client_id == client_id)):
        raise HTTPException(404, "Этот человек не давал тебе доступ")
    return await session.get(User, client_id)


# ---- the client's side

@router.post("/invite")
async def invite(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """A link for a coach (the same one until a coach takes it)."""
    user = await get_or_create_user(tg, session)
    taken = await session.scalar(select(func.count()).where(CoachLink.client_id == user.id, CoachLink.coach_id.is_not(None)))
    if taken >= MAX_COACHES:
        raise HTTPException(409, f"Тренеров может быть не больше {MAX_COACHES} — отключи кого-то в списке")
    open_link = await session.scalar(select(CoachLink).where(CoachLink.client_id == user.id, CoachLink.coach_id.is_(None)))
    if open_link is None:
        open_link = CoachLink(client_id=user.id, code=secrets.token_urlsafe(9)[:12].replace("-", "x").replace("_", "y"))
        session.add(open_link)
        await session.commit()
    return {"link": link(open_link.code), "code": open_link.code}


@router.get("/mine")
async def my_coaches(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    rows = await session.execute(select(CoachLink, User).join(User, User.id == CoachLink.coach_id)
                                 .where(CoachLink.client_id == user.id).order_by(CoachLink.accepted_at))
    return [{"id": cl.id, "name": name(u), "since": cl.accepted_at.date().isoformat() if cl.accepted_at else None} for cl, u in rows]


@router.delete("/links/{link_id}")
async def end_link(link_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Either side ends it: the client takes access back, or the coach drops the client."""
    user = await get_or_create_user(tg, session)
    cl = await session.get(CoachLink, link_id)
    if cl is None or user.id not in (cl.client_id, cl.coach_id):
        raise HTTPException(404, "Доступ не найден")
    other = await session.get(User, cl.coach_id if user.id == cl.client_id else cl.client_id) if cl.coach_id else None
    await session.delete(cl)
    if other:
        session.add(Outbox(telegram_id=other.telegram_id, text=(
            f"🔒 {name(user)} закрыл(а) тебе доступ к дневнику." if user.id == cl.client_id
            else f"🔒 Тренер {name(user)} больше не видит твой дневник.")))
    await session.commit()
    return {"ok": True}


async def accept(session: AsyncSession, code: str, coach: User) -> tuple[User | None, str]:
    """The coach opened the invite link: (the client, what to tell the coach)."""
    cl = await session.scalar(select(CoachLink).where(CoachLink.code == code))
    if cl is None:
        return None, "Ссылка устарела — попроси клиента прислать новую из Nextly: Профиль → Тренер."
    client = await session.get(User, cl.client_id)
    if cl.client_id == coach.id:
        return None, "Это ссылка для твоего тренера — перешли её ему."
    if cl.coach_id == coach.id:
        return client, f"{name(client)} уже у тебя в клиентах."
    if cl.coach_id is not None:
        return None, "По этой ссылке уже подключился другой тренер — попроси клиента прислать новую."
    if await session.scalar(select(CoachLink.id).where(CoachLink.client_id == cl.client_id, CoachLink.coach_id == coach.id)):
        await session.delete(cl)
        await session.commit()
        return client, f"{name(client)} уже у тебя в клиентах."
    if await session.scalar(select(func.count()).where(CoachLink.coach_id == coach.id)) >= MAX_CLIENTS:
        return None, f"У тебя уже {MAX_CLIENTS} клиентов — это предел."
    cl.coach_id, cl.accepted_at = coach.id, func.now()
    session.add(Outbox(telegram_id=client.telegram_id, text=(
        f"🤝 Тренер {name(coach)} подключился: теперь он видит твой дневник питания, тренировки и вес и по понедельникам "
        "получает сводку твоей недели. Закрыть доступ можно в любой момент: Профиль → Тренер.")))
    await session.commit()
    return client, (f"🤝 Готово: {name(client)} теперь у тебя в клиентах. Ты видишь дневник питания, тренировки и вес, а по "
                    "понедельникам в 9:00 я пришлю сводку недели по всем клиентам.")


# ---- the coach's side

async def week_of(session: AsyncSession, client: User, until: date) -> dict:
    """The client's last 7 days in numbers (their own calendar)."""
    clock.use_tz(client.device_tz)
    try:
        since = until - timedelta(days=6)
        days = await daily_series(session, client, since, until)
        profile = await session.get(Profile, client.id)
        t = targets(profile)
        full = [d for d in days if d["kcal"] >= FULL_DAY]
        avg = lambda k: round(sum(d[k] for d in full) / len(full)) if full else None  # noqa: E731
        weights = list(await session.execute(select(BodyMeasurement.measured_on, BodyMeasurement.weight_kg).where(
            BodyMeasurement.user_id == client.id, BodyMeasurement.weight_kg.is_not(None),
            BodyMeasurement.measured_on >= until - timedelta(days=13)).order_by(BodyMeasurement.measured_on)))
        last_any = await session.scalar(select(func.max(WorkoutLog.completed_at)).where(WorkoutLog.user_id == client.id))
        kcal = avg("kcal")
        out = {
            "id": client.id, "name": name(client), "goal": profile.goal if profile else None,
            "days_logged": len(full), "kcal": kcal, "norm": t and t["calories"],
            "kcal_pct": round(kcal / t["calories"] * 100) if kcal and t else None,
            "protein": avg("protein"), "protein_norm": t and t["protein"],
            "protein_per_kg": round(avg("protein") / profile.weight_kg, 1) if full and profile else None,
            "workouts": sum(d["workouts"] for d in days),
            "weight": weights[-1][1] if weights else None,
            "weight_change": round(weights[-1][1] - weights[0][1], 1) if len(weights) >= 2 else None,
            "last_workout": last_any.date().isoformat() if last_any else None,
        }
        # who needs a word from the coach this week
        out["flags"] = [f for f, on in (
            ("дневник почти пустой", len(full) <= 2),
            ("мало белка", bool(out["protein_norm"] and out["protein"] and out["protein"] < out["protein_norm"] * 0.75)),
            ("сильно выше нормы", bool(out["kcal_pct"] and out["kcal_pct"] > 115)),
            ("сильно ниже нормы", bool(out["kcal_pct"] and out["kcal_pct"] < 75)),
            ("без тренировок", out["workouts"] == 0),
        ) if on]
        return out
    finally:
        clock.use_tz(None)


@router.get("/clients")
async def clients(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """All clients on one screen: the last 7 days each, those needing attention first."""
    coach = await get_or_create_user(tg, session)
    rows = list(await session.execute(select(CoachLink.id, User).join(User, User.id == CoachLink.client_id)
                                      .where(CoachLink.coach_id == coach.id)))
    today = clock.today()
    out = [{**await week_of(session, u, today), "link_id": link_id} for link_id, u in rows]
    return sorted(out, key=lambda c: (-len(c["flags"]), c["name"]))


@router.get("/clients/{client_id}")
async def client_detail(client_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """One client: 14 days day by day, and the workouts with their sets."""
    coach = await get_or_create_user(tg, session)
    client = await client_of(session, coach, client_id)
    clock.use_tz(client.device_tz)
    try:
        until = clock.today()
        since = until - timedelta(days=13)
        days = await daily_series(session, client, since, until)
        logs = list(await session.scalars(select(WorkoutLog).where(
            WorkoutLog.user_id == client.id, WorkoutLog.completed_at >= clock.local_start(since)).order_by(WorkoutLog.completed_at.desc())))
        sets = {}
        for log_id, n, tonnage in await session.execute(
                select(WorkoutSet.workout_log_id, func.count(), func.coalesce(func.sum(WorkoutSet.weight_kg * WorkoutSet.reps), 0))
                .where(WorkoutSet.workout_log_id.in_([w.id for w in logs])).group_by(WorkoutSet.workout_log_id)):
            sets[log_id] = (n, round(tonnage))
        week = await week_of(session, client, until)
        profile = await session.get(Profile, client.id)
        return {
            **week, "targets": targets(profile),
            "days": [{"date": (since + timedelta(days=i)).isoformat(), **{k: round(v) if isinstance(v, (int, float)) else v for k, v in d.items()}} for i, d in enumerate(days)],
            "workouts": [{"date": clock.local(w.completed_at).date().isoformat(), "title": w.title,
                          "minutes": round((w.completed_at - w.started_at).total_seconds() / 60),
                          "sets": sets.get(w.id, (0, 0))[0], "tonnage": sets.get(w.id, (0, 0))[1], "effort": w.effort, "after": w.after} for w in logs],
        }
    finally:
        clock.use_tz(None)


class ReportIn(BaseModel):
    days: int = 30


@router.post("/clients/{client_id}/report")
async def client_report(client_id: int, body: ReportIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """The client's PDF report (the one for a doctor or a coach), sent to the coach's chat."""
    if body.days not in (7, 30, 90):
        raise HTTPException(422, "Период: 7, 30 или 90 дней")
    coach = await get_or_create_user(tg, session)
    client = await client_of(session, coach, client_id)
    session.add(Outbox(telegram_id=coach.telegram_id, kind="report", text=str(body.days), user_id=client.id))
    await session.commit()
    return {"ok": True}


def summary_line(c: dict) -> str:
    parts = [f"дневник {c['days_logged']}/7"]
    if c["kcal"]:
        parts.append(f"{c['kcal']:,} ккал".replace(",", " ") + (f" ({c['kcal_pct']} %)" if c["kcal_pct"] else ""))
    if c["protein_per_kg"]:
        parts.append(f"белок {c['protein_per_kg']:g} г/кг".replace(".", ","))
    parts.append(f"трен. {c['workouts']}")
    if c["weight_change"] is not None:
        parts.append(f"вес {'+' if c['weight_change'] > 0 else ''}{c['weight_change']:g} кг".replace(".", ","))
    flag = f" — ⚠️ {', '.join(c['flags'])}" if c["flags"] else ""
    return f"• {c['name']}: " + " · ".join(parts) + flag


async def weekly_summaries(session: AsyncSession) -> int:
    """Monday 09:00 in each coach's zone: one message with every client's last week. Run by the bot every minute."""
    sent = 0
    coach_ids = list(await session.scalars(select(CoachLink.coach_id).where(CoachLink.coach_id.is_not(None)).distinct()))
    for coach_id in coach_ids:
        coach = await session.get(User, coach_id)
        clock.use_tz(coach.device_tz)
        try:
            now = clock.now()
        finally:
            clock.use_tz(None)
        monday = now.date() - timedelta(days=now.weekday())
        links = list(await session.scalars(select(CoachLink).where(CoachLink.coach_id == coach_id)))
        if (now.weekday(), now.hour) < SUMMARY_AT or all(cl.summary_for == monday for cl in links):
            continue
        week = []
        for cl in links:
            cl.summary_for = monday
            week.append(await week_of(session, await session.get(User, cl.client_id), monday - timedelta(days=1)))
        week.sort(key=lambda c: (-len(c["flags"]), c["name"]))
        text = f"📋 Неделя твоих клиентов ({len(week)}):\n\n" + "\n".join(summary_line(c) for c in week)
        text += "\n\nПодробно по каждому — в приложении: Профиль → Мои клиенты."
        session.add(Outbox(telegram_id=coach.telegram_id, kind="coach", text=text[:4000]))
        sent += 1
    await session.commit()
    return sent
