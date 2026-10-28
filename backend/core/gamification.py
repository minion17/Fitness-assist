"""Reward rules and XP/level math. No DB access here — see backend/database/rewards.py.

XP is not awarded anywhere yet: it will be wired in once meals and workouts are saved.
"""

# event_type -> XP. Add rules here; unknown event types are rejected.
RULES: dict[str, int] = {
    "meal_logged": 10,
    "daily_nutrition_goal": 30,
    "workout_completed": 50,
    "body_measurement": 15,
}

# XP needed to go from level n to n+1: 100, 150, 200, ...
BASE_STEP = 100
STEP_GROWTH = 50


def xp_for_rule(event_type: str) -> int:
    try:
        return RULES[event_type]
    except KeyError:
        raise ValueError(f"unknown reward event: {event_type}")


def level_progress(xp: int) -> dict:
    """Level (from 1) and progress inside it for a total XP."""
    level, floor, step = 1, 0, BASE_STEP
    while xp >= floor + step:
        floor += step
        level += 1
        step += STEP_GROWTH
    return {"xp": xp, "level": level, "level_xp": xp - floor, "level_xp_needed": step}
