"""Real expenditure from the user's own data: what they ate vs how their weight moved. Plus a forecast and a plateau hint.

Once there's enough data the norm follows it by itself: once a week `recalc` sets it from the measured expenditure
(the goal's weekly rate, as the formula norm), at most ±200 kcal a step, so one noisy week can't swing it.

Energy balance: 1 kg of body weight ≈ 7700 kcal. Over a few weeks, average intake − 7700 × (kg lost per day) = expenditure.
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.stats import daily_series
from backend.core import clock
from backend.core.nutrition import MIN_CALORIES, OLD_GOALS, daily_targets, goal_calories, maintenance
from backend.database.db import AsyncSession, get_session
from backend.database.models import BodyMeasurement, Profile

router = APIRouter(prefix="/api")
KCAL_PER_KG = 7700
WINDOW = 28  # days looked at
NEED_DAYS = 10  # fully logged days
NEED_WEIGHINS = 3
FULL_DAY = 800  # kcal: a day with less was probably not logged completely
LOSS = ("weight_loss", "fat_loss")
GAIN = ("muscle_gain", "mass_gain")


def slope(points: list[tuple[float, float]]) -> float:
    """Least-squares trend: kg per day. Steadier than first-vs-last weigh-in (water, salt, timing)."""
    n = len(points)
    mx, my = sum(x for x, _ in points) / n, sum(y for _, y in points) / n
    den = sum((x - mx) ** 2 for x, _ in points)
    return sum((x - mx) * (y - my) for x, y in points) / den if den else 0.0


def estimate(intakes: list[float], weighins: list[tuple[int, float]]) -> dict | None:
    """intakes: kcal of fully logged days; weighins: (day number, kg). None until there's enough data."""
    if len(intakes) < NEED_DAYS or len(weighins) < NEED_WEIGHINS or weighins[-1][0] - weighins[0][0] < NEED_DAYS:
        return None
    per_day = slope(weighins)
    intake = sum(intakes) / len(intakes)
    tdee = intake - per_day * KCAL_PER_KG
    if not 1000 <= tdee <= 6000:  # gaps in the diary or a scale error; don't show nonsense
        return None
    return {"tdee": round(tdee / 10) * 10, "intake": round(intake), "kg_per_week": round(per_day * 7, 2)}


def suggestion(tdee: int, goal: str, sex: str, weight_kg: float) -> int:
    """A norm from the real expenditure: the goal's weekly rate (% of body weight), as the formula norm does."""
    kcal = goal_calories(tdee, weight_kg, OLD_GOALS.get(goal, goal))
    return round(max(kcal, MIN_CALORIES[sex]) / 10) * 10


async def measure(session: AsyncSession, user, profile: Profile) -> tuple[dict | None, list, int]:
    """(estimate or None, weigh-ins as (day number, kg), fully logged days) over the last WINDOW days."""
    since = clock.today() - timedelta(days=WINDOW - 1)
    days = await daily_series(session, user, since, clock.today() - timedelta(days=1))  # today isn't finished yet
    intakes = [d["kcal"] for d in days if d["kcal"] >= FULL_DAY]
    weighins = [((m.measured_on - since).days, m.weight_kg) for m in await session.scalars(
        select(BodyMeasurement).where(BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on >= since,
                                      BodyMeasurement.weight_kg.is_not(None)).order_by(BodyMeasurement.measured_on))]
    return estimate(intakes, weighins), weighins, len(intakes)


def formula_norm(profile: Profile) -> int:
    return daily_targets(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity, profile.goal)["calories"]


AUTO_EVERY = timedelta(days=7)
AUTO_STEP = 200  # kcal: the most one recalculation moves the norm
AUTO_MIN_CHANGE = 50


