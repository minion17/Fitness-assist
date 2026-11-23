"""Daily calorie and macro targets from the questionnaire.

Expenditure: Mifflin–St Jeor × activity. On top of it, the goal is a rate of weight change, not a flat percentage:
- losing 0.5–1 % of body weight a week keeps muscle (Helms et al. 2014), gaining 0.25–0.5 % a week is enough
  for muscle (Iraki et al. 2019); a 15 % surplus gave no more muscle or strength than 5 %, only more fat
  (Helms et al. 2023, Sports Med Open 9:102).
- protein 1.6–2.2 g/kg, the upper end in a deficit (ISSN 2017; Morton et al. 2018), counted on a reference weight
  when BMI is over 25 — protein needs follow lean mass, not fat.
- fat 25 % of energy, at least 0.8 g/kg (0.5–1.5 g/kg and 20–35 % of energy in the reviews and the DRI).
- carbohydrates take the rest; above ~5 g/kg (enough for strength training: 3–5 g/kg, Iraki et al. 2019) the extra
  goes to fat up to 35 % of energy / 1.5 g/kg, so a big norm isn't all bread and rice.
- training days get more carbohydrate, rest days a little less, the week's total unchanged ("fuel for the work
  required": glycogen is what a hard session uses; Impey et al. 2018, Burke et al. 2011).
"""
from datetime import date

ACTIVITY = {"low": 1.2, "light": 1.375, "moderate": 1.55, "high": 1.725, "very_high": 1.9}
# The weekly change of body weight each goal aims for, % of body weight (negative = losing)
WEEKLY_RATE = {"weight_loss": -0.75, "fat_loss": -0.5, "maintenance": 0.0, "muscle_gain": 0.25, "mass_gain": 0.5}
MAX_SHIFT = {"weight_loss": 0.25, "fat_loss": 0.2, "maintenance": 0.0, "muscle_gain": 0.1, "mass_gain": 0.15}  # of expenditure
KCAL_PER_KG = 7700  # energy in 1 kg of body weight change (fat + water + some lean)
PROTEIN_G_PER_KG = {"weight_loss": 2.0, "fat_loss": 2.2, "maintenance": 1.6, "muscle_gain": 2.0, "mass_gain": 2.0}
FAT_SHARE, FAT_MIN_G_PER_KG, FAT_MAX_SHARE, FAT_MAX_G_PER_KG = 0.25, 0.8, 0.35, 1.5
CARBS_ENOUGH_G_PER_KG = 5
CARB_SHIFT_G_PER_KG, CARBS_FLOOR_G_PER_KG = 0.75, 2.0  # extra carbs on a training day; rest days never below the floor
MIN_CALORIES = {"male": 1500, "female": 1200}  # safety floor for deficit goals
GOAL_RU = {
    "weight_loss": "снижение веса", "fat_loss": "снижение процента жира", "maintenance": "поддержание формы",
    "muscle_gain": "набор мышечной массы", "mass_gain": "набор общей массы",
}
# Answers saved before the 5-goal questionnaire
OLD_GOALS = {"lose": "weight_loss", "maintain": "maintenance", "gain": "muscle_gain"}


def maintenance(sex: str, birth_year: int, height_cm: int, weight_kg: float, activity: str) -> int:
    """Expenditure by the formula: BMR × activity."""
    age = date.today().year - birth_year
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 if sex == "male" else -161)
    return round(bmr * ACTIVITY[activity])


def reference_weight(height_cm: int, weight_kg: float) -> float:
    """Weight for g/kg norms: the actual weight up to BMI 25, above it the BMI-25 weight plus a quarter of the excess
    (the usual "adjusted body weight"), so 120 kg at 175 cm doesn't get 240 g of protein."""
    lean = 25 * (height_cm / 100) ** 2
    return weight_kg if weight_kg <= lean else lean + 0.25 * (weight_kg - lean)


def goal_calories(expenditure: int, weight_kg: float, goal: str) -> int:
    """Expenditure plus the daily surplus / minus the deficit of the goal's weekly rate, within a safe share."""
    shift = weight_kg * WEEKLY_RATE[goal] / 100 * KCAL_PER_KG / 7
    cap = expenditure * MAX_SHIFT[goal]
    return round(expenditure + max(-cap, min(cap, shift)))


def macros(calories: int, height_cm: int, weight_kg: float, goal: str) -> dict:
    ref = reference_weight(height_cm, weight_kg)
    protein = round(ref * PROTEIN_G_PER_KG[goal])
    fat = max(FAT_MIN_G_PER_KG * ref, FAT_SHARE * calories / 9)
    carbs = (calories - protein * 4 - fat * 9) / 4
    if carbs > CARBS_ENOUGH_G_PER_KG * ref:  # a big norm: past "enough" carbs, more fat instead (within its limits)
        room = max(0.0, min(FAT_MAX_SHARE * calories / 9, FAT_MAX_G_PER_KG * ref) - fat)
        fat += min(room, (carbs - CARBS_ENOUGH_G_PER_KG * ref) * 4 / 9)
        carbs = (calories - protein * 4 - fat * 9) / 4
    return {"protein": protein, "fat": round(fat), "carbs": max(0, round(carbs))}


def daily_targets(sex: str, birth_year: int, height_cm: int, weight_kg: float, activity: str, goal: str,
                  calories: int | None = None) -> dict:
    """`calories`: the user's own accepted norm (from their real expenditure) instead of the formula."""
    goal = OLD_GOALS.get(goal, goal)
    calories = calories or max(goal_calories(maintenance(sex, birth_year, height_cm, weight_kg, activity), weight_kg, goal),
                               MIN_CALORIES[sex])
    return {"calories": calories, **macros(calories, height_cm, weight_kg, goal)}


def cycle(t: dict, height_cm: int, weight_kg: float, training_days: list[int] | None, weekday: int, trained: bool) -> dict:
    """The day's norm: up to +0.75 g/kg carbs on a training day (planned, or a workout done today); planned rest days give
    the same carbs back, so the week's calories stay as before. A low-carb norm (rest days would drop under 2 g/kg)
    shifts less or not at all. No plan and no workout: the norm as is."""
    ref = reference_weight(height_cm, weight_kg)
    plan = set(training_days or [])
    if len(plan) == 7:  # training every day: nothing to balance against
        return {**t, "day": None, "carbs_shift": 0}
    n = len(plan)
    room = max(0.0, t["carbs"] - CARBS_FLOOR_G_PER_KG * ref)  # what a rest day can give up
    up = min(CARB_SHIFT_G_PER_KG * ref, room * (7 - n) / n) if n else CARB_SHIFT_G_PER_KG * ref
    if trained or weekday in plan and n:
        day, shift = "training", up
    elif n:
        day, shift = "rest", -up * n / (7 - n)
    else:
        day, shift = None, 0
    shift = round(shift)
    if not shift:
        return {**t, "day": None, "carbs_shift": 0}
    return {**t, "calories": t["calories"] + shift * 4, "carbs": t["carbs"] + shift, "day": day, "carbs_shift": shift}


def day_goals(t: dict | None, profile, rows: list[dict]) -> None:
    """Each day's own calorie norm into rows ({"date", "workouts", ...} → "goal"): a training day eaten to its norm
    is in the norm, not 12 % over the plain one."""
    if not t or profile is None:
        return
    from datetime import date

    for r in rows:
        d = date.fromisoformat(r["date"])
        r["goal"] = cycle(t, profile.height_cm, profile.weight_kg, profile.training_days, d.weekday(), r["workouts"] > 0)["calories"]
