"""Motivating testosterone facts for men, only where research backs them (sources in the comments). None for women and
when nothing fits: an honest silence beats a made-up number.
- Weight loss in men with obesity: ~10 % of body weight off by diet → total T +2.9 nmol/L, about +10–30 % from baseline
  (Corona et al., Eur J Endocrinol 2013; Grossmann & Wittert, JCEM 2023). Bigger gains with a higher starting BMI
  (nomogram meta-analysis, Andrology 2023).
- Too little energy / underweight lowers T (RED-S in male athletes); eating enough restores it. Training itself barely
  changes resting T (Potter et al., JSCR 2021: SMD 0.00), so we never promise that.
- A strength session raises T for a short while, longer than cardio (PeerJ 2026 review of RCTs).
- A week of 5 h sleep: T −10–15 % in young men, like 10–15 years of ageing (Leproult & Van Cauter, JAMA 2011)."""


def bmi(weight_kg: float, height_cm: float) -> float:
    return weight_kg / (height_cm / 100) ** 2


def weight_tip(sex: str, weight_kg: float, height_cm: float) -> str | None:
    if sex != "male" or not weight_kg or not height_cm:
        return None
    b = bmi(weight_kg, height_cm)
    if b >= 30:
        return (f"Лишний жир снижает тестостерон. В исследованиях похудение на 10 % — для тебя это ≈{round(weight_kg * 0.1)} кг — "
                "поднимало его в среднем на 10–30 %. Чем больше лишнего веса, тем сильнее эффект.")
    if b >= 27:
        to_norm = round(weight_kg - 25 * (height_cm / 100) ** 2)
        return (f"До нормального веса тебе ≈{to_norm} кг. У мужчин с лишним весом тестостерон после похудения "
                "обычно растёт — минус 10 % веса давали в исследованиях +10–30 %.")
    if b < 18.5:
        return ("Тебе не хватает веса, а при недоборе энергии организм экономит и снижает тестостерон. "
                "Ешь свою норму без пропусков и тренируйся с отягощениями — уровень восстановится, а вес пойдёт в мышцы.")
    return None


WORKOUT = (
    "После силовой тестостерон поднимается — дольше, чем после кардио. Это нормальный ответ организма на тяжёлую работу.",
    "Тестостерон держится на трёх вещах: нормальный вес, сон 7–9 часов и достаточно еды. Регулярные тренировки помогают со всеми тремя.",
    "Силовая только что подняла твой тестостерон. Хочешь, чтобы и базовый уровень был высоким, — спи 7+ часов: неделя по 5 часов снижает его на 10–15 %.",
)


def workout_tip(sex: str, n: int, weight_kg: float | None = None, height_cm: float | None = None) -> str | None:
    """n picks the fact, so they take turns. For an overweight man every third one is about weight."""
    if sex != "male":
        return None
    if weight_kg and height_cm and bmi(weight_kg, height_cm) >= 27 and n % 3 == 0:
        return "Молодец! Тренировки + дефицит калорий = минус жир, а минус 10 % веса в исследованиях давали +10–30 % тестостерона."
    return "Молодец! " + WORKOUT[n % len(WORKOUT)]


def sleep_tip(sex: str, sleep: int | None) -> str | None:
    """sleep: the check-in's code, 1 = under 6 h."""
    if sex != "male" or sleep != 1:
        return None
    return ("Меньше 6 часов сна бьёт по тестостерону: неделя по 5 часов снижает его на 10–15 % — "
            "как 10–15 лет старения. Сегодня постарайся лечь на час раньше.")
