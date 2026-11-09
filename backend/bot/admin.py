"""/stats for the owner: how many people came, came back, and what they use. Only for ADMIN_IDS from .env."""
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select

from backend.database.models import (
    AiRequest, Duel, FoodLog, Friendship, Profile, User, Visit, WaterIntake, WorkoutLog,
)


def pct(part: int, whole: int) -> str:
    return f"{round(100 * part / whole)}%" if whole else "—"


async def retention(session, after_days: int, cohort_days: int, today: date) -> tuple[int, int]:
    """Of users who joined in the cohort window (old enough to be measured), how many opened the app
    again `after_days` or more days after joining."""
    first = select(Visit.user_id, func.min(Visit.day).label("d0")).group_by(Visit.user_id).subquery()
    cohort = select(first.c.user_id, first.c.d0).where(
        first.c.d0 <= today - timedelta(days=after_days), first.c.d0 > today - timedelta(days=after_days + cohort_days)
    ).subquery()
    total = await session.scalar(select(func.count()).select_from(cohort)) or 0
    back = await session.scalar(
        select(func.count(func.distinct(cohort.c.user_id))).join(Visit, Visit.user_id == cohort.c.user_id)
        .where(Visit.day >= cohort.c.d0 + after_days)
    ) or 0
    return back, total


async def summary(session, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    today, week = now.date(), now - timedelta(days=7)
    count = lambda q: session.scalar(q)  # noqa: E731
    users = await count(select(func.count(User.id)))
    registered = await count(select(func.count(Profile.user_id)))
    new_7 = await count(select(func.count(User.id)).where(User.created_at >= week))
    new_1 = await count(select(func.count(User.id)).where(User.created_at >= now - timedelta(days=1)))
    dau = await count(select(func.count()).where(Visit.day == today))
    wau = await count(select(func.count(func.distinct(Visit.user_id))).where(Visit.day > today - timedelta(days=7)))
    d1, d1n = await retention(session, 1, 14, today)
    d7, d7n = await retention(session, 7, 14, today)
    meals = await count(select(func.count(FoodLog.id)).where(FoodLog.logged_at >= week))
    eaters = await count(select(func.count(func.distinct(FoodLog.user_id))).where(FoodLog.logged_at >= week))
    workouts = await count(select(func.count(WorkoutLog.id)).where(WorkoutLog.completed_at >= week))
    trainees = await count(select(func.count(func.distinct(WorkoutLog.user_id))).where(WorkoutLog.completed_at >= week))
    drinkers = await count(select(func.count(func.distinct(WaterIntake.user_id))).where(WaterIntake.day > today - timedelta(days=7)))
    ai = await count(select(func.count(AiRequest.id)).where(AiRequest.created_at >= week))
    pairs = (await count(select(func.count()).select_from(Friendship))) // 2
    duels = await count(select(func.count(Duel.id)).where(Duel.created_at >= week))
    return "\n".join([
        "📊 <b>Setly — статистика</b>",
        "",
        f"👥 Пользователей: <b>{users}</b>, заполнили анкету: {registered} ({pct(registered, users)})",
        f"🆕 Новых: за сутки {new_1}, за 7 дней {new_7}",
        f"📱 Открывали приложение: сегодня {dau}, за 7 дней {wau}",
        f"🔁 Вернулись на следующий день: {pct(d1, d1n)} ({d1} из {d1n})",
        f"🔁 Вернулись через неделю: {pct(d7, d7n)} ({d7} из {d7n})",
        "",
        "<b>За 7 дней</b>",
        f"🍽 Записей еды: {meals} (вели дневник {eaters} чел.)",
        f"🏋️ Тренировок: {workouts} ({trainees} чел.)",
        f"💧 Отмечали воду: {drinkers} чел.",
        f"🤖 AI-запросов: {ai}",
        f"🤝 Пар друзей: {pairs}, новых дуэлей: {duels}",
        "",
        f"<i>Возврат считается по тем, кто пришёл за последние 2 недели. {now:%d.%m %H:%M} UTC</i>",
    ])