async def recalc(session: AsyncSession, user, profile: Profile) -> dict | None:
    """The weekly recalculation. Returns {"old", "new", "tdee", "intake", "kg_per_week"} when the norm changed (and
    commits it); None when it's off, a week hasn't passed, there isn't enough data, or the norm is already right."""
    today = clock.today()
    if not profile.kcal_auto or (profile.kcal_auto_at and today - profile.kcal_auto_at < AUTO_EVERY):
        return None
    est, _, _ = await measure(session, user, profile)
    if est is None:
        return None
    old = profile.kcal_override or formula_norm(profile)
    target = suggestion(est["tdee"], profile.goal, profile.sex, profile.weight_kg)
    new = round(max(old - AUTO_STEP, min(old + AUTO_STEP, target)) / 10) * 10
    changed = abs(new - old) >= AUTO_MIN_CHANGE
    profile.kcal_auto_at = today
    if changed:
        profile.kcal_override = new
    await session.commit()
    return {"old": old, "new": new, **est} if changed else None


def recalc_text(r: dict) -> str:
    n = lambda x: f"{x:,}".replace(",", " ")
    w = r["kg_per_week"]
    trend = "почти не менялся" if abs(w) < 0.1 else f"шёл {'+' if w > 0 else '−'}{abs(w):g} кг в неделю".replace(".", ",")
    return (f"📊 Пересчитал норму по твоим данным: {n(r['old'])} → {n(r['new'])} ккал.\n\n"
            f"За 4 недели ты ел в среднем {n(r['intake'])} ккал, а вес {trend} — значит, на самом деле ты тратишь около "
            f"{n(r['tdee'])} ккал в день. Новая норма считается от этого расхода под твою цель"
            + (" (за раз меняю не больше чем на 200 ккал)." if abs(r["new"] - r["old"]) >= AUTO_STEP else ".")
            + "\n\nПересчитываю раз в неделю. Выключить можно в приложении: Прогресс → Тело → Реальный расход.")


