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


ACTIVITY_RU = {"low": "сидячий образ жизни", "light": "лёгкая (1–2 дня в неделю)", "moderate": "умеренная (3–5 дней в неделю)",
               "high": "высокая (6–7 дней в неделю)", "very_high": "очень высокая (физический труд и спорт)"}
ALLERGY_RU = {"dairy": "молочное", "eggs": "яйца", "gluten": "глютен", "nuts": "орехи", "fish": "рыба"}
INJURY_RU = {"knees": "колени", "back": "спина", "shoulders": "плечи", "other": "другое"}
EFFORT_RU = {"easy": "легко", "ok": "нормально", "hard": "тяжело"}
MEAL_RU = {"breakfast": "Завтрак", "lunch": "Обед", "dinner": "Ужин", "snack": "Перекус"}
DIARY_DAYS = 14  # the itemised food diary covers the last two weeks of the period
FULL_DAY = 800  # kcal: a day with less was probably not logged completely


def bmi(weight: float | None, height_cm: int | None) -> float | None:
    return round(weight / (height_cm / 100) ** 2, 1) if weight and height_cm else None


async def gather(session: AsyncSession, user: User, days: int) -> dict:
    """Everything the report shows, in the user's calendar (call with their zone set)."""
    from backend.api.energy import measure, slope
    from backend.api.fasting import eat_to
    from backend.api.daily import water_goal
    from backend.core.nutrition import daily_targets, maintenance
    from backend.database.models import DailyCheckin, FastingPlan, FoodLog, Product

    until = clock.today()
    since = until - timedelta(days=days - 1)
    start, end = clock.local_start(since), clock.local_start(until + timedelta(days=1))
    series = await daily_series(session, user, since, until)
    profile = await session.get(Profile, user.id)
    t = targets(profile)

    # --- patient and norms
    person = norms = None
    if profile:
        age = until.year - profile.birth_year
        bmr = round(10 * profile.weight_kg + 6.25 * profile.height_cm - 5 * age + (5 if profile.sex == "male" else -161))
        est, _, _ = await measure(session, user, profile)
        fast = await session.get(FastingPlan, user.id)
        person = {"sex": "мужской" if profile.sex == "male" else "женский", "age": age, "height": profile.height_cm,
                  "goal": GOAL_RU.get(OLD_GOALS.get(profile.goal, profile.goal), profile.goal),
                  "activity": ACTIVITY_RU.get(profile.activity, profile.activity),
                  "target_weight": profile.target_weight_kg,
                  "allergies": ", ".join(ALLERGY_RU.get(a, a) for a in profile.allergies or []) or None,
                  "injury": INJURY_RU.get(profile.injury, profile.injury) if profile.injury else None,
                  "training_days": len(profile.training_days or []) or None,
                  "fasting": fast and f"{fast.hours}:{24 - fast.hours}, окно питания {fast.eat_from}–{eat_to(fast)}"}
        formula = daily_targets(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity, profile.goal)
        norms = {"bmr": bmr, "maintenance": maintenance(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity),
                 "measured": est and est["tdee"], "formula_kcal": formula["calories"], **t,
                 "source": "по реальному расходу (дневник и вес)" if profile.kcal_override else "по формуле Миффлина — Сан Жеора",
                 "protein_per_kg": round(t["protein"] / profile.weight_kg, 1)}

    # --- nutrition by day
    logged = [s for s in series if s["kcal"] > 0]
    full = [s for s in logged if s["kcal"] >= FULL_DAY]
    avg = lambda rows, k: sum(r[k] for r in rows) / len(rows) if rows else 0  # noqa: E731
    in_norm = sum(1 for s in logged if t and abs(s["kcal"] - t["calories"]) <= 0.1 * t["calories"])
    rows = list(await session.execute(
        select(FoodLog, Product).join(Product, Product.id == FoodLog.product_id)
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= start, FoodLog.logged_at < end).order_by(FoodLog.logged_at)))
    times: dict = {}
    foods: dict = {}
    diary_from = until - timedelta(days=min(DIARY_DAYS, days) - 1)
    diary: dict = {}
    for log, p in rows:
        local = log.logged_at.astimezone(clock.tz())
        times.setdefault(local.date(), []).append(local.hour * 60 + local.minute)
        g = log.amount_g
        f = foods.setdefault(p.name, {"name": p.name, "days": set(), "grams": 0.0, "kcal": 0.0, "protein": 0.0})
        f["days"].add(local.date())
        f["grams"] += g
        f["kcal"] += p.kcal * g / 100
        f["protein"] += p.protein_g * g / 100
        if local.date() >= diary_from:
            diary.setdefault(local.date(), []).append({
                "time": f"{local:%H:%M}", "meal": MEAL_RU.get(log.meal_type, log.meal_type), "name": p.name, "grams": g,
                "kcal": p.kcal * g / 100, "protein": p.protein_g * g / 100, "fat": p.fat_g * g / 100, "carbs": p.carbs_g * g / 100})
    total_kcal = sum(f["kcal"] for f in foods.values()) or 1
    top = sorted(foods.values(), key=lambda f: -f["kcal"])[:10]
    firsts = [min(v) for v in times.values()]
    lasts = [max(v) for v in times.values()]
    hhmm = lambda m: f"{int(m) // 60:02d}:{int(m) % 60:02d}"  # noqa: E731
    kcal_avg = avg(full or logged, "kcal")
    macro_kcal = {k: avg(full or logged, k) * (9 if k == "fat" else 4) for k in ("protein", "fat", "carbs")}
    nutrition = {
        "days": len(logged), "full_days": len(full), "in_norm": in_norm,
        "kcal": kcal_avg, "protein": avg(full or logged, "protein"), "fat": avg(full or logged, "fat"), "carbs": avg(full or logged, "carbs"),
        "energy_pct": {k: round(v / max(sum(macro_kcal.values()), 1) * 100) for k, v in macro_kcal.items()},
        "protein_per_kg": profile and round(avg(full or logged, "protein") / profile.weight_kg, 1),
        "daily": [s["kcal"] for s in series],
        "timing": firsts and {"first": hhmm(sum(firsts) / len(firsts)), "last": hhmm(sum(lasts) / len(lasts)),
                              "window_h": round(sum(b - a for a, b in zip(firsts, lasts)) / len(firsts) / 60, 1)},
        "top": [{"name": f["name"], "days": len(f["days"]), "grams_per_day": f["grams"] / len(f["days"]),
                 "share": round(f["kcal"] / total_kcal * 100)} for f in top],
        "diary": sorted(diary.items()), "diary_days": min(DIARY_DAYS, days),
    }

    # --- body
    ms = list(await session.scalars(select(BodyMeasurement).where(
        BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on >= since, BodyMeasurement.measured_on <= until)
        .order_by(BodyMeasurement.measured_on)))
    fields = ("weight_kg", "waist_cm", "hips_cm", "chest_cm", "body_fat_pct")

    def edge(rows):  # first / last known value of each field
        return {f: next((getattr(m, f) for m in rows if getattr(m, f)), None) for f in fields}
    first, last = edge(ms), edge(list(reversed(ms)))
    height = profile and profile.height_cm
    for e in (first, last):
        e["bmi"] = bmi(e["weight_kg"], height)
        e["whtr"] = round(e["waist_cm"] / height, 2) if e["waist_cm"] and height else None
        e["whr"] = round(e["waist_cm"] / e["hips_cm"], 2) if e["waist_cm"] and e["hips_cm"] else None
    points = [((m.measured_on - since).days, m.weight_kg) for m in ms if m.weight_kg]
    weekly = round(slope(points) * 7, 2) if len(points) >= 3 and points[-1][0] - points[0][0] >= 7 else None

    # --- activity, water, wellbeing
    logs = list(await session.scalars(select(WorkoutLog).options(selectinload(WorkoutLog.sets)).where(
        WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None), WorkoutLog.completed_at >= start,
        WorkoutLog.completed_at < end).order_by(WorkoutLog.completed_at)))

    def minutes(w):
        m = (w.completed_at - w.started_at).total_seconds() / 60
        return round(m) if 3 <= m <= 300 else None  # a workout left open overnight isn't 9 hours long
    sessions = [{"date": w.completed_at.astimezone(clock.tz()).date(), "title": w.title or "Тренировка", "sets": len(w.sets),
                 "minutes": minutes(w), "volume": sum((s.weight_kg or 0) * (s.reps or 0) for s in w.sets),
                 "effort": EFFORT_RU.get(w.effort or "")} for w in logs]
    water = [s["water_ml"] for s in series if s["water_ml"]]
    goal_ml = water_goal(profile)
    checks = list(await session.scalars(select(DailyCheckin).where(
        DailyCheckin.user_id == user.id, DailyCheckin.day >= since, DailyCheckin.day <= until)))
    sleep = [c.sleep for c in checks if c.sleep]
    energy = [c.energy for c in checks if c.energy]
    return {
        "name": name(user), "since": since, "until": until, "span": days, "person": person, "norms": norms,
        # kept for the old shape: the profile line under the title
        "profile": {"goal": person["goal"], "height": profile.height_cm, "kcal": t["calories"], "protein": t["protein"],
                    "fat": t["fat"], "carbs": t["carbs"]} if person else None,
        "nutrition": nutrition,
        "days": [{**s, "date": since + timedelta(days=i)} for i, s in enumerate(series)],
        "body": {"points": points, "first": first, "last": last, "weekly": weekly,
                 "rows": [{"date": m.measured_on, **{f: getattr(m, f) for f in fields}} for m in ms]},
        "workouts": {"sessions": sessions, "sets": sum(s["sets"] for s in sessions),
                     "minutes": sum(s["minutes"] or 0 for s in sessions), "per_week": round(len(sessions) / days * 7, 1)},
        "water_ml": sum(water) / len(water) if water else 0, "water_goal": goal_ml,
        "water_days": sum(1 for w in water if w >= goal_ml),
        "wellbeing": {"answers": len(checks), "good_sleep": sum(1 for x in sleep if x >= 3), "sleep_n": len(sleep),
                      "energy": round(sum(energy) / len(energy), 1) if energy else None} if checks else None,
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
        raise HTTPException(429, "Отчёт уже готовится — загляни в чат с ботом")
    session.add(Outbox(telegram_id=user.telegram_id, kind="report", text=str(body.days), user_id=user.id))
    await session.commit()
    return {"ok": True}
