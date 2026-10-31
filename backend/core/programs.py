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


def recommend(programs, profile) -> dict | None:
    if profile is None or not programs:
        return None
    scored = [(score_program(p, profile.experience, profile.equipment, profile.sessions_per_week), p) for p in programs]
    (score, reasons), best = max(scored, key=lambda x: x[0][0])
    return {"program_id": best.id, "score": score, "reasons": reasons}