@router.get("/insights/energy")
async def energy(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    today = clock.today()
    est, weighins, logged = await measure(session, user, profile)
    formula = maintenance(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity)
    out = {"ready": est is not None, "formula": formula, "days_logged": logged, "weighins": len(weighins),
           "need_days": NEED_DAYS, "need_weighins": NEED_WEIGHINS, "target_weight_kg": profile.target_weight_kg,
           "kcal_override": profile.kcal_override, "goal": OLD_GOALS.get(profile.goal, profile.goal),
           "kcal_auto": profile.kcal_auto, "kcal_auto_at": profile.kcal_auto_at and profile.kcal_auto_at.isoformat()}
    out.update(await plateau(session, user, profile))
    if not est:
        return out
    per_day = est["kg_per_week"] / 7
    current = weighins[-1][1]
    out.update(est, suggest=suggestion(est["tdee"], profile.goal, profile.sex, profile.weight_kg), weight=current,
               in_30_days=round(current + per_day * 30, 1))
    target = profile.target_weight_kg
    if target and abs(per_day) >= 0.01 and (target - current) * per_day > 0:
        eta = (target - current) / per_day
        out["eta"] = (today + timedelta(days=round(eta))).isoformat() if eta <= 730 else None
    return out


PLATEAU_DAYS = 14
STEP_KCAL = 150


async def plateau(session: AsyncSession, user, profile: Profile) -> dict:
    """The weight stands for two weeks while the goal is to lose or gain: what to change, in order — the diary first
    (unlogged food is the usual reason), then the intake against the norm, then the norm itself (±150 kcal: the real
    expenditure turned out lower / higher), workouts, steps. {"plateau": False} when it isn't one."""
    from backend.api.stats import targets
    from backend.database.models import WorkoutLog

    goal = OLD_GOALS.get(profile.goal, profile.goal)
    if goal not in LOSS + GAIN:
        return {"plateau": False}
    today = clock.today()
    since = today - timedelta(days=PLATEAU_DAYS - 1)
    weighins = [((m.measured_on - since).days, m.weight_kg) for m in await session.scalars(
        select(BodyMeasurement).where(BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on >= since,
                                      BodyMeasurement.weight_kg.is_not(None)).order_by(BodyMeasurement.measured_on))]
    if len(weighins) < NEED_WEIGHINS or weighins[-1][0] - weighins[0][0] < 7:
        return {"plateau": False}
    change = slope(weighins) * PLATEAU_DAYS  # kg over two weeks by the trend
    if (goal in LOSS and change <= -0.25) or (goal in GAIN and change >= 0.1):
        return {"plateau": False}  # moving the right way
    norm = targets(profile)["calories"]
    days = await daily_series(session, user, since, today - timedelta(days=1))
    full = [d["kcal"] for d in days if d["kcal"] >= FULL_DAY]
    intake = round(sum(full) / len(full)) if full else None
    tips, kcal = [], None
    if len(full) < 10:
        tips.append(f"Дневник заполнен {len(full)} дн. из {PLATEAU_DAYS} — часть еды не попадает в расчёт. Неделю записывай всё, "
                    "включая масло, соусы, напитки и перекусы.")
    elif goal in LOSS and intake > norm * 1.05:
        tips.append(f"В среднем ты ешь {intake} ккал при норме {norm} — сначала вернись к норме, менять её рано.")
    elif goal in GAIN and intake < norm * 0.95:
        tips.append(f"В среднем ты ешь {intake} ккал при норме {norm} — на наборе важно добирать норму каждый день.")
    elif profile.kcal_auto:
        tips.append("Норму ты держишь, а вес " + ("стоит" if goal in LOSS else "не растёт") + " — значит, реальный расход "
                    + ("ниже" if goal in LOSS else "выше") + " расчёта. Норма пересчитается по твоим данным сама, раз в неделю.")
    elif goal in LOSS:
        kcal = max(norm - STEP_KCAL, MIN_CALORIES[profile.sex])
        if kcal < norm:
            tips.append(f"Норму ты держишь, а вес стоит — значит, реальный расход ниже расчёта. Снизь норму до {kcal} ккал.")
        else:
            kcal = None
            tips.append("Норма уже на безопасном минимуме — снижать дальше не стоит, лучше добавить движения.")
    else:
        kcal = norm + STEP_KCAL
        tips.append(f"Норму ты держишь, а вес не растёт — расход выше расчёта. Подними норму до {kcal} ккал.")
    planned = len(profile.training_days or []) * 2
    done = await session.scalar(select(func.count()).where(
        WorkoutLog.user_id == user.id, WorkoutLog.completed_at.is_not(None), WorkoutLog.started_at >= clock.local_start(since)))
    if planned and done < planned * 0.6:
        tips.append(f"Тренировок за две недели {done} из {planned} по плану — верни их: от них зависят и расход, и мышцы.")
    if goal in LOSS:
        tips.append("Добавь 2–3 тысячи шагов в день — это ещё 100–150 ккал без чувства голода.")
    return {"plateau": True, "plateau_tips": tips, "plateau_kcal": kcal, "plateau_intake": intake}


class Override(BaseModel):
    kcal: int | None = Field(default=None, ge=1000, le=6000)  # None: back to the formula


@router.post("/insights/energy/apply")
async def apply(body: Override, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    if body.kcal and body.kcal < MIN_CALORIES[profile.sex]:
        raise HTTPException(422, f"Не меньше {MIN_CALORIES[profile.sex]} ккал — ниже опасно для здоровья")
    profile.kcal_override = body.kcal
    if body.kcal is None:
        profile.kcal_auto = False  # back to the formula on purpose: don't recalculate it away next week
    await session.commit()
    return {"kcal_override": profile.kcal_override, "kcal_auto": profile.kcal_auto}


class Auto(BaseModel):
    on: bool


@router.post("/insights/energy/auto")
async def set_auto(body: Auto, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    profile.kcal_auto = body.on
    if body.on:
        profile.kcal_auto_at = None  # recalculate at the next chance, not a week later
    await session.commit()
    return {"kcal_auto": profile.kcal_auto}


class TargetWeight(BaseModel):
    target_weight_kg: float | None = Field(default=None, ge=30, le=300)


@router.post("/profile/target-weight")
async def target_weight(body: TargetWeight, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    profile.target_weight_kg = body.target_weight_kg
    await session.commit()
    return {"target_weight_kg": profile.target_weight_kg}
