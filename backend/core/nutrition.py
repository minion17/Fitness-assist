"""Daily calorie and macro targets from the questionnaire (Mifflin–St Jeor)."""
from datetime import date

ACTIVITY = {"low": 1.2, "light": 1.375, "moderate": 1.55, "high": 1.725, "very_high": 1.9}
GOAL_FACTOR = {"lose": 0.85, "maintain": 1.0, "gain": 1.1}
PROTEIN_G_PER_KG = {"lose": 2.0, "maintain": 1.6, "gain": 1.8}
FAT_G_PER_KG = 0.9


def daily_targets(sex: str, birth_year: int, height_cm: int, weight_kg: float, activity: str, goal: str) -> dict:
    age = date.today().year - birth_year
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 if sex == "male" else -161)
    calories = round(bmr * ACTIVITY[activity] * GOAL_FACTOR[goal])
    protein = round(weight_kg * PROTEIN_G_PER_KG[goal])
    fat = round(weight_kg * FAT_G_PER_KG)
    carbs = max(0, round((calories - protein * 4 - fat * 9) / 4))
    return {"calories": calories, "protein": protein, "fat": fat, "carbs": carbs}
