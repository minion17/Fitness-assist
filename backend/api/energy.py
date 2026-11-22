"""Real expenditure from the user's own data: what they ate vs how their weight moved. Plus a forecast and a plateau hint.

Energy balance: 1 kg of body weight ≈ 7700 kcal. Over a few weeks, average intake − 7700 × (kg lost per day) = expenditure.
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from backend.api.deps import get_or_create_user, telegram_user
from backend.api.stats import daily_series
from backend.core import clock
from backend.core.nutrition import MIN_CALORIES, OLD_GOALS, maintenance
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


def suggestion(tdee: int, goal: str, sex: str) -> int:
    """A norm from the real expenditure: about −0.5 kg/week for loss, +0.25 kg/week for gain."""
    goal = OLD_GOALS.get(goal, goal)
    if goal in LOSS:
        return max(round((tdee - 550) / 10) * 10, MIN_CALORIES[sex])
    if goal in GAIN:
        return round((tdee + 300) / 10) * 10
    return tdee


@router.get("/insights/energy")
async def energy(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    profile = await session.get(Profile, user.id)
    if profile is None:
        raise HTTPException(404, "Сначала заполни анкету")
    today = clock.today()
    since = today - timedelta(days=WINDOW - 1)
    days = await daily_series(session, user, since, today - timedelta(days=1))  # today isn't finished yet
    intakes = [d["kcal"] for d in days if d["kcal"] >= FULL_DAY]
    weights = [(m.measured_on, m.weight_kg) for m in await session.scalars(
        select(BodyMeasurement).where(BodyMeasurement.user_id == user.id, BodyMeasurement.measured_on >= since,
                                      BodyMeasurement.weight_kg.is_not(None)).order_by(BodyMeasurement.measured_on))]
    weighins = [((d - since).days, w) for d, w in weights]
    formula = maintenance(profile.sex, profile.birth_year, profile.height_cm, profile.weight_kg, profile.activity)
    est = estimate(intakes, weighins)
    out = {"ready": est is not None, "formula": formula, "days_logged": len(intakes), "weighins": len(weighins),
           "need_days": NEED_DAYS, "need_weighins": NEED_WEIGHINS, "target_weight_kg": profile.target_weight_kg,
           "kcal_override": profile.kcal_override, "goal": OLD_GOALS.get(profile.goal, profile.goal)}
    out.update(await plateau(session, user, profile))
    if not est:
        return out
    per_day = est["kg_per_week"] / 7
    current = weighins[-1][1]
    out.update(est, suggest=suggestion(est["tdee"], profile.goal, profile.sex), weight=current,
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
    await session.commit()
    return {"kcal_override": profile.kcal_override}


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
