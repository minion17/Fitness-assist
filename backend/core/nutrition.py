"""Daily calorie and macro targets from the questionnaire (Mifflin–St Jeor)."""
from datetime import date

ACTIVITY = {"low": 1.2, "light": 1.375, "moderate": 1.55, "high": 1.725, "very_high": 1.9}
# 5 goals and their calorie adjustments come from the colleague's Logos engine (config.ts)
GOAL_FACTOR = {"weight_loss": 0.80, "fat_loss": 0.85, "maintenance": 1.0, "muscle_gain": 1.15, "mass_gain": 1.20}
PROTEIN_G_PER_KG = {"weight_loss": 2.0, "fat_loss": 2.0, "maintenance": 1.6, "muscle_gain": 1.8, "mass_gain": 1.6}
FAT_G_PER_KG = 0.9
MIN_CALORIES = {"male": 1500, "female": 1200}  # safety floor for deficit goals
GOAL_RU = {
    "weight_loss": "снижение веса", "fat_loss": "снижение процента жира", "maintenance": "поддержание формы",
    "muscle_gain": "набор мышечной массы", "mass_gain": "набор общей массы",
}
# Answers saved before the 5-goal questionnaire
OLD_GOALS = {"lose": "weight_loss", "maintain": "maintenance", "gain": "muscle_gain"}


def daily_targets(sex: str, birth_year: int, height_cm: int, weight_kg: float, activity: str, goal: str) -> dict:
    goal = OLD_GOALS.get(goal, goal)
    age = date.today().year - birth_year
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 if sex == "male" else -161)
    calories = max(round(bmr * ACTIVITY[activity] * GOAL_FACTOR[goal]), MIN_CALORIES[sex])
    protein = round(weight_kg * PROTEIN_G_PER_KG[goal])
    fat = round(weight_kg * FAT_G_PER_KG)
    carbs = max(0, round((calories - protein * 4 - fat * 9) / 4))
    return {"calories": calories, "protein": protein, "fat": fat, "carbs": carbs}
