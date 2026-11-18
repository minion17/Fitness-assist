"""Pick the best-fitting training program for questionnaire answers (idea from the Logos engine)."""

# questionnaire equipment code -> equipment names used in content/exercises/exercises.json
EQUIPMENT = {
    "bodyweight": {"Собственный вес", "Коврик", "Скакалка"},
    "dumbbells": {"Гантели", "Гантель"},
    "barbell": {"Штанга", "Стойки"},
    "bench": {"Скамья"},
    "pullup_bar": {"Турник", "Брусья"},
    "cable_machine": {"Тренажёр"},
    "machine": {"Тренажёр", "Римский стул"},
}
ALWAYS_AVAILABLE = {"Собственный вес", "Коврик", "Скакалка"}
LEVELS = ["beginner", "intermediate", "advanced"]


def score_program(program, experience: str | None, equipment: list[str] | None, sessions: int | None) -> tuple[float, list[str]]:
    """0..100 and human-readable reasons. `program` has .level, .days_per_week, .days[].items[].exercise.equipment."""
    reasons = []
    have = set(ALWAYS_AVAILABLE).union(*(EQUIPMENT.get(e, set()) for e in equipment or []))
    exercises = [i.exercise for d in program.days for i in d.items]
    usable = [e for e in exercises if set(e.equipment or []) <= have]
    coverage = len(usable) / len(exercises) if exercises else 0
    score = 40 * coverage
    if coverage == 1:
        reasons.append("всё оборудование у вас есть")
    elif coverage >= 0.5:
        reasons.append(f"подходит {round(coverage * 100)}% упражнений по оборудованию")

    if experience in LEVELS and program.level in LEVELS:
        gap = abs(LEVELS.index(experience) - LEVELS.index(program.level))
        score += 30 * {0: 1, 1: 0.4}.get(gap, 0)
        if gap == 0:
            reasons.append("по вашему уровню подготовки")

    if sessions:
        diff = abs(program.days_per_week - sessions)
        score += 30 * max(0.0, 1 - diff / 3)
        if diff == 0:
            reasons.append(f"{sessions} тренировки в неделю, как вы хотите")
    return round(score, 1), reasons


# questionnaire self-test -> points: 0 weak, 1 fair, 2 strong ("не знаю" doesn't count)
TEST_POINTS = {
    "squats": {"lt15": 0, "15_30": 1, "gt30": 2},
    "pushups": {"lt10": 0, "10_20": 1, "gt20": 2},
    "pullups": {"none": 0, "1_5": 1, "6_10": 2, "gt10": 2},
}


def tested_level(profile) -> str | None:
    """Level by what the body can do now (squats, push-ups, pull-ups); None when nothing was answered."""
    points = [TEST_POINTS[k].get(getattr(profile, k, None)) for k in TEST_POINTS]
    known = [p for p in points if p is not None]
    if not known:
        return None
    avg = sum(known) / len(known)
    return "beginner" if avg < 0.75 else "intermediate" if avg < 1.6 else "advanced"


def training_level(profile) -> tuple[str | None, bool]:
    """The stated experience, but not above what the self-test shows (years off training count less than today's form).
    Second value: the test lowered it."""
    stated, tested = profile.experience, tested_level(profile)
    if stated in LEVELS and tested in LEVELS and LEVELS.index(tested) < LEVELS.index(stated):
        return tested, True
    return stated or tested, False


def recommend(programs, profile) -> dict | None:
    if profile is None or not programs:
        return None
    level, by_test = training_level(profile)
    scored = [(score_program(p, level, profile.equipment, profile.sessions_per_week), p) for p in programs]
    (score, reasons), best = max(scored, key=lambda x: x[0][0])
    if by_test and "по вашему уровню подготовки" in reasons:
        reasons = [("по вашей форме сейчас (приседания, отжимания)" if r == "по вашему уровню подготовки" else r) for r in reasons]
    return {"program_id": best.id, "score": score, "reasons": reasons}
