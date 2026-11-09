"""Reward rules and XP/level math. No DB access here — see backend/database/rewards.py."""

# event_type -> XP. Add rules here; unknown event types are rejected.
RULES: dict[str, int] = {
    "meal_logged": 10,
    "daily_nutrition_goal": 30,
    "workout_completed": 50,
    "body_measurement": 15,
    "water_goal": 10,
    "streak_week": 20,  # every 7 days in a row (also earns a streak freeze)
    "achievement": 25,
    "duel_win": 40,  # no stakes: the loser keeps everything; the winner also gets BOOST for a day
    "friend_invited": 50,
    # weekly tasks: one rule per reward size (award_xp takes amounts from here)
    "quest_30": 30,
    "quest_50": 50,
    "quest_80": 80,
    "quests_all": 50,  # all three of the week done  # when the invited friend fills the profile (not on the click: no farming with empty accounts)
}

BOOST = 1.5  # XP multiplier after a duel win
BOOST_HOURS = 24
NOT_BOOSTED = {"duel_win", "friend_invited", "quest_30", "quest_50", "quest_80", "quests_all"}
MAX_INVITE_REWARDS = 10
# Daily rewards are keyed by the user's local date, and the timezone can be changed: these caps (per rolling
# 20 hours) stop "travelling" through timezones to collect the same day's XP twice.
ROLLING_CAPS = {"meal_logged": 4, "water_goal": 1, "daily_nutrition_goal": 1}
CAP_WINDOW_HOURS = 20

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
