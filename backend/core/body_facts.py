"""Motivating facts from research, by sex, only where studies back them. None when nothing fits: an honest silence beats a
made-up number. Never anything that would push an underweight person to eat less.
Men:
- Weight loss with obesity: ~10 % of body weight off by diet → total T +2.9 nmol/L, about +10–30 % from baseline
  (Corona et al., Eur J Endocrinol 2013; Grossmann & Wittert, JCEM 2023; bigger with a higher BMI — Andrology 2023).
- Too little energy lowers T (RED-S in male athletes). Training barely changes resting T (Potter et al., JSCR 2021),
  so we never promise that.
- A strength session raises T for a while, longer than cardio (PeerJ 2026 review of RCTs).
- A week of 5 h sleep: T −10–15 % in young men (Leproult & Van Cauter, JAMA 2011).
Women:
- 5–10 % of body weight off improves insulin resistance, androgen excess and cardiovascular risk (2023 international
  PCOS guideline; Proc Nutr Soc review of lifestyle interventions).
- Low energy availability disrupts the cycle and costs bone (Female Athlete Triad / RED-S).
- Strength training twice a week for 8 months: spine bone density fell in 19 % of women vs 72 % without it
  (LIFTMOR, Watson et al., JBMR 2018; postmenopausal women with low bone mass).
- Short sleep: +385 kcal a day eaten (Al Khatib et al., Eur J Clin Nutr 2017, 11 studies).
Both:
- Strength training cuts depressive symptoms moderately (Gordon et al., JAMA Psychiatry 2018: 33 RCTs, 1 877 people)."""


def bmi(weight_kg: float, height_cm: float) -> float:
    return weight_kg / (height_cm / 100) ** 2


def weight_tip(sex: str, weight_kg: float, height_cm: float) -> str | None:
    if not weight_kg or not height_cm:
        return None
    b = bmi(weight_kg, height_cm)
    tenth, to_norm = round(weight_kg * 0.1), round(weight_kg - 25 * (height_cm / 100) ** 2)
    if sex == "male":
        if b >= 30:
            return (f"Лишний жир снижает тестостерон. В исследованиях похудение на 10 % — для тебя это ≈{tenth} кг — "
                    "поднимало его в среднем на 10–30 %. Чем больше лишнего веса, тем сильнее эффект.")
        if b >= 27:
            return (f"До нормального веса тебе ≈{to_norm} кг. У мужчин с лишним весом тестостерон после похудения "
                    "обычно растёт — минус 10 % веса давали в исследованиях +10–30 %.")
        if b < 18.5:
            return ("Тебе не хватает веса, а при недоборе энергии организм экономит и снижает тестостерон. "
                    "Ешь свою норму без пропусков и тренируйся с отягощениями — уровень восстановится, а вес пойдёт в мышцы.")
        return None
    if b >= 27:
        return (f"Уже минус 5–10 % веса — для тебя это {round(weight_kg * 0.05)}–{tenth} кг — заметно улучшают гормональный "
                "баланс: снижают инсулинорезистентность и избыток мужских гормонов, а с ними — тягу к сладкому и риски для сердца.")
    if b < 18.5:
        return ("Тебе не хватает веса. Когда организму мало энергии, он экономит: сбивается цикл и кости теряют плотность. "
                "Ешь свою норму без пропусков, а силовые помогут, чтобы вес шёл в мышцы и кости, а не в жир.")
    return None


MEN = (
    "После силовой тестостерон поднимается — дольше, чем после кардио. Это нормальный ответ организма на тяжёлую работу.",
    "Тестостерон держится на трёх вещах: нормальный вес, сон 7–9 часов и достаточно еды. Регулярные тренировки помогают со всеми тремя.",
    "Хочешь высокий тестостерон — спи 7+ часов: неделя по 5 часов снижает его на 10–15 %.",
)
WOMEN = (
    "Силовые — лучшая страховка для костей: у женщин, тренировавшихся 2 раза в неделю, плотность позвоночника за 8 месяцев "
    "снизилась лишь у 19 %, а без тренировок — у 72 %.",
    "Не бойся «перекачаться»: женщине для этого не хватает тестостерона. Силовые дают тонус, форму и сильные кости.",
    "Мышцы — главный потребитель сахара из крови. Чем их больше, тем ровнее уровень сахара и меньше тяга к сладкому.",
)
MOOD = "Силовые работают и как антидепрессант: по 33 исследованиям они заметно снижают тревогу и подавленность."


def workout_tip(sex: str, n: int, weight_kg: float | None = None, height_cm: float | None = None) -> str:
    """n picks the fact, so they take turns: own-sex facts, the mood one, and for extra weight one about weight."""
    facts = [*(MEN if sex == "male" else WOMEN), MOOD]
    if weight_kg and height_cm and bmi(weight_kg, height_cm) >= 27:
        facts.append("Тренировки + дефицит калорий = минус жир, а минус 10 % веса в исследованиях давали +10–30 % тестостерона."
                     if sex == "male" else "Тренировки + дефицит калорий = минус жир, а уже минус 5–10 % веса заметно улучшают гормональный баланс.")
    return "Молодец! " + facts[n % len(facts)]


def sleep_tip(sex: str, sleep: int | None) -> str | None:
    """sleep: the check-in's code, 1 = under 6 h."""
    if sleep != 1:
        return None
    if sex == "male":
        return ("Меньше 6 часов сна бьёт по тестостерону: неделя по 5 часов снижает его на 10–15 % — "
                "как 10–15 лет старения. Сегодня постарайся лечь на час раньше.")
    return ("После короткой ночи гормоны голода берут верх: в среднем люди съедают на 385 ккал больше. "
            "Сегодня держи под рукой белок и овощи — и постарайся лечь на час раньше.")
