import time

import pytest

from backend.core.telegram_auth import InitDataError, validate_init_data
from conftest import PROFILE, TOKEN, USER, make_init_data, new_user_headers


def test_valid_init_data():
    data = validate_init_data(make_init_data(USER), TOKEN)
    assert data["user"]["id"] == USER["id"]


@pytest.mark.parametrize(
    "init_data",
    [
        "",
        "auth_date=1&user=%7B%7D",  # no hash
        make_init_data(USER, token="999:OTHER"),  # signed by another bot
        make_init_data(USER).replace("egor", "hack"),  # tampered
        make_init_data(USER, auth_date=int(time.time()) - 100000),  # expired
    ],
)
def test_invalid_init_data(init_data):
    with pytest.raises(InitDataError):
        validate_init_data(init_data, TOKEN, max_age=86400)


def test_health(client):
    assert client.get("/health").json() == {"status": "ok", "database": "ok"}


def test_auth_registers_user_once(client):
    headers = {"Authorization": f"tma {make_init_data(USER)}"}
    first = client.post("/api/auth", headers=headers)
    second = client.post("/api/auth", headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()["telegram_id"] == USER["id"]
    assert first.json()["id"] == second.json()["id"]


def test_auth_rejects_bad_init_data(client):
    assert client.post("/api/auth").status_code == 401
    assert client.post("/api/auth", headers={"Authorization": "tma hash=bad"}).status_code == 401


def test_bot_start_button_opens_webapp():
    from backend.bot.main import current_webapp_url, open_app_keyboard

    btn = open_app_keyboard(current_webapp_url()).inline_keyboard[0][0]
    assert btn.text == "Открыть приложение"
    assert btn.web_app.url == "https://example.test"


def test_level_progress():
    from backend.core.gamification import level_progress

    assert level_progress(0) == {"xp": 0, "level": 1, "level_xp": 0, "level_xp_needed": 100}
    assert level_progress(99)["level"] == 1
    assert level_progress(100) == {"xp": 100, "level": 2, "level_xp": 0, "level_xp_needed": 150}
    assert level_progress(260)["level"] == 3  # 100 + 150 = 250


def test_award_xp_is_idempotent(client):
    import uuid

    from backend.core.gamification import level_progress
    from backend.database.db import SessionLocal
    from backend.database.models import User
    from backend.database.rewards import award_xp

    headers = {"Authorization": f"tma {make_init_data(USER)}"}
    before = client.post("/api/auth", headers=headers).json()
    key = f"workout:{uuid.uuid4()}"

    async def run():
        async with SessionLocal() as s:
            granted = [await award_xp(s, before["id"], "workout_completed", key) for _ in range(3)]
            with pytest.raises(ValueError):
                await award_xp(s, before["id"], "no_such_rule", "x:1")
        async with SessionLocal() as s:
            user = await s.get(User, before["id"])
        return granted, user

    # run on the app's event loop: the connection pool is bound to it
    granted, user = client.portal.call(run)
    assert granted == [50, 0, 0]
    assert user.xp == before["progress"]["xp"] + 50
    assert user.level == level_progress(user.xp)["level"]
    assert client.post("/api/auth", headers=headers).json()["progress"]["xp"] == user.xp


def test_daily_targets():
    from datetime import date

    from backend.core.nutrition import daily_targets

    t = daily_targets(**{**PROFILE, "birth_year": date.today().year - 30})
    # BMR = 784 + 1137.5 - 150 + 5 = 1776.5; *1.55 = 2754; -0.75 % of 78.4 kg a week = -647 kcal a day
    assert t == {"calories": 2107, "protein": 157, "fat": 63, "carbs": 229}
    assert daily_targets(**{**PROFILE, "goal": "lose"}) == daily_targets(**PROFILE)  # old saved goal still works
    # tiny woman, sedentary, aggressive deficit -> safety floor
    floor = daily_targets("female", date.today().year - 60, 150, 42, "low", "weight_loss")
    assert floor["calories"] == 1200
    # 190 cm / 76 kg on a mass gain: +0.5 % a week, not +15 %; carbs ~5 g/kg instead of 540 g
    gain = daily_targets("male", date.today().year - 28, 190, 76, "moderate", "mass_gain")
    assert gain == {"calories": 3227, "protein": 152, "fat": 114, "carbs": 398}
    # obese: protein on the adjusted weight (BMI 25 + a quarter of the excess), not 2 g × 120 kg
    assert daily_targets("male", 1998, 175, 120, "moderate", "weight_loss")["protein"] == 175


def test_profile_save_and_read(client):
    import random

    fresh_user = {**USER, "id": random.randint(10**9, 2 * 10**9)}  # new user every run
    headers = {"Authorization": f"tma {make_init_data(fresh_user)}"}
    assert client.get("/api/profile", headers=headers).json() is None
    assert client.post("/api/auth", headers=headers).json()["profile"] is None

    saved = client.put("/api/profile", headers=headers, json=PROFILE)
    assert saved.status_code == 200
    assert saved.json()["targets"]["calories"] > 0

    updated = client.put("/api/profile", headers=headers, json={**PROFILE, "goal": "muscle_gain"}).json()
    assert updated["goal"] == "muscle_gain" and updated["targets"]["calories"] > saved.json()["targets"]["calories"]
    assert client.post("/api/auth", headers=headers).json()["profile"] == updated


@pytest.mark.parametrize(
    "bad",
    [{"height_cm": 50}, {"weight_kg": 1000}, {"sex": "x"}, {"goal": "fly"}, {"birth_year": 2025}, {"activity": None}],
)
def test_profile_validation(client, bad):
    headers = {"Authorization": f"tma {make_init_data(USER)}"}
    assert client.put("/api/profile", headers=headers, json={**PROFILE, **bad}).status_code == 422


def test_profile_requires_telegram(client):
    assert client.put("/api/profile", json=PROFILE).status_code == 401


# ---- merged: reference data, food diary, workouts ----


def test_import_is_idempotent(seeded):
    _, second = seeded
    assert second == {"products": 0, "exercises": 0, "programs": 0}


def test_programs_and_exercises(client, seeded):
    programs = client.get("/api/programs").json()
    ppl = next(p for p in programs if p["name"] == "Тяни-Толкай-Ноги (PPL)")
    assert [d["day_order"] for d in ppl["days"]] == [1, 2, 3]
    assert ppl["days"][0]["exercises"][0]["name"] == "Жим штанги лежа"
    assert len(client.get("/api/exercises").json()) >= 29


def test_product_search_escapes_wildcards(client, seeded):
    names = [p["name"] for p in client.get("/api/products/search", params={"q": "творог 5%"}).json()]
    assert "Тестовый творог 5%" in names and "Тестовый творог обезжиренный" not in names  # "%" is literal
    assert len(client.get("/api/products/search", params={"q": "тестовый творог"}).json()) == 2
    assert client.get("/api/products/search", params={"q": "т"}).status_code == 422


def test_food_diary_totals_and_xp(client, seeded):
    h = new_user_headers()
    pid = client.get("/api/products/search", params={"q": "творог 5%"}).json()[0]["id"]

    first = client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 200, "meal_type": "breakfast"})
    assert first.status_code == 200
    assert first.json()["kcal"] == 242 and first.json()["xp_awarded"] == 10
    second = client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 50, "meal_type": "breakfast"})
    assert second.json()["xp_awarded"] == 0  # same meal type today: no extra XP

    day = client.get("/api/food-logs", headers=h).json()
    assert len(day["items"]) == 2
    assert day["totals"]["kcal"] == 242 + 60  # 121 * 0.5 = 60.5 -> 60

    assert client.post("/api/food-logs", headers=h, json={"product_id": 10**9, "amount_g": 100, "meal_type": "lunch"}).status_code == 404
    assert client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 0, "meal_type": "lunch"}).status_code == 422
    assert client.post("/api/food-logs", json={"product_id": pid, "amount_g": 100, "meal_type": "lunch"}).status_code == 401


def test_workout_flow(client, seeded):
    h, other = new_user_headers(), new_user_headers()
    day_id = client.get("/api/programs").json()[0]["days"][0]["id"]
    ex_id = client.get("/api/programs").json()[0]["days"][0]["exercises"][0]["exercise_id"]

    w = client.post("/api/workout-logs", headers=h, json={"program_day_id": day_id, "title": "День 1"}).json()
    assert client.post(f"/api/workout-logs/{w['id']}/complete", headers=h).status_code == 400  # empty

    s = {"exercise_id": ex_id, "set_number": 1, "reps": 8, "weight_kg": 60}
    assert client.post(f"/api/workout-logs/{w['id']}/sets", headers=other, json=s).status_code == 404  # not yours
    assert client.post(f"/api/workout-logs/{w['id']}/sets", headers=h, json=s).status_code == 200

    assert client.post(f"/api/workout-logs/{w['id']}/complete", headers=h).json()["xp_awarded"] == 50
    assert client.post(f"/api/workout-logs/{w['id']}/complete", headers=h).json()["xp_awarded"] == 0
    assert client.post(f"/api/workout-logs/{w['id']}/sets", headers=h, json=s).status_code == 409

    logs = client.get("/api/workout-logs", headers=h).json()
    assert logs[0]["sets"] == 1 and logs[0]["completed_at"]
    assert client.post("/api/auth", headers=h).json()["progress"]["xp"] == 50
    assert client.post("/api/workout-logs", headers=h, json={"program_day_id": 10**9}).status_code == 404

    # "last time": only the latest workout's sets, only this user's
    w2 = client.post("/api/workout-logs", headers=h, json={"program_day_id": day_id, "title": "День 1"}).json()
    for n, kg in ((1, 62.5), (2, 60)):
        client.post(f"/api/workout-logs/{w2['id']}/sets", headers=h, json={**s, "set_number": n, "weight_kg": kg})
    last = client.get(f"/api/exercises/last?ids={ex_id},999999", headers=h).json()
    assert [x["weight_kg"] for x in last[str(ex_id)]["sets"]] == [62.5, 60] and "999999" not in last
    assert client.get(f"/api/exercises/last?ids={ex_id}", headers=other).json() == {}

    # undo a set saved by mistake: only yours, only while the workout goes on
    extra = client.post(f"/api/workout-logs/{w2['id']}/sets", headers=h, json={**s, "set_number": 3, "weight_kg": 100}).json()["id"]
    assert client.delete(f"/api/workout-logs/{w2['id']}/sets/{extra}", headers=other).status_code == 404
    assert client.delete(f"/api/workout-logs/{w2['id']}/sets/{extra}", headers=h).json() == {"ok": True}
    assert client.delete(f"/api/workout-logs/{w2['id']}/sets/{extra}", headers=h).status_code == 404
    assert [x["weight_kg"] for x in client.get(f"/api/exercises/last?ids={ex_id}", headers=h).json()[str(ex_id)]["sets"]] == [62.5, 60]


def test_import_reports_bad_product_rows(tmp_path, monkeypatch):
    import backend.seed.import_data as imp

    (tmp_path / "products").mkdir()
    monkeypatch.setattr(imp, "CONTENT", tmp_path)
    (tmp_path / "products/products.json").write_text('[{"name": "Хлеб", "kcal": 250}, {"name": "Сыр", "kcal": "много"}]', encoding="utf-8")
    with pytest.raises(SystemExit, match="запись №2 \\(Сыр\\).*kcal"):
        imp.load("products/products.json", ("name", "kcal"), ("kcal",))
    (tmp_path / "products/products.json").write_text('[{"name": "Хлеб", "kcal": 250},]', encoding="utf-8")
    with pytest.raises(SystemExit, match="ошибка JSON в строке 1"):
        imp.load("products/products.json")


def test_food_log_delete(client, seeded):
    h, other = new_user_headers(), new_user_headers()
    pid = client.get("/api/products/search", params={"q": "творог 5%"}).json()[0]["id"]
    log_id = client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, "meal_type": "snack"}).json()["id"]
    assert client.delete(f"/api/food-logs/{log_id}", headers=other).status_code == 404  # not yours
    assert client.delete(f"/api/food-logs/{log_id}", headers=h).json() == {"ok": True}
    assert client.get("/api/food-logs", headers=h).json()["items"] == []
    assert client.delete(f"/api/food-logs/{log_id}", headers=h).status_code == 404


def test_measurements(client):
    from datetime import date, timedelta

    h, other = new_user_headers(), new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)  # weight 78.4
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    first = client.put("/api/measurements", headers=h, json={"weight_kg": 77.9, "waist_cm": 84}).json()
    assert first["xp_awarded"] == 15 and first["measured_on"] == date.today().isoformat()
    again = client.put("/api/measurements", headers=h, json={"weight_kg": 77.5, "waist_cm": 83.5}).json()
    assert again["id"] == first["id"] and again["xp_awarded"] == 0  # same day: overwritten, no extra XP
    assert client.get("/api/profile", headers=h).json()["weight_kg"] == 77.5  # targets follow latest weight

    old = client.put("/api/measurements", headers=h, json={"measured_on": yesterday, "weight_kg": 80}).json()
    assert old["xp_awarded"] == 15
    assert client.get("/api/profile", headers=h).json()["weight_kg"] == 77.5  # older entry doesn't override

    rows = client.get("/api/measurements", headers=h).json()
    assert [r["weight_kg"] for r in rows] == [77.5, 80]  # newest first
    assert client.get("/api/measurements", headers=other).json() == []

    assert client.put("/api/measurements", headers=h, json={}).status_code == 422
    assert client.put("/api/measurements", headers=h, json={"weight_kg": 5}).status_code == 422
    future = (date.today() + timedelta(days=5)).isoformat()
    assert client.put("/api/measurements", headers=h, json={"measured_on": future, "weight_kg": 70}).status_code == 422

    assert client.delete(f"/api/measurements/{old['id']}", headers=other).status_code == 404
    assert client.delete(f"/api/measurements/{old['id']}", headers=h).json() == {"ok": True}
    assert len(client.get("/api/measurements", headers=h).json()) == 1


EXTENDED = {
    "experience": "beginner", "equipment": ["bodyweight", "dumbbells"], "sessions_per_week": 2, "session_minutes": 45,
    "allergies": ["nuts"], "meals_per_day": 4, "sleep_hours": 6.5, "stress": "high", "injury": "knees",
}


def test_extended_questionnaire_and_program_recommendation(client, seeded):
    h = new_user_headers()
    client.post("/api/consent", headers=h, json={"health": True})  # allergies and injuries need it
    saved = client.put("/api/profile", headers=h, json={**PROFILE, **EXTENDED}).json()
    assert {k: saved[k] for k in EXTENDED} == EXTENDED

    rec = client.post("/api/auth", headers=h).json()["recommended_program"]
    programs = {p["id"]: p["name"] for p in client.get("/api/programs").json()}
    assert programs[rec["program_id"]] == "Домашняя тренировка (без инвентаря)"  # beginner, 2 days, no barbell

    gym = {**EXTENDED, "experience": "intermediate", "sessions_per_week": 3,
           "equipment": ["barbell", "bench", "pullup_bar", "dumbbells", "machine"]}
    client.put("/api/profile", headers=h, json={**PROFILE, **gym})
    rec = client.post("/api/auth", headers=h).json()["recommended_program"]
    assert programs[rec["program_id"]] == "Тяни-Толкай-Ноги (PPL)" and "всё оборудование у тебя есть" in rec["reasons"]

    # the self-test caps a stated level: "advanced" who can't do 10 push-ups gets a program for today's form
    weak = {**gym, "experience": "advanced", "squats": "lt15", "pushups": "lt10", "pullups": "none", "body_now": 6,
            "body_target": 2, "place": "gym", "focus": ["belly", "arms"], "target_weight_kg": 76}
    saved = client.put("/api/profile", headers=h, json={**PROFILE, **weak}).json()
    assert {k: saved[k] for k in ("squats", "pushups", "pullups", "body_now", "body_target", "place", "focus", "target_weight_kg")} == \
        {"squats": "lt15", "pushups": "lt10", "pullups": "none", "body_now": 6, "body_target": 2, "place": "gym", "focus": ["belly", "arms"], "target_weight_kg": 76}
    from backend.core.programs import tested_level, training_level
    from types import SimpleNamespace as P
    assert training_level(P(experience="advanced", squats="lt15", pushups="lt10", pullups="none")) == ("beginner", True)
    assert training_level(P(experience="beginner", squats="gt30", pushups="gt20", pullups="gt10")) == ("beginner", False)  # not raised
    assert tested_level(P(squats="unknown", pushups=None, pullups=None)) is None
    assert client.put("/api/profile", headers=h, json={**PROFILE, **weak, "body_now": 9}).status_code == 422

    # old-style profile (no extended answers) is still valid; the target weight set before is kept
    old = client.put("/api/profile", headers=h, json=PROFILE).json()
    assert old["experience"] is None and old["target_weight_kg"] == 76


@pytest.mark.parametrize("bad", [
    {"equipment": ["spaceship"]}, {"sessions_per_week": 9}, {"session_minutes": 25}, {"meals_per_day": 7},
    {"sleep_hours": 20}, {"stress": "extreme"}, {"injury": "toe"}, {"allergies": ["pizza"]}, {"goal": "lose"},
])
def test_extended_validation(client, bad):
    h = new_user_headers()
    assert client.put("/api/profile", headers=h, json={**PROFILE, **EXTENDED, **bad}).status_code == 422


def test_old_goals_migrated_on_startup(client):
    from sqlalchemy import text

    from backend.database.db import SessionLocal, init_db
    from backend.database.models import Profile

    h = new_user_headers()
    uid = client.post("/api/auth", headers=h).json()["id"]

    async def run():
        async with SessionLocal() as s:
            s.add(Profile(user_id=uid, sex="male", birth_year=1998, height_cm=182, weight_kg=78, activity="moderate", goal="maintain"))
            await s.commit()
        await init_db()
        async with SessionLocal() as s:
            return await s.scalar(text("select goal from profiles where user_id = :u").bindparams(u=uid))

    assert client.portal.call(run) == "maintenance"


def test_water_tracker(client):
    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)  # 78.4 kg -> 2587 ml -> 2500 ml goal
    assert client.get("/api/water", headers=h).json() == {"ml": 0, "goal_ml": 2500}

    for _ in range(9):
        r = client.post("/api/water", headers=h, json={"delta_ml": 250}).json()
    assert r == {"ml": 2250, "goal_ml": 2500, "xp_awarded": 0}
    assert client.post("/api/water", headers=h, json={"delta_ml": 250}).json()["xp_awarded"] == 10
    assert client.post("/api/water", headers=h, json={"delta_ml": 250}).json()["xp_awarded"] == 0  # once a day
    assert client.post("/api/water", headers=h, json={"delta_ml": -1000}).json()["ml"] == 1750
    for _ in range(3):
        last = client.post("/api/water", headers=h, json={"delta_ml": -1000}).json()
    assert last["ml"] == 0  # never negative
    assert client.post("/api/water", headers=h, json={"delta_ml": 5000}).status_code == 422
    assert client.get("/api/water", headers=new_user_headers()).json() == {"ml": 0, "goal_ml": 2000}  # no profile


def test_week_and_streak(client, seeded):
    from datetime import date, timedelta

    from sqlalchemy import update

    from backend.database.db import SessionLocal
    from backend.database.models import FoodLog, WaterIntake

    h = new_user_headers()
    uid = client.post("/api/auth", headers=h).json()["id"]
    assert client.get("/api/week", headers=h).json()["streak"] == 0

    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    log_id = client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 200, "meal_type": "lunch"}).json()["id"]

    async def backdate():
        from datetime import datetime, time

        async with SessionLocal() as s:
            two_days_ago = datetime.combine(date.today() - timedelta(days=2), time(12)).astimezone()
            await s.execute(update(FoodLog).where(FoodLog.id == log_id).values(logged_at=two_days_ago))
            s.add(WaterIntake(user_id=uid, day=date.today() - timedelta(days=1), ml=500))
            await s.commit()

    client.portal.call(backdate)
    week = client.get("/api/week", headers=h).json()
    assert week["streak"] == 2  # 2 days ago food + yesterday water; empty today doesn't break it
    assert [d["date"] for d in week["days"]][-1] == date.today().isoformat() and len(week["days"]) == 7
    assert week["days"][-3]["kcal"] == 242 and week["days"][-2]["water_ml"] == 500

    client.post("/api/water", headers=h, json={"delta_ml": 250})
    assert client.get("/api/week", headers=h).json()["streak"] == 3


def test_recent_favorites_and_copy_meal(client, seeded):
    from datetime import date, datetime, time, timedelta

    from sqlalchemy import update

    from backend.database.db import SessionLocal
    from backend.database.models import FoodLog

    h = new_user_headers()
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    assert client.get("/api/products/recent", headers=h).json() == []

    ids = [client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": g, "meal_type": "breakfast"}).json()["id"]
           for g in (150, 200)]
    recent = client.get("/api/products/recent", headers=h).json()
    assert [(p["id"], p["last_amount_g"]) for p in recent] == [(pid, 200)]  # deduplicated, last portion
    assert recent[0]["meals"] == {"breakfast": 2}  # the app puts a meal's usual products first

    # favourites: idempotent add, unknown product rejected, remove
    assert client.put(f"/api/favorites/{pid}", headers=h).status_code == 200
    assert client.put(f"/api/favorites/{pid}", headers=h).status_code == 200
    assert [p["id"] for p in client.get("/api/favorites", headers=h).json()] == [pid]
    assert client.put("/api/favorites/999999", headers=h).status_code == 404
    assert client.get("/api/favorites", headers=new_user_headers()).json() == []  # per user
    client.delete(f"/api/favorites/{pid}", headers=h)
    assert client.get("/api/favorites", headers=h).json() == []

    # copy yesterday's breakfast into today
    async def to_yesterday():
        async with SessionLocal() as s:
            y = datetime.combine(date.today() - timedelta(days=1), time(9)).astimezone()
            await s.execute(update(FoodLog).where(FoodLog.id.in_(ids)).values(logged_at=y))
            await s.commit()
    client.portal.call(to_yesterday)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    r = client.post("/api/food-logs/copy", headers=h, json={"from_day": yesterday, "meal_type": "breakfast"}).json()
    assert r == {"copied": 2, "xp_awarded": 0}  # breakfast XP for today was granted when they were first logged
    day = client.get("/api/food-logs", headers=h).json()
    assert [i["amount_g"] for i in day["items"]] == [150, 200]
    assert client.post("/api/food-logs/copy", headers=h, json={"from_day": yesterday, "meal_type": "dinner"}).status_code == 404
    today = date.today().isoformat()
    assert client.post("/api/food-logs/copy", headers=h, json={"from_day": today, "meal_type": "breakfast"}).status_code == 422
    # another user can't copy someone else's meal
    assert client.post("/api/food-logs/copy", headers=new_user_headers(), json={"from_day": yesterday, "meal_type": "breakfast"}).status_code == 404


def test_off_parse():
    from backend.core.off import parse

    ok = {"status": 1, "product": {"product_name": "Milk", "product_name_ru": "Молоко 3,2%", "brands": "Простоквашино, ПепсиКо",
          "nutriments": {"energy-kcal_100g": 59, "proteins_100g": 2.9, "fat_100g": 3.2, "carbohydrates_100g": 4.7}}}
    assert parse(ok) == {"name": "Молоко 3,2%", "brand": "Простоквашино", "kcal": 59, "protein_g": 2.9, "fat_g": 3.2, "carbs_g": 4.7}
    kj = {"status": 1, "product": {"product_name": "Сок", "nutriments": {"energy_100g": 188}}}
    assert parse(kj)["kcal"] == 45 and parse(kj)["protein_g"] == 0  # kJ converted, missing macros = 0
    quoted = {"status": 1, "product": {"product_name": "Сок &quot;яблоко вишня&quot;", "brands": "Сады &amp; Ко",
              "nutriments": {"energy-kcal_100g": 45}}}
    assert (parse(quoted)["name"], parse(quoted)["brand"]) == ('Сок "яблоко вишня"', "Сады & Ко")
    assert parse({"status": 0}) is None
    assert parse({"status": 1, "product": {"product_name": "Без КБЖУ", "nutriments": {}}}) is None
    assert parse({"status": 1, "product": {"product_name": "Мусор", "nutriments": {"energy-kcal_100g": 5000}}}) is None


def test_off_units_from_package_and_serving():
    from backend.core.off import units

    assert units({"quantity": "500 мл", "serving_size": "200 мл", "serving_quantity": 200}) == {
        "piece_g": 500.0, "piece_name": "упаковка", "portion_g": 200.0, "portion_name": "порция", "ml_g": 1.0}
    assert units({"quantity": "6 x 50 г"}) == {"piece_g": 50.0, "piece_name": "шт", "portion_g": 300.0, "portion_name": "упаковка"}
    assert units({"quantity": "40 г", "serving_size": "1 батончик (40 г)", "serving_quantity": 40}) == {"piece_g": 40.0, "piece_name": "шт"}
    assert units({"product_quantity": "330", "product_quantity_unit": "ml"})["ml_g"] == 1.0
    assert units({"quantity": "0.33l"})["piece_g"] == 330.0
    assert units({"quantity": "5 л"}) == {"ml_g": 1.0}  # too big to be "one", still counted in ml
    assert units({}) == {} and units({"quantity": "без веса"}) == {}


def test_barcode_lookup_and_custom_product(client, monkeypatch):
    import random

    import httpx

    from backend.core import off

    code = "46" + "".join(random.choices("0123456789", k=11))  # fresh per run: the local test DB persists
    calls = []

    async def fake_fetch(c):
        calls.append(c)
        if c == code:
            return {"name": f"Ряженка {code}", "brand": "Тестовый завод", "kcal": 67, "protein_g": 2.8, "fat_g": 4.0, "carbs_g": 4.2}
        if c == "4600000000024":
            raise httpx.ConnectError("offline")
        return None

    monkeypatch.setattr(off, "fetch", fake_fetch)
    h = new_user_headers()
    r = client.get(f"/api/products/barcode/{code}", headers=h)
    assert r.status_code == 200 and r.json()["name"] == f"Ряженка {code}"
    pid = r.json()["id"]
    # second scan (any user) is served from our catalog, no network
    assert client.get(f"/api/products/barcode/{code}", headers=new_user_headers()).json()["id"] == pid
    assert calls == [code]
    assert client.get("/api/products/search", params={"q": f"ряженка {code}"}).json()[0]["id"] == pid  # shared catalog now

    assert client.get("/api/products/barcode/4600000000031", headers=h).status_code == 404
    assert client.get("/api/products/barcode/4600000000024", headers=h).status_code == 503
    assert client.get("/api/products/barcode/12ab", headers=h).status_code == 422

    # custom product: private to its author
    body = {"name": " Сырник домашний ", "kcal": 220, "protein_g": 15, "fat_g": 9, "carbs_g": 20}
    p = client.post("/api/products", headers=h, json=body).json()
    assert p["name"] == "Сырник домашний"
    assert [x["id"] for x in client.get("/api/products/search", params={"q": "сырник домашний"}, headers=h).json()] == [p["id"]]
    assert client.get("/api/products/search", params={"q": "сырник домашний"}, headers=new_user_headers()).json() == []
    assert client.post("/api/products", headers=h, json={**body, "protein_g": 60, "fat_g": 30, "carbs_g": 20}).status_code == 422

    # unknown code -> user's own product remembered for that code (only for them)
    unknown = "47" + code[2:]
    assert client.get(f"/api/products/barcode/{unknown}", headers=h).status_code == 404
    mine = client.post("/api/products", headers=h, json={**body, "name": "Йогурт Ирбитский", "barcode": unknown}).json()
    n = len(calls)
    assert client.get(f"/api/products/barcode/{unknown}", headers=h).json()["id"] == mine["id"]
    assert len(calls) == n  # served locally
    assert client.get(f"/api/products/barcode/{unknown}", headers=new_user_headers()).status_code == 404
    assert client.get(f"/api/products/barcode/0{code}", headers=h).json()["id"] == pid  # GTIN-14 form of the EAN
    assert client.post("/api/products", headers=h, json={**body, "kcal": 2000}).status_code == 422


def test_several_snacks_a_day(client, seeded):
    h = new_user_headers()
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    add = lambda **kw: client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, **kw})
    assert add(meal_type="snack", snack_slot="11:30").json()["snack_slot"] == "11:30"
    assert add(meal_type="snack", snack_slot="11:30").json()["snack_slot"] == "11:30"  # same snack
    auto = add(meal_type="snack").json()["snack_slot"]  # new snack at the current time
    assert auto and len(auto) == 5 and auto[2] == ":"
    assert add(meal_type="lunch", snack_slot="12:00").json()["snack_slot"] is None  # only snacks have slots
    assert add(meal_type="snack", snack_slot="25:00").status_code == 422
    slots = sorted({i["snack_slot"] for i in client.get("/api/food-logs", headers=h).json()["items"] if i["meal_type"] == "snack"})
    assert slots == sorted({"11:30", auto})


def test_reminder_settings_and_collect(client, seeded):
    from datetime import datetime

    from backend.bot.reminders import collect, due
    from backend.database.db import SessionLocal

    now = datetime.now().astimezone()
    assert due("14:00", now.replace(hour=14, minute=20)) and not due("14:00", now.replace(hour=15, minute=0))
    assert not due("14:00", now.replace(hour=13, minute=59))

    import random

    from conftest import USER, make_init_data

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    assert client.get("/api/reminders", headers=h).json()["lunch_at"] == "14:00"  # defaults
    bad = {"meals": True, "water": True, "streak": True, "breakfast_at": "9:00", "lunch_at": "14:00", "dinner_at": "20:00", "streak_at": "21:00"}
    assert client.put("/api/reminders", headers=h, json=bad).status_code == 422
    cfg = {**bad, "breakfast_at": "09:00", "water": False}
    assert client.put("/api/reminders", headers=h, json=cfg).json().items() >= cfg.items()  # + weekly defaults
    client.put("/api/profile", headers=h, json=PROFILE)  # reminders go to registered users only

    async def run(at):
        async with SessionLocal() as s:
            return await collect(s, now.replace(hour=at[0], minute=at[1], second=0, microsecond=0))

    def texts(at):
        return [t for chat, t, _, _ in client.portal.call(run, at) if chat == tg_id]  # other test users get theirs too

    lunch = texts((14, 5))
    assert any("обед" in t for t in lunch)
    assert not any("обед" in t for t in texts((14, 6)))  # sent once
    assert not any("Выпито" in t for t in texts((12, 5)))  # water reminders switched off for this user

    # lunch already logged -> no dinner nag for lunch, but dinner still reminded at its time
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, "meal_type": "dinner"})
    assert not any("ужин" in t for t in texts((20, 1)))
    # defaults (water on): behind schedule at noon -> one water reminder with liters in Russian format
    tg2 = random.randint(3 * 10**9, 4 * 10**9)
    h2 = {"Authorization": f"tma {make_init_data({**USER, 'id': tg2})}"}
    client.put("/api/profile", headers=h2, json=PROFILE)
    client.post("/api/water", headers=h2, json={"delta_ml": 250})
    noon = [(t, card) for chat, t, card, _ in client.portal.call(run, (12, 1)) if chat == tg2]
    assert [t for t, _ in noon] == ["💧 Выпито 0,25 л из 2,5 л. Стакан воды сейчас — самое время."]
    assert noon[0][1]().startswith(b"\x89PNG")  # the card renders


def test_user_products_become_shared_after_three_confirmations(client):
    import random

    tag = random.randint(10**5, 10**6)  # the local test DB persists between runs
    dish = {"name": f"Пепперони 30 см {tag}", "brand": "Додо", "kcal": 260, "protein_g": 11, "fat_g": 10, "carbs_g": 30,
            "portion_g": 610, "portion_name": "пицца"}
    users = [new_user_headers() for _ in range(4)]
    find = lambda h: client.get("/api/products/search", params={"q": f"пепперони 30 см {tag}"}, headers=h).json()

    a = client.post("/api/products", headers=users[0], json=dish).json()
    assert a["shared"] is False and a["portion_g"] == 610
    again = client.post("/api/products", headers=users[0], json={**dish, "kcal": 262}).json()
    assert again["id"] == a["id"]  # same user, same name+brand: updated, not duplicated
    client.post("/api/products", headers=users[1], json={**dish, "kcal": 400})  # disagrees: doesn't count
    assert client.post("/api/products", headers=users[2], json={**dish, "kcal": 258}).json()["shared"] is False
    third = client.post("/api/products", headers=users[3], json={**dish, "protein_g": 11.5}).json()
    assert third["shared"] is True and third["xp_awarded"] == 25  # the one who completed it
    xp = lambda h: client.post("/api/auth", headers=h).json()["progress"]["xp"]  # noqa: E731
    assert [xp(h) for h in users] == [25, 0, 25, 25]  # every author whose numbers agreed; the outlier gets nothing
    shared = [p for p in find(new_user_headers()) if p["category"] == "Проверено пользователями"]
    assert len(shared) == 1 and shared[0]["kcal"] == 260 and shared[0]["portion_g"] == 610  # average of the 3 that agree
    # no brand -> stays private no matter how many people enter it
    plain = {**dish, "brand": None, "name": f"Сырник домашний {tag}"}
    assert not any(client.post("/api/products", headers=h, json=plain).json()["shared"] for h in users)

    # barcode: 3 users enter the same unknown code -> everyone finds it by scanning
    code = "48" + str(random.randint(10**10, 10**11 - 1))
    pack = {"piece_g": 900, "piece_name": "упаковка", "ml_g": 1}  # read from the label: 900 ml bottle
    for h in users[:3]:
        r = client.post("/api/products", headers=h, json={**plain, "name": f"Кефир {tag}", "barcode": code, **pack}).json()
    assert r["shared"] is True and r["piece_g"] == 900
    found = client.get(f"/api/products/barcode/{code}", headers=new_user_headers()).json()
    assert found["category"] == "Проверено пользователями" and (found["piece_g"], found["piece_name"], found["ml_g"]) == (900, "упаковка", 1)
    assert client.post("/api/products", headers=users[0], json={**plain, "name": "Странный", "ml_g": 7}).status_code == 422


NEW_CONSENT = {"consent": False, "health_consent": False, "privacy_url": None}


def test_settings_are_kept_on_the_account(client, seeded):
    h = new_user_headers()
    assert client.post("/api/auth", headers=h).json()["settings"] == {"theme": None, "accent": None, "program_id": None, "boost_until": None, "device_tz": None, **NEW_CONSENT}
    pid = client.get("/api/programs").json()[0]["id"]
    assert client.put("/api/settings", headers=h, json={"theme": "green"}).json() == {"theme": "green", "accent": None, "program_id": None, "boost_until": None, "device_tz": None, **NEW_CONSENT}
    assert client.put("/api/settings", headers=h, json={"accent": "#a98bff", "program_id": pid}).json()["theme"] == "green"  # partial
    assert client.post("/api/auth", headers=h).json()["settings"] == {"theme": "green", "accent": "#a98bff", "program_id": pid, "boost_until": None, "device_tz": None, **NEW_CONSENT}
    assert client.put("/api/settings", headers=h, json={"program_id": None}).json()["program_id"] is None
    assert client.put("/api/settings", headers=h, json={"theme": "neon"}).status_code == 422
    assert client.put("/api/settings", headers=h, json={"accent": "red"}).status_code == 422
    assert client.put("/api/settings", headers=h, json={"program_id": 999999}).status_code == 404


def test_bot_profile_synced_only_when_changed(tmp_path, monkeypatch):
    import asyncio

    from backend.bot import profile

    calls = []

    class FakeBot:
        async def set_my_name(self, name):
            calls.append("name")
            assert 0 < len(name) <= 64

        async def set_my_description(self, description):
            calls.append("description")
            assert len(description) <= 512

        async def set_my_short_description(self, short_description):
            calls.append("short")
            assert len(short_description) <= 120

        async def set_my_profile_photo(self, photo):
            calls.append("photo")

    monkeypatch.setattr(profile, "STAMP", tmp_path / ".bot_profile")
    asyncio.run(profile.sync(FakeBot()))
    asyncio.run(profile.sync(FakeBot()))
    assert calls == ["name", "description", "short", "photo"]  # second start: nothing changed, nothing re-uploaded
    monkeypatch.setattr(profile, "SHORT_DESCRIPTION", profile.SHORT_DESCRIPTION + "!")
    asyncio.run(profile.sync(FakeBot()))
    assert len(calls) == 8


def test_cards_render_in_every_theme():
    from backend.bot import cards

    for theme in (None, "dark", "light", "green"):
        for png in (
            cards.welcome(theme, "#a98bff"),
            cards.meal("Обед", 2600, 2375, {"Белки": (170, 160), "Жиры": (0, 72), "Углеводы": (10, 0)}, theme),
            cards.water(0, 2500, "12:00", theme),
            cards.water(3000, 2500, "19:00", theme),
            cards.streak(365, [True] * 6 + [False], theme),
            cards.today("Осталось", "874 ккал", 1240, 2114, ["Вода 1,2 из 2,3 л", "Серия 12 дн.", "Тренировка сегодня"], "22 ноября", theme),
            cards.today("Норма", "набрана", 2900, 2114, ["Вода 0 из 2,3 л"], "1 января", theme, "#a98bff"),
            cards.share("Егор", 21, 1340, 4, 7, theme, "#a98bff"),
            cards.story_week("Константин Константинопольский", 365, 123456, 21, 40, "setly_bot", theme, "#a98bff"),
            cards.story_duel("Егор", "Александра", 12345, 9999, "xp", 7, True, "", theme),
            cards.story_duel("Егор", "Саша", 3, 1, "workouts", 3, False, "setly_bot", theme),
        ):
            assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) < 400_000


def test_bot_greeting_handles_empty_and_invisible_names():
    from backend.bot.main import UNFINISHED, WELCOME, clean_name

    assert clean_name("Егор") == "Егор" and clean_name("Анна Мария") == "Анна Мария"
    assert clean_name("\u00ad") == "друг"  # soft hyphen only: Telegram shows it as blank
    assert clean_name("\u200b \u2063") == "друг" and clean_name(None) == "друг"
    assert clean_name("<b>Хакер</b>") == "&lt;b&gt;Хакер&lt;/b&gt;"  # HTML caption
    assert WELCOME.format(name="Егор").startswith("Привет, Егор! 👋") and "Анкета ещё ждёт" in UNFINISHED


def test_bot_greets_a_returning_user_with_their_day(client, seeded):
    import random

    from backend.bot import chat
    from backend.database.db import SessionLocal
    from backend.database.models import Profile, User
    from sqlalchemy import select

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)

    async def greet():
        async with SessionLocal() as s:
            user = await s.scalar(select(User).where(User.telegram_id == tg_id))
            return await chat.day_greeting(s, user, await s.get(Profile, user.id), "Егор")

    text, card, _ = client.portal.call(greet)
    assert ", Егор! " in text and "Сегодня пока пусто" in text and card["accent_line"] == "пока пусто"
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 200, "meal_type": "lunch"})
    text, card, _ = client.portal.call(greet)
    assert "Сегодня 242 из" in text and "Осталось" in text and card["eaten"] == 242 and card["title"] == "Осталось"
    assert card["chips"][0].startswith("Вода 0 из")


def test_stats_for_charts(client, seeded):
    from datetime import date

    h = new_user_headers()
    assert client.get("/api/stats", headers=h).json()["goal"] is None  # no questionnaire yet
    client.put("/api/profile", headers=h, json=PROFILE)
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 200, "meal_type": "lunch"})
    client.post("/api/water", headers=h, json={"delta_ml": 500})
    client.put("/api/measurements", headers=h, json={"weight_kg": 78.0})
    day_id = client.get("/api/programs").json()[0]["days"][0]["id"]
    ex_id = client.get("/api/programs").json()[0]["days"][0]["exercises"][0]["exercise_id"]
    w = client.post("/api/workout-logs", headers=h, json={"program_day_id": day_id, "title": "День 1"}).json()
    for n, (reps, kg) in enumerate([(10, 50), (8, 60), (12, 60)], 1):
        client.post(f"/api/workout-logs/{w['id']}/sets", headers=h, json={"exercise_id": ex_id, "set_number": n, "reps": reps, "weight_kg": kg})
    client.post(f"/api/workout-logs/{w['id']}/complete", headers=h)

    s = client.get("/api/stats", params={"days": 7}, headers=h).json()
    assert len(s["days"]) == 7 and s["days"][-1]["date"] == date.today().isoformat()
    today = s["days"][-1]
    assert (today["kcal"], today["water_ml"], today["workouts"]) == (242, 500, 1) and today["protein"] > 0
    assert s["days"][0]["kcal"] == 0  # empty days are present, as zeros
    assert s["goal"]["calories"] > 1000 and s["goal"]["water_ml"] == 2500
    assert s["weight"] == [{"date": date.today().isoformat(), "kg": 78.0}]
    assert s["exercises"][0]["points"] == [{"date": date.today().isoformat(), "kg": 60, "reps": 12}]  # heaviest, then most reps
    assert client.get("/api/stats", params={"days": 3}, headers=h).status_code == 422


def test_streak_freeze_earned_and_spent(client):
    from datetime import date, timedelta

    from sqlalchemy import delete

    from backend.database.db import SessionLocal
    from backend.database.models import WaterIntake

    h = new_user_headers()
    uid = client.post("/api/auth", headers=h).json()["id"]
    today = date.today()

    async def water_days(*offsets):
        async with SessionLocal() as s:
            s.add_all(WaterIntake(user_id=uid, day=today - timedelta(days=o), ml=250) for o in offsets)
            await s.commit()

    async def drop_yesterday():
        async with SessionLocal() as s:
            await s.execute(delete(WaterIntake).where(WaterIntake.user_id == uid, WaterIntake.day == today - timedelta(days=1)))
            await s.commit()

    client.portal.call(water_days, *range(1, 8))  # 7 days up to yesterday
    xp0 = client.post("/api/auth", headers=h).json()["progress"]["xp"]
    w = client.get("/api/week", headers=h).json()
    assert (w["streak"], w["freezes"]) == (7, 1)
    assert client.post("/api/auth", headers=h).json()["progress"]["xp"] == xp0 + 20
    assert client.get("/api/week", headers=h).json()["freezes"] == 1  # earned once per week of streak

    client.portal.call(drop_yesterday)  # missed yesterday -> the freeze covers it
    w = client.get("/api/week", headers=h).json()
    assert (w["streak"], w["freezes"]) == (7, 0) and w["days"][-2]["frozen"] is True
    assert client.get("/api/week", headers=h).json()["streak"] == 7  # stays covered, no double spend


def test_achievements_unlock_once(client, seeded):
    h = new_user_headers()
    a = client.get("/api/achievements", headers=h).json()
    assert a["new"] == [] and all(i["unlocked_at"] is None for i in a["items"])
    first = next(i for i in a["items"] if i["code"] == "first_meal")
    assert (first["progress"], first["target"]) == (0, 1)

    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, "meal_type": "lunch"})
    xp0 = client.post("/api/auth", headers=h).json()["progress"]["xp"]
    a = client.get("/api/achievements", headers=h).json()
    assert [i["code"] for i in a["new"]] == ["first_meal"]
    assert client.post("/api/auth", headers=h).json()["progress"]["xp"] == xp0 + 25
    assert client.get("/api/achievements", headers=h).json()["new"][0]["code"] == "first_meal"  # until seen
    client.post("/api/achievements/seen", headers=h)
    assert client.get("/api/achievements", headers=h).json()["new"] == []
    assert client.post("/api/auth", headers=h).json()["progress"]["xp"] == xp0 + 25  # no second award


def test_weekly_summary_on_sunday(client, seeded, monkeypatch):
    import random
    from datetime import datetime, timedelta

    from backend.api import ai as ai_api
    from backend.bot.reminders import collect
    from backend.database.db import SessionLocal
    from conftest import USER, make_init_data

    async def tip(session, user):
        return "Совет: больше белка на ужин."
    monkeypatch.setattr(ai_api, "weekly_tip", tip)

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 300, "meal_type": "lunch"})

    now = datetime.now().astimezone()
    sunday = (now + timedelta(days=(6 - now.weekday()) % 7)).replace(hour=19, minute=3, second=0, microsecond=0)
    monday = (sunday + timedelta(days=1))

    async def run(at):
        async with SessionLocal() as s:
            got = [(t, card, b) for chat, t, card, b in await collect(s, at) if chat == tg_id]
            buttons.extend(b for _, _, b in got if b)
            return [(t, card) for t, card, _ in got]

    buttons = []
    assert not any("Итоги недели" in t for t, _ in client.portal.call(run, monday))  # only on Sundays
    weekly = [(t, card) for t, card in client.portal.call(run, sunday) if "Итоги недели" in t]
    if sunday.date() == now.date():  # the food entry is inside that week only when the test runs on a Sunday
        assert "в среднем" in weekly[0][0]
    assert len(weekly) == 1 and weekly[0][0].endswith("Совет: больше белка на ужин.")
    assert weekly[0][1]()[:4] == b"\x89PNG"
    assert buttons == [[("📸 Неделя в историю", "app:open=story")]]
    assert not any("Итоги недели" in t for t, _ in client.portal.call(run, sunday))  # once
    off = client.get("/api/reminders", headers=h).json() | {"weekly": False}
    assert client.put("/api/reminders", headers=h, json=off).json()["weekly"] is False


def test_menu_button_follows_tunnel_address(monkeypatch):
    import asyncio

    from backend.bot import main as bot_main

    calls = []

    class FakeBot:
        async def set_chat_menu_button(self, chat_id=None, menu_button=None):
            calls.append(menu_button.web_app.url)

    async def run(urls):
        shown = None
        for u in urls:
            monkeypatch.setattr(bot_main, "current_webapp_url", lambda u=u: u)
            shown = await bot_main.sync_menu_button(FakeBot(), shown)
        return shown

    last = asyncio.run(run(["https://a.lhr.life", "https://a.lhr.life", "http://localhost:8000", "https://b.lhr.life"]))
    assert calls == ["https://a.lhr.life", "https://b.lhr.life"]  # once per change, never a non-https address
    assert last == "https://b.lhr.life"


def test_timezone_follows_the_phone(client, seeded):
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo

    from backend.bot.reminders import collect
    from backend.database.db import SessionLocal

    h = new_user_headers()
    ahead = {**h, "X-Timezone": "Pacific/Kiritimati"}  # UTC+14: usually already "tomorrow" for the server
    assert client.get("/api/settings", headers=ahead).json()["device_tz"] == "Pacific/Kiritimati"
    assert client.get("/api/settings", headers={**h, "X-Timezone": "Mars/Base"}).json()["device_tz"] == "Pacific/Kiritimati"
    their_today = datetime.now(ZoneInfo("Pacific/Kiritimati")).date().isoformat()
    assert client.get("/api/food-logs", headers=ahead).json()["date"] == their_today
    client.post("/api/water", headers=ahead, json={"delta_ml": 300})
    last = client.get("/api/week", headers=ahead).json()["days"][-1]
    assert (last["date"], last["water_ml"]) == (their_today, 300)

    # travelling: the phone's new zone moves "today" with it
    behind = {**h, "X-Timezone": "Pacific/Pago_Pago"}
    assert client.get("/api/food-logs", headers=behind).json()["date"] == datetime.now(ZoneInfo("Pacific/Pago_Pago")).date().isoformat()

    # reminders fire at the user's own clock: 14:05 in Kiritimati
    client.put("/api/profile", headers=ahead, json=PROFILE)
    tg_id = client.post("/api/auth", headers=ahead).json()["telegram_id"]
    at = datetime.now(ZoneInfo("Pacific/Kiritimati")).replace(hour=14, minute=5, second=0, microsecond=0).astimezone(timezone.utc)

    async def run(t):
        async with SessionLocal() as s:
            return [txt for chat, txt, _, _ in await collect(s, t) if chat == tg_id]
    assert any("обед" in t for t in client.portal.call(run, at))
    assert not any("обед" in t for t in client.portal.call(run, at - timedelta(hours=3)))


def test_friends_leaderboard_duels_and_share(client, seeded, monkeypatch):
    import random
    from datetime import date, datetime, timedelta, timezone

    from sqlalchemy import select, update

    from backend.api import social
    from backend.database.db import SessionLocal
    from sqlalchemy.dialects.postgresql import insert

    from backend.database.models import Duel, Outbox, User, WaterIntake
    from conftest import USER, make_init_data

    monkeypatch.setattr(social, "bot_username", lambda: "setly_test_bot")
    ids = [random.randint(3 * 10**9, 4 * 10**9) for _ in range(2)]
    ha, hb = ({"Authorization": f"tma {make_init_data({**USER, 'id': i, 'first_name': n})}"} for i, n in zip(ids, ("Аня", "Борис")))
    link = client.get("/api/friends", headers=ha).json()["invite_link"]
    assert link.startswith("https://t.me/setly_test_bot?start=f")
    code = link.split("start=f")[1]

    def db(fn, *a):
        async def run():
            async with SessionLocal() as s:
                return await fn(s, *a)
        return client.portal.call(run)

    assert db(social.befriend, code, ids[1], "Борис").first_name == "Аня"  # Борис opened Аня's link (new user)
    assert db(social.befriend, code, ids[1], "Борис") is None  # already friends
    assert db(social.befriend, code, ids[0], "Аня") is None  # own link
    assert db(social.befriend, "nope", ids[1], "Борис") is None
    xp = lambda h: client.post("/api/auth", headers=h).json()["progress"]["xp"]  # noqa: E731

    # duels only between registered users
    a_id = client.post("/api/auth", headers=ha).json()["id"]
    b_id = client.post("/api/auth", headers=hb).json()["id"]
    client.put("/api/profile", headers=ha, json=PROFILE)
    assert client.post("/api/duels", headers=ha, json={"friend_id": b_id, "metric": "xp", "days": 3}).status_code == 403
    client.put("/api/profile", headers=hb, json=PROFILE)

    # invite XP only after the invited friend is active on 3 days (an empty fake account earns nothing)
    async def invite_check(s, active_days):
        await s.execute(update(User).where(User.id == b_id).values(created_at=datetime.now(timezone.utc) - timedelta(days=10)))
        for i in range(active_days):
            await s.execute(insert(WaterIntake).values(user_id=b_id, day=date.today() - timedelta(days=i + 1), ml=250).on_conflict_do_nothing())
        await s.commit()
        return await social.reward_invites(s)
    assert db(invite_check, 2) == 0 and xp(ha) == 0
    assert db(invite_check, 3) == 1 and xp(ha) == 50
    assert db(social.reward_invites) == 0  # once

    board = client.get("/api/friends", headers=ha).json()["board"]
    assert {(r["name"], r["me"], r["registered"]) for r in board} == {("Аня", True, True), ("Борис", False, True)}

    # duel flow
    assert client.post("/api/duels", headers=ha, json={"friend_id": 10**9, "metric": "xp", "days": 3}).status_code == 404
    d = client.post("/api/duels", headers=ha, json={"friend_id": b_id, "metric": "xp", "days": 3}).json()
    assert d["status"] == "pending" and not d["incoming"]
    assert client.post("/api/duels", headers=hb, json={"friend_id": a_id, "metric": "workouts", "days": 7}).status_code == 409
    assert client.post(f"/api/duels/{d['id']}/accept", headers=ha).status_code == 404
    assert client.get("/api/duels", headers=hb).json()[0]["incoming"] is True
    assert client.post(f"/api/duels/{d['id']}/accept", headers=hb).json()["status"] == "active"
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    for meal in ("breakfast", "lunch", "dinner"):  # Борис +30
        client.post("/api/food-logs", headers=hb, json={"product_id": pid, "amount_g": 100, "meal_type": meal})
    client.post("/api/food-logs", headers=ha, json={"product_id": pid, "amount_g": 100, "meal_type": "lunch"})  # Аня +10
    live = client.get("/api/duels", headers=ha).json()[0]
    assert (live["me"], live["them"], live["rival"]) == (10, 30, "Борис")

    async def time_up(s, age_days):  # accounts of a given age; the duel ends now
        old = datetime.now(timezone.utc) - timedelta(days=age_days)
        await s.execute(update(User).where(User.id.in_((a_id, b_id))).values(created_at=old))
        await s.execute(update(Duel).where(Duel.id == d["id"]).values(ends_at=datetime.now(timezone.utc)))
        await s.commit()
        return await social.finish_duels(s)
    assert db(time_up, 10) == 1
    b_xp = xp(hb)
    assert b_xp == 30 + 40  # meals + the duel bonus
    assert client.get("/api/duels", headers=ha).json()[0]["result"] == "loss"

    # Stories: the winner gets a 9:16 picture by a public short-lived link; the loser can't make one of this duel
    st = client.post("/api/story", headers=hb, json={"kind": "duel", "duel_id": d["id"]}).json()
    assert st["text"].startswith("Победа в дуэли") and "start=f" in st["text"] and st["link"].startswith("https://t.me/setly_test_bot")
    img = client.get(st["url"])  # no auth: Telegram downloads it
    assert img.status_code == 200 and img.content[:4] == b"\x89PNG"
    assert client.post("/api/story", headers=ha, json={"kind": "duel", "duel_id": d["id"]}).status_code == 404
    assert client.get("/api/story/" + "x" * 22 + ".png").status_code == 404
    wk = client.post("/api/story", headers=ha, json={"kind": "week"}).json()
    assert "подряд" in wk["text"] and client.get(wk["url"]).status_code == 200

    async def texts(s):
        return list(await s.scalars(select(Outbox.text).where(Outbox.telegram_id.in_(ids))))
    t = db(texts)
    assert any("+40 XP и бустер ×1,5" in x for x in t) and any("Реванш" in x for x in t) and any("вызывает тебя на дуэль" in x for x in t)
    assert any("+50 XP" in x for x in t)

    # the winner's boost: x1.5 for a day (water goal 10 -> 15)
    assert client.get("/api/settings", headers=hb).json()["boost_until"]
    for _ in range(5):
        client.post("/api/water", headers=hb, json={"delta_ml": 1000})
    assert xp(hb) == b_xp + 15
    assert client.get("/api/settings", headers=ha).json()["boost_until"] is None

    # a rematch right away: same pair within 14 days -> a win, but no reward
    d = client.post("/api/duels", headers=hb, json={"friend_id": a_id, "metric": "xp", "days": 3}).json()
    client.post(f"/api/duels/{d['id']}/accept", headers=ha)
    client.post("/api/food-logs", headers=ha, json={"product_id": pid, "amount_g": 100, "meal_type": "dinner"})
    assert db(time_up, 10) == 1
    assert any("без награды" in x.lower() for x in db(texts))

    # share: one queued card per tap burst; removing a friend works both ways
    client.post("/api/share", headers=ha)
    client.post("/api/share", headers=ha)

    async def shares(s):
        return list(await s.scalars(select(Outbox.text).where(Outbox.telegram_id == ids[0], Outbox.kind == "share")))
    assert len(db(shares)) == 1 and "start=f" in db(shares)[0]
    client.delete(f"/api/friends/{b_id}", headers=ha)
    assert len(client.get("/api/friends", headers=hb).json()["board"]) == 1


def test_fake_opponent_and_young_accounts_earn_nothing(client, seeded):
    import random
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update

    from backend.api import social
    from backend.database.db import SessionLocal
    from backend.database.models import Duel, Friendship, User
    from conftest import USER, make_init_data

    hs = [{"Authorization": f"tma {make_init_data({**USER, 'id': random.randint(3 * 10**9, 4 * 10**9)})}"} for _ in range(2)]
    a, b = (client.post("/api/auth", headers=h).json()["id"] for h in hs)
    for h in hs:
        client.put("/api/profile", headers=h, json=PROFILE)
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]

    async def run(fn):
        async with SessionLocal() as s:
            return await fn(s)

    async def friends(s):
        s.add_all([Friendship(user_id=a, friend_id=b), Friendship(user_id=b, friend_id=a)])
        await s.commit()
    client.portal.call(run, friends)

    def duel(age_days, fake_active):
        d = client.post("/api/duels", headers=hs[0], json={"friend_id": b, "metric": "xp", "days": 3}).json()
        client.post(f"/api/duels/{d['id']}/accept", headers=hs[1])
        for meal in ("breakfast", "lunch", "dinner"):
            client.post("/api/food-logs", headers=hs[0], json={"product_id": pid, "amount_g": 100, "meal_type": meal})
        if fake_active:
            client.post("/api/food-logs", headers=hs[1], json={"product_id": pid, "amount_g": 100, "meal_type": "snack"})

        async def end(s):
            old = datetime.now(timezone.utc) - timedelta(days=age_days)
            await s.execute(update(User).where(User.id.in_((a, b))).values(created_at=old))
            await s.execute(update(Duel).where(Duel.id == d["id"]).values(ends_at=datetime.now(timezone.utc)))
            await s.commit()
            await social.finish_duels(s)
            return (await s.get(Duel, d["id"])).rewarded
        return client.portal.call(run, end)

    assert duel(age_days=1, fake_active=True) is False   # fresh accounts
    assert duel(age_days=30, fake_active=False) is False  # the opponent did nothing
    assert client.post("/api/auth", headers=hs[0]).json()["progress"]["xp"] < 100  # no +40 anywhere above


def test_timezone_hopping_does_not_repeat_daily_xp(client, seeded):
    h = new_user_headers()
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    log = lambda hh, meal: client.post("/api/food-logs", headers=hh, json={"product_id": pid, "amount_g": 100, "meal_type": meal}).json()["xp_awarded"]  # noqa: E731
    assert [log({**h, "X-Timezone": "Pacific/Pago_Pago"}, m) for m in ("breakfast", "lunch", "dinner", "snack")] == [10] * 4
    # jump a day ahead by timezone: same meals again would be a "new day", but the rolling cap says no
    assert log({**h, "X-Timezone": "Pacific/Kiritimati"}, "breakfast") == 0


def test_owner_stats_counts_visits_and_retention(client, seeded):
    from datetime import date, datetime, timedelta, timezone

    from sqlalchemy.dialects.postgresql import insert

    from backend.bot import admin
    from backend.database.db import SessionLocal
    from backend.database.models import Visit

    h = new_user_headers()
    uid = client.post("/api/auth", headers=h).json()["id"]
    client.get("/api/settings", headers=h)  # second request the same day: still one visit

    async def run():
        async with SessionLocal() as s:
            today = date.today()
            # a user who joined 9 days ago and came back on day 8: counts for both D1 and D7 retention
            for d in (today - timedelta(days=9), today - timedelta(days=1)):
                await s.execute(insert(Visit).values(user_id=uid, day=d).on_conflict_do_nothing())
            await s.commit()
            back1, total1 = await admin.retention(s, 1, 14, today)
            text = await admin.summary(s, datetime.now(timezone.utc))
            return back1, total1, text
    back1, total1, text = client.portal.call(run)
    assert total1 >= 1 and back1 >= 1
    assert "Пользователей" in text and "Вернулись через неделю" in text and "<b>" in text


def test_weekly_quests_assigned_once_and_paid_once(client, seeded):
    from datetime import date, timedelta

    from sqlalchemy import delete
    from sqlalchemy.dialects.postgresql import insert

    from backend.database.db import SessionLocal
    from backend.database.models import WeeklyQuest

    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)
    first = client.get("/api/quests", headers=h).json()
    assert len(first["items"]) == 3 and 1 <= first["days_left"] <= 7
    assert client.get("/api/quests", headers=h).json()["items"] == first["items"]  # stable within the week
    assert all(1 <= q["target"] <= first["days_left"] or q["code"] == "workouts" for q in first["items"])

    # pin three easy tasks for this week to check progress and payment
    uid = client.post("/api/auth", headers=h).json()["id"]
    week = date.fromisoformat(first["week"])

    async def pin():
        async with SessionLocal() as s:
            await s.execute(delete(WeeklyQuest).where(WeeklyQuest.user_id == uid))
            for slot, code in enumerate(("diary_days", "weigh", "water_days")):
                await s.execute(insert(WeeklyQuest).values(user_id=uid, week=week, code=code, target=1, slot=slot))
            await s.commit()
    client.portal.call(pin)

    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, "meal_type": "lunch"})
    r = client.get("/api/quests", headers=h).json()
    assert [q["done"] for q in r["items"]] == [True, False, False] and r["xp_awarded"] == 50
    assert client.get("/api/quests", headers=h).json()["xp_awarded"] == 0  # paid once

    client.put("/api/measurements", headers=h, json={"weight_kg": 80})
    for _ in range(5):
        client.post("/api/water", headers=h, json={"delta_ml": 1000})
    r = client.get("/api/quests", headers=h).json()
    assert all(q["done"] for q in r["items"]) and r["xp_awarded"] == 30 + 50 + 50  # two tasks + the all-three bonus
    assert r["items"][1]["title"] == "Взвесься 1 раз"


def test_bootstrap_has_the_whole_first_screen(client, seeded):
    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)
    b = client.post("/api/bootstrap", headers=h).json()
    assert set(b) == {"auth", "food_day", "water", "week", "workout_logs", "measurements", "achievements", "ai", "programs", "quests", "yesterday", "habits"}
    assert b["yesterday"]["meals"] == {}
    assert b["auth"]["profile"] and len(b["quests"]["items"]) == 3 and b["programs"]
    assert client.post("/api/bootstrap", headers=h).headers.get("content-encoding") == "gzip"  # big JSON is compressed


def test_change_grams_of_a_diary_entry(client, seeded):
    h, other = new_user_headers(), new_user_headers()
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    log = client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, "meal_type": "lunch"}).json()
    assert client.patch(f"/api/food-logs/{log['id']}", headers=other, json={"amount_g": 50}).status_code == 404
    assert client.patch(f"/api/food-logs/{log['id']}", headers=h, json={"amount_g": 0}).status_code == 422
    r = client.patch(f"/api/food-logs/{log['id']}", headers=h, json={"amount_g": 250}).json()
    assert r["amount_g"] == 250 and r["kcal"] == round(log["kcal"] * 2.5)


def test_open_food_facts_bulk_sync(client, seeded, tmp_path, monkeypatch):
    import random

    import httpx
    from sqlalchemy import select

    from backend.core import off_sync
    from backend.database.db import SessionLocal
    from backend.database.models import Product

    code = str(random.randint(10**12, 10**13 - 1))
    page1 = [
        {"code": code, "product_name_ru": f"Кефир тестовый {code}", "brands": "Ирбит", "nutriments": {"energy-kcal_100g": 53, "proteins_100g": 3, "fat_100g": 2.5, "carbohydrates_100g": 4}},
        {"code": "123", "product_name": "short code", "nutriments": {"energy-kcal_100g": 1}},  # not a barcode
        {"code": str(int(code) + 1), "product_name": "Без КБЖУ", "nutriments": {}},              # unusable
    ]
    pages = {1: page1, 2: []}

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.params["countries_tags_en"] == "russia"
        return httpx.Response(200, json={"products": pages[int(req.url.params["page"])]})

    real = httpx.AsyncClient
    monkeypatch.setattr(off_sync.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(off_sync, "STATE", tmp_path / ".off_sync")
    monkeypatch.setattr(off_sync, "PAUSE", 0)

    async def go():
        await off_sync.run()
        await off_sync.run()  # done recently: nothing to do
        async with SessionLocal() as s:
            return list(await s.scalars(select(Product).where(Product.barcode.in_([code, str(int(code) + 1)]))))
    found = client.portal.call(go)
    assert [(p.name, p.brand, p.kcal, p.owner_user_id) for p in found] == [(f"Кефир тестовый {code}", "Ирбит", 53, None)]
    assert off_sync.load_state()["done_at"]
    assert client.get("/api/products/search", params={"q": f"кефир тестовый {code}"}).json()[0]["name"] == f"Кефир тестовый {code}"

    # a new version of the sync goes over again and adds the package to products it already has
    page1[0]["quantity"] = "900 мл"
    monkeypatch.setattr(off_sync, "VERSION", off_sync.VERSION + 1)
    found = client.portal.call(go)
    assert (found[0].piece_g, found[0].piece_name, found[0].ml_g, found[0].kcal) == (900, "упаковка", 1.0, 53)


def test_errors_reach_the_owner_once(client, seeded, monkeypatch):
    import random

    from sqlalchemy import delete, select

    from backend.api.main import app
    from backend.core import alerts
    from backend.core.config import settings
    from backend.database.db import SessionLocal
    from backend.database.models import Outbox

    admin = random.randint(5 * 10**9, 6 * 10**9)
    monkeypatch.setattr(settings, "admin_ids", str(admin))
    monkeypatch.setattr(alerts, "_last", {})

    async def boom():
        raise ValueError("сломалось " + str(admin))
    from fastapi.routing import APIRoute
    app.router.routes.insert(0, APIRoute("/api/test-boom", boom))  # before the Mini App's catch-all mount
    monkeypatch.setattr(client._transport, "raise_server_exceptions", False)  # see the 500 the user would see
    try:
        r1, r2 = client.get("/api/test-boom"), client.get("/api/test-boom")
    finally:
        app.router.routes = [r for r in app.router.routes if getattr(r, "path", "") != "/api/test-boom"]
    assert r1.status_code == 500 and "Ошибка на сервере" in r1.json()["detail"]

    h = new_user_headers()
    assert client.post("/api/client-error", json={"message": "x"}).status_code == 401  # only real users
    client.post("/api/client-error", headers=h, json={"message": "TypeError: undefined is not a function", "where": "питание"})

    async def sent():
        async with SessionLocal() as s:
            rows = list(await s.scalars(select(Outbox).where(Outbox.telegram_id == admin)))
            await s.execute(delete(Outbox).where(Outbox.telegram_id == admin))
            await s.commit()
            return rows
    rows = client.portal.call(sent)
    assert [r.kind for r in rows] == ["alert", "alert"]  # the API error once (not twice) + the app crash
    assert "ValueError: сломалось" in rows[0].text and "test-boom" in rows[0].text
    assert "приложение питание" in rows[1].text


def test_daily_backup_with_pg_dump(client, seeded, tmp_path, monkeypatch):
    import subprocess

    from backend.core import backup
    from backend.core.config import settings

    if not backup.pg_dump():
        import pytest
        pytest.skip("pg_dump is not installed here")
    args, env = backup.command("pg_dump", settings.database_url, tmp_path / "x.dump")
    assert env["PGPASSWORD"] and not any("@" in a or "://" in a for a in args)  # the password goes via env, not the command line
    monkeypatch.setattr(backup, "KEEP", 2)
    for i in range(3):  # three runs -> only the newest two are kept
        (tmp_path / f"setly-2000-01-0{i + 1}-0000.dump").write_bytes(b"old")
    out = client.portal.call(backup.make, tmp_path)
    assert out.stat().st_size > 1000 and backup.newest(tmp_path) == out
    assert len(list(tmp_path.glob("setly-*.dump"))) == 2
    listing = subprocess.run(["pg_restore", "--list", str(out)], capture_output=True, text=True)
    assert listing.returncode == 0 and "products" in listing.stdout  # a real, restorable dump


def test_broadcast_reaches_everyone_after_confirmation(client, seeded, monkeypatch):
    import random
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from sqlalchemy import delete, func, select

    from backend.bot import main as bot
    from backend.core.config import settings
    from backend.database.db import SessionLocal
    from backend.database.models import Outbox, User

    owner = random.randint(6 * 10**9, 7 * 10**9)
    monkeypatch.setattr(settings, "admin_ids", str(owner))
    text = f"Новое в Setly {owner}"

    def msg(uid):
        return SimpleNamespace(from_user=SimpleNamespace(id=uid), answer=AsyncMock())

    stranger = msg(owner + 1)
    client.portal.call(bot.broadcast, stranger, SimpleNamespace(args=text))
    assert "только для владельца" in stranger.answer.call_args.args[0]

    m = msg(owner)
    client.portal.call(bot.broadcast, m, SimpleNamespace(args=text))
    assert m.answer.call_args_list[0].args[0] == text and "Отправить" in m.answer.call_args_list[1].args[0]

    async def counts():
        async with SessionLocal() as s:
            users = await s.scalar(select(func.count(User.id)))
            queued = await s.scalar(select(func.count(Outbox.id)).where(Outbox.text == text))
            await s.execute(delete(Outbox).where(Outbox.text == text))
            await s.commit()
            return users, queued
    assert client.portal.call(counts)[1] == 0  # nothing before the button

    call = SimpleNamespace(from_user=SimpleNamespace(id=owner), data="bc:send", message=SimpleNamespace(edit_text=AsyncMock()), answer=AsyncMock())
    client.portal.call(bot.broadcast_answer, call)
    users, queued = client.portal.call(counts)
    assert queued == users > 0 and "очередь" in call.message.edit_text.call_args.args[0]


def test_habits_tick_and_keep_the_streak(client):
    h = new_user_headers()
    assert client.get("/api/habits", headers=h).json() == []
    assert client.get("/api/week", headers=h).json()["streak"] == 0
    hs = client.post("/api/habits", headers=h, json={"emoji": "😴", "title": "  Сон 8 часов "}).json()
    assert [(x["title"], x["done"], x["streak"]) for x in hs] == [("Сон 8 часов", False, 0)]
    assert client.post("/api/habits", headers=h, json={"title": "сон 8 часов"}).status_code == 409  # duplicate
    assert client.post("/api/habits", headers=h, json={"title": "   "}).status_code == 422
    hid = hs[0]["id"]

    for _ in range(2):  # a state, not a toggle: a double tap stays ticked
        hs = client.post(f"/api/habits/{hid}/check", headers=h, json={"done": True}).json()
    assert hs[0]["done"] and hs[0]["streak"] == 1
    assert client.get("/api/week", headers=h).json()["streak"] == 1  # a tick is enough for the day
    assert client.post(f"/api/habits/{hid}/check", headers=h, json={"done": False}).json()[0]["done"] is False
    assert client.get("/api/week", headers=h).json()["streak"] == 0

    other = new_user_headers()  # someone else's habit can't be ticked or removed
    assert client.post(f"/api/habits/{hid}/check", headers=other, json={"done": True}).status_code == 404
    assert client.delete(f"/api/habits/{hid}", headers=other).status_code == 404

    for i in range(7):
        client.post("/api/habits", headers=h, json={"title": f"Привычка {i}"})
    assert len(client.get("/api/habits", headers=h).json()) == 8
    assert client.post("/api/habits", headers=h, json={"title": "Девятая"}).status_code == 409
    assert len(client.delete(f"/api/habits/{hid}", headers=h).json()) == 7
    assert len(client.post("/api/bootstrap", headers=h).json()["habits"]) == 7
    # «Вернуть» right after removing; not someone else's, not over the limit
    assert client.post(f"/api/habits/{hid}/restore", headers=new_user_headers()).status_code == 404
    assert len(client.post(f"/api/habits/{hid}/restore", headers=h).json()) == 8
    client.delete(f"/api/habits/{hid}", headers=h)
    client.post("/api/habits", headers=h, json={"title": "Новая"})
    assert client.post(f"/api/habits/{hid}/restore", headers=h).status_code == 409


def test_consent_and_health_data(client):
    h = new_user_headers()
    s = client.get("/api/settings", headers=h).json()
    assert s["consent"] is False and s["health_consent"] is False
    sick = {**PROFILE, "experience": "beginner", "allergies": ["nuts"], "injury": "knees"}
    saved = client.put("/api/profile", headers=h, json=sick).json()
    assert not saved.get("allergies") and saved.get("injury") is None  # no health consent -> not stored
    assert client.post("/api/consent", headers=h, json={"health": True}).json() == {"consent": True, "health_consent": True}
    saved = client.put("/api/profile", headers=h, json=sick).json()
    assert saved["allergies"] == ["nuts"] and saved["injury"] == "knees"
    client.post("/api/consent", headers=h, json={"health": False})  # taken back: the answers are erased
    s = client.get("/api/settings", headers=h).json()
    assert s["consent"] is True and s["health_consent"] is False
    p = client.post("/api/bootstrap", headers=h).json()["auth"]["profile"]
    assert not p.get("allergies") and p.get("injury") is None


def test_delete_account_removes_everything(client):
    import random

    from sqlalchemy import func, select

    from backend.api import social
    from backend.database.db import SessionLocal
    from backend.database.models import FoodLog, Product, User

    ids = [random.randint(3 * 10**9, 4 * 10**9) for _ in range(2)]
    h, friend = ({"Authorization": f"tma {make_init_data({**USER, 'id': i})}"} for i in ids)
    client.put("/api/profile", headers=h, json=PROFILE)
    mine = client.post("/api/products", headers=h, json={"name": "Мой суп удаления", "kcal": 50, "protein_g": 2, "fat_g": 1, "carbs_g": 6}).json()["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": mine, "amount_g": 300, "meal_type": "lunch"})
    client.post("/api/water", headers=h, json={"delta_ml": 250})
    hid = client.post("/api/habits", headers=h, json={"title": "Витамины"}).json()[0]["id"]
    client.post(f"/api/habits/{hid}/check", headers=h, json={"done": True})

    async def befriend():
        async with SessionLocal() as s:
            me = await s.scalar(select(User).where(User.telegram_id == ids[0]))
            return await social.befriend(s, await social.invite_code(s, me), ids[1], "Друг")
    assert client.portal.call(befriend) is not None
    assert len(client.get("/api/friends", headers=friend).json()["board"]) == 2

    assert client.delete("/api/account", headers=h).status_code == 204

    async def left():
        async with SessionLocal() as s:
            return (await s.scalar(select(User.id).where(User.telegram_id == ids[0])),
                    await s.scalar(select(func.count()).select_from(Product).where(Product.id == mine)),
                    await s.scalar(select(func.count()).select_from(FoodLog).where(FoodLog.product_id == mine)))
    assert client.portal.call(left) == (None, 0, 0)
    assert len(client.get("/api/friends", headers=friend).json()["board"]) == 1  # gone from the friend's board too


def test_habit_reminders_with_tick_buttons(client, monkeypatch):
    import random
    from datetime import datetime

    from backend.api.habits import tick_from_bot
    from backend.bot.reminders import collect
    from backend.database.db import SessionLocal

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    a = client.post("/api/habits", headers=h, json={"emoji": "💊", "title": "Витамины"}).json()[0]["id"]
    hs = client.post("/api/habits", headers=h, json={"emoji": "😴", "title": "Сон"}).json()
    b = hs[1]["id"]
    assert client.patch(f"/api/habits/{a}", headers=h, json={"remind_at": "25:00"}).status_code == 422
    assert client.patch(f"/api/habits/{a}", headers=h, json={"remind_at": "09:00"}).json()[0]["remind_at"] == "09:00"
    client.patch(f"/api/habits/{b}", headers=h, json={"remind_at": "09:00"})
    assert client.patch(f"/api/habits/{a}", headers=new_user_headers(), json={"remind_at": None}).status_code == 404

    now = datetime.now().astimezone()

    async def run(hh, mm):
        async with SessionLocal() as s:
            return [(t, btn) for chat, t, _, btn in await collect(s, now.replace(hour=hh, minute=mm)) if chat == tg_id and "привычки" in t]

    assert client.portal.call(run, 8, 59) == []
    [(text, buttons)] = client.portal.call(run, 9, 5)
    assert "💊 Витамины, 😴 Сон" in text and buttons == [("✓ 💊 Витамины", f"cb:hb:{a}"), ("✓ 😴 Сон", f"cb:hb:{b}")]
    assert client.portal.call(run, 9, 6) == []  # once a day

    async def tick(hid, who=tg_id):
        async with SessionLocal() as s:
            return await tick_from_bot(s, who, hid)
    assert client.portal.call(tick, a).title == "Витамины"
    assert client.portal.call(tick, a, 1) is None  # someone else's button
    assert [x["done"] for x in client.get("/api/habits", headers=h).json()] == [True, False]


def test_search_by_word_stems_and_units(client, seeded):
    from backend.core.search import stems

    assert stems("огурец свежий") == ["огур", "свеж"] and stems("рис") == ["рис"]
    names = lambda q: [p["name"] for p in client.get("/api/products/search", params={"q": q}).json()]  # noqa: E731
    assert names("огурец")[0] == "Огурец" and "Огурцы свежие" in names("огурец")
    assert not any("огурт" in n for n in names("огурец"))  # a stem matches a word's start, not "йогурт"
    assert names("сало")[0] == "Сало" and "Салями" not in names("сало")[:3]
    assert "Яблоки" in names("яблоко") and "Яйцо куриное" in names("яйца")
    assert "Куриная грудка" in names("грудка куриная")  # any word order
    egg = next(p for p in client.get("/api/products/search", params={"q": "яйцо куриное"}).json() if p["name"] == "Яйцо куриное")
    assert (egg["piece_g"], egg["piece_name"], egg["ml_g"]) == (55, "шт", None)  # units.json filled the old product
    milk = client.get("/api/products/search", params={"q": "молоко 3.2"}).json()[0]
    assert milk["ml_g"] and milk["tbsp_g"]
    assert len(client.get("/api/products/search", params={"q": "борщ"}).json()) >= 1


def test_food_log_in_pieces(client, seeded):
    h = new_user_headers()
    egg = next(p for p in client.get("/api/products/search", params={"q": "яйцо куриное"}).json() if p["name"] == "Яйцо куриное")
    log = client.post("/api/food-logs", headers=h, json={"product_id": egg["id"], "amount_g": 110, "meal_type": "breakfast",
                                                         "unit": "шт", "qty": 2}).json()
    item = next(i for i in client.get("/api/food-logs", headers=h).json()["items"] if i["id"] == log["id"])
    assert (item["unit"], item["qty"], item["amount_g"]) == ("шт", 2, 110)
    patched = client.patch(f"/api/food-logs/{log['id']}", headers=h, json={"amount_g": 120}).json()
    assert (patched["unit"], patched["qty"], patched["amount_g"]) == (None, None, 120)  # typed in grams now


def test_search_the_way_people_type(client, seeded):
    from backend.core.search import translit, variants

    assert translit("activia") == "активиа" and translit("prostokvashino") == "простоквашино"
    assert "гречка" in variants("uhtxrf")  # typed with the English layout on
    names = lambda q, h=None: [p["name"] for p in client.get("/api/products/search", params={"q": q}, headers=h or {}).json()]  # noqa: E731
    assert names("картошка")[0].startswith("Картофель")  # not "Пирожное картошка"
    assert names("кртошка")[0].startswith("Картофель")  # a typo of an everyday word
    assert "Помидоры" in names("томат") and "Минеральная вода" in names("минералка")
    assert any(n.startswith("Хлеб ржаной") for n in names("хлеб черный"))
    assert names("uhtxrf")[0].startswith("Гречка") and names("гричка")[0].startswith("Гречка")  # the most eaten one may lead
    assert names("малако")[0].startswith("Молоко") and names("творг")[0].startswith("Творог")
    assert not any(n.startswith("Курага") for n in names("кура")[:5])
    assert "Куриная грудка" in names("филе куриное")


def test_search_ranks_own_history_and_logs_misses(client, seeded):
    import random

    from backend.bot.admin import summary
    from backend.database.db import SessionLocal

    h = new_user_headers()
    found = client.get("/api/products/search", params={"q": "курица"}, headers=h).json()
    usual = found[-1]  # something not first by default
    client.post("/api/food-logs", headers=h, json={"product_id": usual["id"], "amount_g": 150, "meal_type": "lunch"})
    assert client.get("/api/products/search", params={"q": "курица"}, headers=h).json()[0]["id"] == usual["id"]  # what I eat comes first
    assert client.get("/api/products/search", params={"q": "курица"}, headers=new_user_headers()).json()[0]["id"] != usual["id"] or len(found) == 1

    async def clean():  # earlier runs' misses would crowd the top 10 of the shared test database
        from sqlalchemy import delete

        from backend.database.models import SearchMiss
        async with SessionLocal() as s:
            await s.execute(delete(SearchMiss).where(SearchMiss.q.like("ъъъ%")))
            await s.commit()
    client.portal.call(clean)
    miss = f"ъъъ продукт {random.randint(10**5, 10**6)}"
    for _ in range(2):
        assert client.get("/api/products/search", params={"q": miss}, headers=h).json() == []
    client.get("/api/products/search", params={"q": miss})  # anonymous: not counted
    client.get("/api/products/search", params={"q": miss, "quiet": 1}, headers=h)  # the app's first try of "яйцо 2": not counted

    milk = client.get("/api/products/search", params={"q": "молоко 2.5%"}, headers=h).json()
    plain = [i for i, p in enumerate(milk) if p["name"] == "Молоко 2.5%" and p["brand"] is None]
    branded = [i for i, p in enumerate(milk) if p["name"] == "Молоко 2.5%" and p["brand"]]
    assert plain and branded and plain[0] < branded[0]  # the plain product before its brands

    async def stats():
        async with SessionLocal() as s:
            return await summary(s)
    assert f"• {miss} — 2" in client.portal.call(stats)


def test_meal_sets_and_recipes(client, seeded):
    from datetime import date

    h, other = new_user_headers(), new_user_headers()
    find = lambda q: next(p for p in client.get("/api/products/search", params={"q": q}).json())  # noqa: E731
    oats, banana = find("овсяные хлопья"), find("банан")
    client.post("/api/food-logs", headers=h, json={"product_id": oats["id"], "amount_g": 60, "meal_type": "breakfast"})
    client.post("/api/food-logs", headers=h, json={"product_id": banana["id"], "amount_g": 120, "meal_type": "breakfast", "unit": "шт", "qty": 1})
    today = date.today().isoformat()
    s = client.post("/api/meal-sets", headers=h, json={"name": " Мой завтрак ", "from_day": today, "meal_type": "breakfast"}).json()
    assert s["name"] == "Мой завтрак" and len(s["items"]) == 2 and s["items"][1]["unit"] == "шт"
    assert s["kcal"] == round(oats["kcal"] * 0.6 + banana["kcal"] * 1.2, 1)
    assert s["protein_g"] == round(oats["protein_g"] * 0.6 + banana["protein_g"] * 1.2, 1) > 0
    assert client.post("/api/meal-sets", headers=h, json={"name": "x", "from_day": today, "meal_type": "dinner"}).status_code == 404
    assert client.post(f"/api/meal-sets/{s['id']}/log", headers=other, json={"meal_type": "lunch"}).status_code == 404
    assert client.post(f"/api/meal-sets/{s['id']}/log", headers=h, json={"meal_type": "lunch"}).json()["logged"] == 2
    lunch = [i for i in client.get("/api/food-logs", headers=h).json()["items"] if i["meal_type"] == "lunch"]
    assert sorted(i["amount_g"] for i in lunch) == [60, 120]
    assert [x["id"] for x in client.get("/api/meal-sets", headers=h).json()] == [s["id"]]
    client.delete(f"/api/meal-sets/{s['id']}", headers=h)
    assert client.get("/api/meal-sets", headers=h).json() == []

    # a recipe: 500 g of ingredients boiled down to 400 g, 4 portions
    beet, beef = find("свекла"), find("говядина")
    body = {"name": "Борщ мамин", "ingredients": [{"product_id": beet["id"], "grams": 300}, {"product_id": beef["id"], "grams": 200}],
            "cooked_g": 400, "servings": 4}
    r = client.post("/api/recipes", headers=h, json=body).json()
    expect = (beet["kcal"] * 3 + beef["kcal"] * 2) * 100 / 400
    assert abs(r["kcal"] - expect) <= 1 and r["portion_g"] == 100 and r["category"] == "Мой рецепт"
    assert abs(r["protein_g"] - (beet["protein_g"] * 3 + beef["protein_g"] * 2) * 100 / 400) <= 0.1 and r["protein_g"] > 0
    assert client.get("/api/products/search", headers=h, params={"q": "борщ мамин"}).json()[0]["id"] == r["id"]
    assert client.get("/api/products/search", headers=other, params={"q": "борщ мамин"}).json() == []  # private
    assert client.post("/api/recipes", headers=h, json={**body, "cooked_g": 50}).status_code == 422  # can't shrink 10x
    body["name"], body["cooked_g"] = "Борщ мамин наваристый", None
    u = client.put(f"/api/recipes/{r['id']}", headers=h, json=body).json()
    assert abs(u["kcal"] - expect * 400 / 500) <= 1 and u["total_g"] == 500
    assert client.get("/api/products/search", headers=h, params={"q": "наваристый"}).json()[0]["id"] == r["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": r["id"], "amount_g": 300, "meal_type": "dinner"})
    assert client.delete(f"/api/recipes/{r['id']}", headers=other).status_code == 404
    client.delete(f"/api/recipes/{r['id']}", headers=h)
    assert client.get("/api/recipes", headers=h).json() == []
    assert any(i["product"]["id"] == r["id"] for i in client.get("/api/food-logs", headers=h).json()["items"])  # the plate stays


def test_real_expenditure_forecast_and_plateau(client, seeded):
    from datetime import date, datetime, time, timedelta

    from backend.api.energy import estimate, slope
    from backend.database.db import SessionLocal
    from backend.database.models import FoodLog, User

    assert abs(slope([(0, 80), (7, 79.5), (14, 79)]) - (-1 / 14)) < 1e-9
    assert estimate([2000] * 9, [(0, 80), (7, 79), (14, 78)]) is None  # not enough logged days yet
    # ate 2000 a day and lost 0.5 kg a week -> spent 2000 + 0.5/7 × 7700 = 2550
    assert estimate([2000] * 14, [(0, 80), (7, 79.5), (14, 79)]) == {"tdee": 2550, "intake": 2000, "kg_per_week": -0.5}
    assert estimate([300] * 14, [(0, 80), (7, 79.5), (14, 79)]) is None  # implausible: the diary has gaps

    import random

    tg_id = random.randint(5 * 10**9, 6 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json={**PROFILE, "goal": "weight_loss"})
    e = client.get("/api/insights/energy", headers=h).json()
    assert e["ready"] is False and e["days_logged"] == 0 and e["formula"] > 1000
    assert client.post("/api/profile/target-weight", headers=h, json={"target_weight_kg": 75}).json()["target_weight_kg"] == 75

    # 21 days: 2000 kcal a day; weight 80 -> 78.5 over three weeks, then flat for the last two
    product = next(p for p in client.get("/api/products/search", params={"q": "гречка"}).json() if p["kcal"] > 50)
    grams = 2000 * 100 / product["kcal"]
    today = date.today()

    async def seed():
        async with SessionLocal() as s:
            from sqlalchemy import select

            user = await s.scalar(select(User).where(User.telegram_id == tg_id))
            for i in range(1, 22):
                s.add(FoodLog(user_id=user.id, product_id=product["id"], amount_g=grams, meal_type="lunch",
                              logged_at=datetime.combine(today - timedelta(days=i), time(13)).astimezone()))
            await s.commit()
    client.portal.call(seed)
    for back, kg in ((21, 80.0), (14, 79.2), (12, 78.6), (7, 78.55), (1, 78.5)):
        client.put("/api/measurements", headers=h, json={"measured_on": (today - timedelta(days=back)).isoformat(), "weight_kg": kg})
    e = client.get("/api/insights/energy", headers=h).json()
    assert e["ready"] and e["days_logged"] == 21 and 2000 < e["tdee"] < 3200 and e["kg_per_week"] < 0
    from backend.api.energy import recalc, suggestion

    assert e["suggest"] == suggestion(e["tdee"], "weight_loss", "male", 78.5) and e["eta"] and e["plateau"] is True
    # the diary is full and the intake is at the norm: with the weekly recalculation on, that's its job
    assert e["kcal_auto"] is True and e["plateau_kcal"] is None and "пересчитается" in e["plateau_tips"][0]
    assert "шагов" in e["plateau_tips"][-1]
    # without it: the norm itself goes down 150 kcal
    client.post("/api/insights/energy/auto", headers=h, json={"on": False})
    e = client.get("/api/insights/energy", headers=h).json()
    norm = client.get("/api/profile", headers=h).json()["targets_base"]["calories"]
    assert e["plateau_kcal"] == norm - 150 and str(norm - 150) in e["plateau_tips"][0]

    # the weekly recalculation: towards the measured norm, at most 200 kcal a step, then not again for a week
    async def run_recalc():
        async with SessionLocal() as s:
            from sqlalchemy import select

            from backend.database.models import Profile
            user = await s.scalar(select(User).where(User.telegram_id == tg_id))
            return await recalc(s, user, await s.get(Profile, user.id))
    assert client.portal.call(run_recalc) is None  # switched off
    client.post("/api/insights/energy/auto", headers=h, json={"on": True})
    r = client.portal.call(run_recalc)
    assert r["old"] == norm and abs(r["new"] - norm) <= 200 and (r["new"] - norm) * (e["suggest"] - norm) > 0
    assert client.get("/api/profile", headers=h).json()["kcal_override"] == r["new"]
    assert client.portal.call(run_recalc) is None  # a week hasn't passed
    assert client.get("/api/insights/energy", headers=h).json()["kcal_auto_at"] == today.isoformat()
    from backend.api.energy import recalc_text
    assert recalc_text(r).startswith(f"📊 Пересчитал норму по твоим данным: {norm:,} → ".replace(",", " "))

    assert client.post("/api/insights/energy/apply", headers=h, json={"kcal": 900}).status_code == 422  # below the safe floor
    client.post("/api/insights/energy/apply", headers=h, json={"kcal": e["suggest"]})
    assert client.get("/api/profile", headers=h).json()["targets"]["calories"] == e["suggest"]
    # back to the formula on purpose: the recalculation turns off too, so it doesn't undo that next week
    assert client.post("/api/insights/energy/apply", headers=h, json={"kcal": None}).json() == {"kcal_override": None, "kcal_auto": False}
    client.post("/api/insights/energy/apply", headers=h, json={"kcal": e["suggest"]})
    client.put("/api/profile", headers=h, json={**PROFILE, "goal": "maintenance"})  # a new goal drops the accepted norm
    assert client.get("/api/profile", headers=h).json()["kcal_override"] is None


def test_what_to_eat_from_own_meals(client, seeded):
    import random
    from datetime import date, datetime, time, timedelta

    from sqlalchemy import select

    from backend.database.db import SessionLocal
    from backend.database.models import FoodLog, User

    tg_id = random.randint(6 * 10**9, 7 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    norm = client.get("/api/profile", headers=h).json()["targets"]
    find = lambda q: next(p for p in client.get("/api/products/search", params={"q": q}).json())  # noqa: E731
    chicken, rice, cake = find("куриная грудка"), find("рис"), find("торт наполеон")
    past = [((3, "dinner"), [(chicken, 200), (rice, 150)]), ((5, "dinner"), [(cake, 400)]), ((6, "lunch"), [(chicken, 200), (rice, 150)])]

    async def seed():
        async with SessionLocal() as s:
            user = await s.scalar(select(User).where(User.telegram_id == tg_id))
            for (back, meal), items in past:
                for p, g in items:
                    s.add(FoodLog(user_id=user.id, product_id=p["id"], amount_g=g, meal_type=meal,
                                  logged_at=datetime.combine(date.today() - timedelta(days=back), time(19)).astimezone()))
            await s.commit()
    client.portal.call(seed)
    # today: breakfast and lunch already eaten, about 700 kcal left
    eaten_g = (norm["calories"] - 700) * 100 / rice["kcal"]
    client.post("/api/food-logs", headers=h, json={"product_id": rice["id"], "amount_g": min(eaten_g, 5000), "meal_type": "lunch"})
    r = client.get("/api/suggest/meal", headers=h).json()
    assert 600 <= r["kcal_left"] <= 800 or eaten_g > 5000
    titles = [o["title"] for o in r["options"]]
    assert titles and titles[0].startswith(chicken["name"]) and len(set(titles)) == len(titles)  # same meal twice -> once
    assert not any(cake["name"] in t for t in titles)  # 400 g of cake doesn't fit what's left
    opt = r["options"][0]
    logged = client.post("/api/food-logs/batch", headers=h, json={"meal_type": "dinner", "items": opt["items"]}).json()
    assert logged["logged"] == 2 and len(logged["ids"]) == 2
    assert client.post("/api/food-logs/batch", headers=new_user_headers(), json={"meal_type": "dinner",
           "items": [{"product_id": 10**9, "amount_g": 100}]}).status_code == 404


def test_personal_records_and_rest_timer(client, seeded):
    import random
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from backend.api.social import pending_messages
    from backend.database.db import SessionLocal
    from backend.database.models import Outbox

    tg_id = random.randint(7 * 10**9, 8 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    ex = client.get("/api/exercises", headers=h).json()[0]["id"]

    def workout(*sets):
        log = client.post("/api/workout-logs", headers=h, json={"title": "Тест"}).json()["id"]
        return [client.post(f"/api/workout-logs/{log}/sets", headers=h, json={"exercise_id": ex, "set_number": i + 1, **s}).json()
                for i, s in enumerate(sets)]

    first = workout({"reps": 8, "weight_kg": 60})
    assert first[0]["record"] is None  # the very first set isn't a record
    r = workout({"reps": 8, "weight_kg": 60}, {"reps": 6, "weight_kg": 70}, {"reps": 20, "weight_kg": 50})
    assert r[0]["record"] is None  # same as before
    assert r[1]["record"]["kind"] == "weight" and r[1]["record"]["value"] > r[1]["record"]["previous"] and r[1]["xp_awarded"] == 15
    assert r[2]["record"] is None  # 20 reps: the 1RM formula isn't trusted
    pull = workout({"reps": 5, "weight_kg": 0}, {"reps": 7, "weight_kg": 0})
    assert pull[0]["record"] is None and pull[1]["record"] == {"kind": "reps", "value": 7, "previous": 5}
    assert pull[1]["xp_awarded"] == 0  # one record XP per exercise per day

    client.post("/api/rest-timer", headers=h, json={"seconds": 90, "next": "Жим лёжа"})
    client.post("/api/rest-timer", headers=h, json={"seconds": 10})  # a new timer replaces the old one

    async def queued(at_shift=0):
        async with SessionLocal() as s:
            rows = list(await s.scalars(select(Outbox).where(Outbox.telegram_id == tg_id, Outbox.kind == "rest")))
            due = [m for m in await pending_messages(s, 10000) if m.telegram_id == tg_id]
            return len(rows), len(due), rows[0].send_after - datetime.now(timezone.utc) if rows else None
    n, due, left = client.portal.call(queued)
    assert n == 1 and due == 0 and timedelta(seconds=10) < left <= timedelta(seconds=15)  # not sent before the time
    client.delete("/api/rest-timer", headers=h)
    assert client.portal.call(queued)[0] == 0


def test_weekly_leagues(client, seeded):
    import random
    from datetime import timedelta

    from sqlalchemy import select, update

    from backend.api import leagues
    from backend.database.db import SessionLocal
    from backend.database.models import League, LeagueMember, Outbox, User, XpEvent

    async def reset():  # other tests' users may sit in this week's groups of the shared test database
        async with SessionLocal() as s:
            await s.execute(update(League).values(closed=True))
            await s.execute(update(User).values(league_tier=3))  # nobody else in Bronze this time
            await s.commit()
    client.portal.call(reset)
    ids = [random.randint(8 * 10**9, 9 * 10**9) for _ in range(22)]
    heads = [{"Authorization": f"tma {make_init_data({**USER, 'id': i, 'first_name': f'Игрок{n} Фамилия'})}"} for n, i in enumerate(ids)]

    async def set_tier_and_xp():
        async with SessionLocal() as s:
            for n, i in enumerate(ids):
                u = await s.scalar(select(User).where(User.telegram_id == i))
                u.league_tier = 0
                s.add(XpEvent(user_id=u.id, event_type="test", event_key=f"lg{n}", xp=100 - n * 4))  # player 0 has the most
            await s.commit()
    for h in heads:
        client.get("/api/settings", headers=h)  # creates the users
    client.portal.call(set_tier_and_xp)
    boards = [client.get("/api/league", headers=h).json() for h in heads]
    assert boards[0]["tier_name"] == "Бронза" and boards[0]["promote"] == 5 and boards[0]["demote"] == 0  # nowhere below Bronze
    assert len(boards[0]["members"]) == 1 and len(boards[19]["members"]) == 20 and len(boards[20]["members"]) == 1  # 20 per group
    b = client.get("/api/league", headers=heads[0]).json()
    assert [m["name"] for m in b["members"][:2]] == ["Ты", "Игрок1"] and b["members"][0]["xp"] == 100  # strangers: first name only

    async def close_week():
        async with SessionLocal() as s:
            await s.execute(update(League).where(League.closed.is_(False)).values(week_start=League.week_start - timedelta(days=7)))
            await s.execute(update(XpEvent).where(XpEvent.event_type == "test", XpEvent.event_key.like("lg%"))
                            .values(created_at=XpEvent.created_at - timedelta(days=7)))
            await s.commit()
            n = await leagues.finish_leagues(s)
            tiers = [await s.scalar(select(User.league_tier).where(User.telegram_id == i)) for i in ids]
            msgs = list(await s.scalars(select(Outbox.text).where(Outbox.telegram_id == ids[0])))
            return n, tiers, msgs
    n, tiers, msgs = client.portal.call(close_week)
    assert n == 2 and tiers[:5] == [1] * 5 and tiers[5:20] == [0] * 15  # top 5 up; Bronze can't go down
    assert any("Серебро" in m for m in msgs)
    assert client.get("/api/league", headers=heads[0]).json()["tier_name"] == "Серебро"  # a new week, a new group
    assert LeagueMember


def test_group_challenges(client, seeded):
    import random
    from datetime import timedelta

    from sqlalchemy import select, update

    from backend.api import social
    from backend.api.challenges import finish_challenges
    from backend.database.db import SessionLocal
    from backend.database.models import Challenge, ChallengeCheck, Outbox, User

    ids = [random.randint(9 * 10**9, 10 * 10**9) for _ in range(3)]
    a, b, c = ({"Authorization": f"tma {make_init_data({**USER, 'id': i, 'first_name': n})}"} for i, n in zip(ids, ("Аня", "Боря", "Вера")))
    for h in (a, b, c):
        client.put("/api/profile", headers=h, json=PROFILE)

    async def befriend(x, y):
        async with SessionLocal() as s:
            me = await s.scalar(select(User).where(User.telegram_id == x))
            await social.befriend(s, await social.invite_code(s, me), y, "Друг")
    client.portal.call(befriend, ids[0], ids[1])
    board = client.get("/api/friends", headers=a).json()["board"]
    boris = next(r["id"] for r in board if not r["me"])
    vera = client.get("/api/friends", headers=c).json()["board"][0]["id"]  # Vera isn't Anya's friend

    assert client.post("/api/challenges", headers=a, json={"title": "Без сладкого", "days": 5, "friend_ids": [boris]}).status_code == 422
    assert client.post("/api/challenges", headers=a, json={"title": "Без сладкого", "days": 7, "friend_ids": [vera]}).status_code == 422
    ch = client.post("/api/challenges", headers=a, json={"title": "Без сладкого", "emoji": "🍬", "days": 7, "friend_ids": [boris, vera]}).json()
    assert [m["name"] for m in ch["members"]] == ["Ты", "Боря"] and ch["members"][1]["joined"] is False  # Vera wasn't added
    cid = ch["id"]
    assert client.post(f"/api/challenges/{cid}/check", headers=b, json={"done": True}).status_code == 409  # accept first
    got = client.get("/api/challenges", headers=b).json()[0]
    assert got["invited"] is True and got["title"] == "Без сладкого"
    client.post(f"/api/challenges/{cid}/join", headers=b)
    assert client.post(f"/api/challenges/{cid}/check", headers=a, json={"done": True}).json()["members"][0]["today"] is True
    assert client.post(f"/api/challenges/{cid}/join", headers=c).status_code == 404  # not invited

    async def finish():
        async with SessionLocal() as s:  # move it a week back and give Anya 6 of 7 days, Borya 1
            await s.execute(update(Challenge).where(Challenge.id == cid).values(start_day=Challenge.start_day - timedelta(days=9)))
            await s.execute(update(ChallengeCheck).where(ChallengeCheck.challenge_id == cid).values(day=ChallengeCheck.day - timedelta(days=9)))
            ua = await s.scalar(select(User.id).where(User.telegram_id == ids[0]))
            ub = await s.scalar(select(User.id).where(User.telegram_id == ids[1]))
            start = (await s.get(Challenge, cid)).start_day
            for d in range(1, 6):
                s.add(ChallengeCheck(challenge_id=cid, user_id=ua, day=start + timedelta(days=d)))
            s.add(ChallengeCheck(challenge_id=cid, user_id=ub, day=start + timedelta(days=3)))
            await s.commit()
            n = await finish_challenges(s)
            texts = {i: list(await s.scalars(select(Outbox.text).where(Outbox.telegram_id == i, Outbox.text.like("%завершён%")))) for i in ids[:2]}
            xa = await s.scalar(select(User.xp).where(User.id == ua))
            return n, texts, xa
    n, texts, xp = client.portal.call(finish)
    assert n >= 1 and "справился: 6 из 7" in texts[ids[0]][0] and "+50 XP" in texts[ids[0]][0]
    assert "1 из 7" in texts[ids[1]][0] and "Аня 6/7" in texts[ids[1]][0]
    assert client.get("/api/challenges", headers=a).json()[0]["finished"] is True


def test_pdf_report(client, seeded):
    from datetime import date, timedelta

    from backend.bot.report import render

    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)
    assert client.post("/api/report", headers=h, json={"days": 14}).status_code == 422
    assert client.post("/api/report", headers=h, json={"days": 30}).json() == {"ok": True}
    assert client.post("/api/report", headers=h, json={"days": 30}).status_code == 429  # one at a time
    from datetime import datetime, time

    from backend.api.report import gather
    from backend.database.db import SessionLocal
    from backend.database.models import BodyMeasurement, FoodLog, Product, User, WorkoutLog, WorkoutSet

    today = date.today()
    tg_id = __import__("random").randint(7 * 10**9, 8 * 10**9)
    hh = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id, 'first_name': 'Егор 🦊'})}"}
    client.put("/api/profile", headers=hh, json=PROFILE)  # 182 cm, 78.4 kg, weight loss

    async def build(seed: bool):
        async with SessionLocal() as s:
            from sqlalchemy import select

            user = await s.scalar(select(User).where(User.telegram_id == tg_id))
            if seed:
                p = Product(name=f"Творог {tg_id}", kcal=120, protein_g=17, fat_g=5, carbs_g=3)
                s.add(p)
                await s.flush()
                for i in range(20):
                    for hour in (8, 19):
                        s.add(FoodLog(user_id=user.id, product_id=p.id, amount_g=500, meal_type="breakfast" if hour == 8 else "dinner",
                                      logged_at=datetime.combine(today - timedelta(days=i), time(hour)).astimezone()))
                for back, kg, waist in ((28, 80.0, 90), (14, 79.2, None), (1, 78.4, 88)):
                    s.add(BodyMeasurement(user_id=user.id, measured_on=today - timedelta(days=back), weight_kg=kg, waist_cm=waist))
                for i in range(12):
                    st = datetime.combine(today - timedelta(days=2 * i), time(18)).astimezone()
                    w = WorkoutLog(user_id=user.id, title="День 1 · Всё тело", started_at=st, completed_at=st + timedelta(minutes=50), effort="ok")
                    s.add(w)
                    await s.flush()
                    s.add(WorkoutSet(workout_log_id=w.id, exercise_id=1, set_number=1, reps=10, weight_kg=40))
                await s.commit()
            return await gather(s, user, 30)
    empty = client.portal.call(build, False)
    assert render(empty)[:5] == b"%PDF-"  # a new user still gets a (sparse) report
    data = client.portal.call(build, True)
    assert data["person"]["age"] == today.year - PROFILE["birth_year"] and data["norms"]["bmr"] > 1500
    nut, body = data["nutrition"], data["body"]
    assert nut["days"] == 20 and round(nut["kcal"]) == 1200 and nut["protein_per_kg"] == round(170 / 78.4, 1)
    assert nut["timing"] == {"first": "08:00", "last": "19:00", "window_h": 11.0} and nut["top"][0]["share"] == 100
    assert len(nut["diary"]) == 14 and nut["diary"][-1][1][0]["kcal"] == 600  # the itemised diary: the last two weeks
    assert body["first"]["weight_kg"] == 80.0 and body["last"]["bmi"] == round(78.4 / 1.82 ** 2, 1)
    assert body["last"]["whtr"] == round(88 / 182, 2)
    assert data["workouts"]["minutes"] == 600 and data["workouts"]["sessions"][0]["volume"] == 400
    pdf = render(data)
    assert pdf[:5] == b"%PDF-" and pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page ") >= 3  # main part + appendices
    from backend.bot.report import printable
    assert printable("🦊 Егор ✨") == "Егор" and printable("💪") == ""  # emoji-only name -> generic title


def test_diary_past_days(client, seeded):
    """A forgotten meal goes into an earlier day: yesterday still earns XP, older days don't, nothing past 30 days."""
    from datetime import date, timedelta

    h = new_user_headers()
    pid = client.get("/api/products/search?q=Гречка", headers=h).json()[0]["id"]
    day = lambda n: (date.today() - timedelta(days=n)).isoformat()  # noqa: E731
    add = lambda n, meal="dinner": client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, "meal_type": meal, "day": day(n)})  # noqa: E731
    r = add(1)
    assert r.status_code == 200 and r.json()["xp_awarded"] > 0
    assert add(1).json()["xp_awarded"] == 0  # once per meal per day
    assert add(5).json()["xp_awarded"] == 0  # old back-fill: logged, no XP
    assert add(40).status_code == 422 and add(-1).status_code == 422
    y = client.get(f"/api/food-logs?day={day(1)}", headers=h).json()
    assert len(y["items"]) == 2 and client.get("/api/food-logs", headers=h).json()["items"] == []
    snack = add(3, "snack").json()
    assert snack["snack_slot"] == "16:00"

    # move to another meal of the same day; the amount stays
    moved = client.patch(f"/api/food-logs/{y['items'][0]['id']}", headers=h, json={"meal_type": "lunch"}).json()
    assert moved["meal_type"] == "lunch" and moved["amount_g"] == 100
    assert client.get(f"/api/food-logs?day={day(1)}", headers=h).json()["items"][0]["meal_type"] == "lunch"
    # copy yesterday's dinner into a day before it, and a set / batch into a past day
    r = client.post("/api/food-logs/copy", headers=h, json={"from_day": day(1), "meal_type": "dinner", "to_day": day(2)}).json()
    assert r["copied"] == 1
    assert client.post("/api/food-logs/batch", headers=h, json={"meal_type": "breakfast", "day": day(2), "items": [{"product_id": pid, "amount_g": 50}]}).status_code == 200
    assert {i["meal_type"] for i in client.get(f"/api/food-logs?day={day(2)}", headers=h).json()["items"]} == {"dinner", "breakfast"}


def test_food_calendar(client, seeded):
    from datetime import date

    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)
    pid = client.get("/api/products/search?q=Гречка", headers=h).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 200, "meal_type": "lunch"})
    today = date.today()
    r = client.get(f"/api/food-calendar?month={today:%Y-%m}", headers=h).json()
    assert list(r["days"]) == [today.isoformat()] and r["days"][today.isoformat()] > 0 and r["goal"] > 0
    assert client.get("/api/food-calendar?month=2026-13", headers=h).status_code == 422
    assert client.get("/api/food-calendar?month=2099-01", headers=h).json() == {"days": {}, "goal": None}


def test_usual_meal(client, seeded):
    from datetime import date, timedelta

    h = new_user_headers()
    search = lambda q: client.get(f"/api/products/search?q={q}", headers=h).json()[0]["id"]  # noqa: E731
    oats, egg = search("Овсянка"), search("Яйцо")
    day = lambda n: (date.today() - timedelta(days=n)).isoformat()  # noqa: E731
    log = lambda pid, n, g=100: client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": g, "meal_type": "breakfast", "day": day(n)})  # noqa: E731
    assert client.get("/api/usual?meal_type=breakfast", headers=h).json() is None  # no history yet
    log(oats, 3, 60); log(egg, 3, 110)
    assert client.get("/api/usual?meal_type=breakfast", headers=h).json() is None  # once is not "usual"
    log(oats, 1, 80); log(egg, 1, 110)
    u = client.get("/api/usual?meal_type=breakfast", headers=h).json()
    assert {i["product_id"]: i["amount_g"] for i in u["items"]} == {oats: 80, egg: 110} and u["kcal"] > 0  # latest amounts
    assert client.get("/api/usual?meal_type=snack2", headers=h).status_code == 422
    client.post("/api/food-logs", headers=h, json={"product_id": oats, "amount_g": 50, "meal_type": "breakfast"})
    assert client.get("/api/usual?meal_type=breakfast", headers=h).json() is None  # eaten today: nothing to offer


def test_local_catalog(client, seeded):
    h = new_user_headers()
    pid = client.get("/api/products/search?q=Гречка", headers=h).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 100, "meal_type": "lunch"})
    own = client.post("/api/products", headers=h, json={"name": "Мой суп локальный", "kcal": 50, "protein_g": 2, "fat_g": 1, "carbs_g": 6}).json()
    items = client.get("/api/products/local", headers=h).json()
    by_id = {i["id"]: i for i in items}
    assert by_id[pid]["mine"] and by_id[own["id"]]["mine"] and items[0]["id"] == pid  # what I eat first
    assert len(items) > 2 and all(i["brand"] is None or i["mine"] for i in items)  # the rest: common plain products
    other = client.get("/api/products/local", headers=new_user_headers()).json()
    assert own["id"] not in {i["id"] for i in other}  # private products stay private


def test_my_photo(client, monkeypatch):
    from backend.api import account

    calls = []

    async def fake(uid):
        calls.append(uid)
        return b"\xff\xd8jpeg" if uid == 555000777 else None
    monkeypatch.setattr(account, "fetch_photo", fake)
    account._photos.clear()
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': 555000777})}"}
    r = client.get("/api/me/photo", headers=h)
    assert r.status_code == 200 and r.content == b"\xff\xd8jpeg" and r.headers["content-type"] == "image/jpeg"
    client.get("/api/me/photo", headers=h)
    assert calls == [555000777]  # cached
    assert client.get("/api/me/photo", headers=new_user_headers()).status_code == 404  # hidden or no photo


def test_exercise_library_import_renames_in_place(client, seeded):
    """A corrected translation renames the row programs already use; nothing is duplicated; ours keep their names."""
    from sqlalchemy import delete, func, select, update

    from backend.database.db import SessionLocal
    from backend.database.models import Exercise
    from backend.seed.import_data import run

    async def go():
        async with SessionLocal() as s:  # the state before: a machine-translated name, no source_id
            row = await s.scalar(select(Exercise).where(Exercise.source_id == "3_4_Sit-Up"))
            await s.execute(update(Exercise).where(Exercise.id == row.id).values(name="3/4 приседания", source_id=None, primary_muscles=None))
            await s.execute(delete(Exercise).where(Exercise.name == "Подъёмы корпуса на 3/4", Exercise.id != row.id))
            await s.commit()
            rid = row.id
        await run()
        async with SessionLocal() as s:
            row = await s.get(Exercise, rid)
            dupes = await s.scalar(select(func.count()).select_from(
                select(Exercise.source_id).where(Exercise.owner_user_id.is_(None), Exercise.source_id.is_not(None))
                .group_by(Exercise.source_id).having(func.count() > 1).subquery()))
            bench = list(await s.scalars(select(Exercise).where(Exercise.name == "Жим штанги лежа", Exercise.owner_user_id.is_(None))))
            return row.name, row.source_id, row.primary_muscles, row.images, dupes, [(b.source_id, b.primary_muscles) for b in bench]
    name, sid, muscles, images, dupes, bench = client.portal.call(go)
    assert (name, sid, muscles) == ("Подъёмы корпуса на 3/4", "3_4_Sit-Up", ["abdominals"]) and len(images) == 2
    assert dupes == 0
    assert bench == [("Barbell_Bench_Press_-_Medium_Grip", ["chest"])]  # not taken over by "Decline ..." (its old name was the same)


def test_library_list_photos_and_muscle_week(client, seeded):
    from backend.api import library

    h = new_user_headers()
    ex = client.get("/api/exercises", headers=h).json()
    sit = next(e for e in ex if e["name"] == "Подъёмы корпуса на 3/4")
    assert sit["primary"] == ["abdominals"] and sit["images"] == ["3_4_Sit-Up/0.jpg", "3_4_Sit-Up/1.jpg"] and sit["category"] == "strength"
    assert len(ex) > 800

    # photos: only well-formed names; a cached one is served without going out
    assert client.get("/api/exercise-image/..%2F..%2Fetc/0.webp").status_code == 404
    assert client.get("/api/exercise-image/Abc/7.webp").status_code == 404
    cached = library.CACHE / "Test_Cached" / "0.webp"
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(b"RIFF....WEBP")
    r = client.get("/api/exercise-image/Test_Cached/0.webp")
    assert r.status_code == 200 and r.content == b"RIFF....WEBP" and "immutable" in r.headers["cache-control"]

    # muscle load: bench press (chest main; shoulders, triceps helpers) x 2 sets
    bench = next(e for e in ex if e["name"] == "Жим штанги лежа")
    log = client.post("/api/workout-logs", headers=h, json={"title": "Т"}).json()
    for n in (1, 2):
        client.post(f"/api/workout-logs/{log['id']}/sets", headers=h, json={"exercise_id": bench["id"], "set_number": n, "reps": 8, "weight_kg": 60})
    week = client.get("/api/muscles/week", headers=h).json()["sets"]
    assert week["chest"] == 2 and all(week[m] == 1 for m in bench["secondary"])


def test_typo_match_keeps_the_first_letter():
    from backend.core.search import fuzzy_match
    assert fuzzy_match(["гричка"], "гречка ядрица") > 0  # a real typo
    # "картошка жареная" must not pull in a brand "Коровка из Кореновки" by sound alone
    assert fuzzy_match(["картошка", "жареная"], "пломбир шоколадный коровка из кореновки") == 0


def test_next_reminder_and_test_message(client):
    from datetime import datetime

    from backend.api.daily import REMINDER_DEFAULTS, next_reminder

    at = lambda h, m: datetime(2026, 11, 19, h, m)  # noqa: E731
    assert next_reminder(REMINDER_DEFAULTS, at(4, 0)) == {"at": "10:00", "what": "завтрак", "tomorrow": False}
    assert next_reminder(REMINDER_DEFAULTS, at(12, 30)) == {"at": "14:00", "what": "обед", "tomorrow": False}
    assert next_reminder(REMINDER_DEFAULTS, at(22, 0)) == {"at": "10:00", "what": "завтрак", "tomorrow": True}
    assert next_reminder({**REMINDER_DEFAULTS, "meals": False, "water": False, "streak": False}, at(9, 0)) is None

    h = new_user_headers()
    mid = client.post("/api/reminders/test", headers=h).json()["id"]
    assert client.get(f"/api/reminders/test/{mid}", headers=h).json() == {"sent": False}  # the bot hasn't run here
    assert client.get(f"/api/reminders/test/{mid}", headers=new_user_headers()).json() == {"sent": False}  # not yours
    assert client.get("/api/reminders/next", headers=h).json()["what"]


def test_training_days_and_target_date(client):
    from datetime import date, datetime, timedelta

    from backend.api.daily import REMINDER_DEFAULTS, next_reminder

    h = new_user_headers()
    body = {**PROFILE, "training_days": [4, 0, 2, 2], "target_date": (date.today() + timedelta(days=90)).isoformat()}
    saved = client.put("/api/profile", headers=h, json=body).json()
    assert saved["training_days"] == [0, 2, 4]  # sorted, no repeats
    assert client.put("/api/profile", headers=h, json={**body, "target_date": date.today().isoformat()}).status_code == 422
    assert client.put("/api/profile", headers=h, json={**body, "training_days": [7]}).status_code == 422
    # the morning reminder counts only on a training day (19.11.2026 is a Thursday = 3)
    thu = datetime(2026, 11, 19, 8, 0)
    assert next_reminder({**REMINDER_DEFAULTS, "training_days": [3]}, thu)["what"] == "тренировка"
    assert next_reminder({**REMINDER_DEFAULTS, "training_days": [0]}, thu)["what"] == "завтрак"
    assert client.get("/api/reminders", headers=h).json()["workout_at"] == "09:00"


def test_export_and_feedback(client, seeded):
    import io
    import uuid
    import zipfile

    from sqlalchemy import select

    from backend.api.feedback import build_export
    from backend.database.db import SessionLocal
    from backend.database.models import Feedback, Outbox, User

    h = new_user_headers()
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 150, "meal_type": "breakfast"})
    client.put("/api/measurements", headers=h, json={"weight_kg": 80})
    assert client.post("/api/export", headers=h).json() == {"ok": True}
    assert client.post("/api/export", headers=h).status_code == 429  # one at a time

    async def files():
        async with SessionLocal() as s:
            m = await s.scalar(select(Outbox).where(Outbox.kind == "export").order_by(Outbox.id.desc()).limit(1))
            data = await build_export(s, await s.get(User, m.user_id))
            return {n: zipfile.ZipFile(io.BytesIO(data)).read(n).decode("utf-8-sig") for n in zipfile.ZipFile(io.BytesIO(data)).namelist()}
    out = client.portal.call(files)
    assert set(out) == {"питание.csv", "вес_и_замеры.csv", "вода.csv", "тренировки.csv"}
    assert "Тестовый творог 5%" in out["питание.csv"] and ";завтрак;" in out["питание.csv"]
    assert "80" in out["вес_и_замеры.csv"].splitlines()[1]

    note = f"белка меньше {uuid.uuid4().hex[:6]}"  # the test database keeps rows between runs
    assert client.post("/api/feedback", headers=h, json={"kind": "product", "text": note, "product_id": pid}).json() == {"ok": True}
    assert client.post("/api/feedback", headers=h, json={"kind": "spam", "text": "xxx"}).status_code == 422
    assert client.post("/api/feedback", headers=h, json={"kind": "idea", "text": "a"}).status_code == 422

    async def saved():
        async with SessionLocal() as s:
            return [(f.kind, f.product_id) for f in await s.scalars(select(Feedback).where(Feedback.text == note))]
    assert client.portal.call(saved) == [("product", pid)]


# ---- The bot's chat: food, water, weight, today, workout, onboarding ----

class FakeMsg:
    """Just enough of aiogram's Message for the chat handlers: records what the bot answered."""

    def __init__(self, tg_id: int, text: str = "", log: list | None = None):
        from types import SimpleNamespace

        self.from_user = SimpleNamespace(id=tg_id, first_name="Егор", username=None, language_code="ru")
        self.chat = SimpleNamespace(id=tg_id)
        self.text, self.log = text, log if log is not None else []
        FakeMsg.seq += 1
        self.message_id = FakeMsg.seq
        self.bot = SimpleNamespace(delete_message=self._deleted)

    seq = 0
    deleted: list = []

    async def _deleted(self, chat_id, message_id):
        FakeMsg.deleted.append(message_id)

    async def answer(self, text, parse_mode=None, reply_markup=None):
        self.log.append((text, reply_markup))
        return FakeMsg(self.from_user.id, text, self.log)

    async def edit_text(self, text, reply_markup=None, parse_mode=None):  # noqa
        self.log.append((text, reply_markup))

    async def delete(self, *a, **kw):
        pass


class FakeCall:
    def __init__(self, tg_id: int, data: str, log: list):
        self.data, self.message, self.from_user = data, FakeMsg(tg_id, "✅ Записал в обед:\n• x", log), FakeMsg(tg_id).from_user

    async def answer(self, *a, **kw):
        pass


def buttons_of(markup) -> list:
    return [b for row in (markup.inline_keyboard if markup else []) for b in row]


def test_bot_splits_food_text():
    from backend.bot.chat import guess_meal, pack, split_food, unpack

    assert split_food("гречка 150 г, 2 яйца и кофе с молоком 200 мл") == [
        ("гречка", 150, "g", None), ("яйца", None, None, 2), ("кофе", None, None, None), ("молоком", 200, "ml", None)]
    assert split_food("сок 0,5 л; хлеб 1 кг") == [("сок", 500, "ml", None), ("хлеб", 1000, "g", None)]
    assert unpack(pack([1, 35, 36, 123456789])) == [1, 35, 36, 123456789]
    assert [guess_meal(h) for h in (8, 13, 17, 20, 2)] == ["breakfast", "lunch", "snack", "dinner", "snack"]


def test_bot_chat_food_water_weight_today(client, seeded):
    import random

    from backend.bot import chat

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    log: list = []
    client.portal.call(chat.log_food, FakeMsg(tg_id, log=log), "творог 200 г")
    assert "анкета" in log[-1][0]  # no questionnaire yet: no norm to count against
    client.put("/api/profile", headers=h, json=PROFILE)

    client.portal.call(chat.any_text, FakeMsg(tg_id, "тестовый творог 5% 200 г", log))
    text, markup = log[-1]
    assert "записал ✓" in text and "Тестовый творог 5%" in text and "242 ккал" in text and "осталось" in text and "🟩" in text
    datas = [b.callback_data for b in buttons_of(markup)]
    assert len([d for d in datas if d.startswith("fm:") and d != "fm:same"]) == 3 and "fm:same" in datas
    assert any(d.startswith("fu:") for d in datas)
    assert [b.style for b in buttons_of(markup) if b.callback_data == "fm:same"] == ["success"]  # the current meal
    items = client.get("/api/food-logs", headers=h).json()["items"]
    assert [(i["amount_g"], i["product"]["name"]) for i in items] == [(200, "Тестовый творог 5%")]

    move = next(d for d in datas if d.startswith("fm:") and d != "fm:same")  # whichever meal isn't the current one
    client.portal.call(chat.move_food, FakeCall(tg_id, move, log))
    meal = chat.CODE[move.split(":")[1]]
    assert chat.MEALS[meal].capitalize() in log[-1][0]
    assert client.get("/api/food-logs", headers=h).json()["items"][0]["meal_type"] == meal
    client.portal.call(chat.undo_food, FakeCall(tg_id, next(d for d in datas if d.startswith("fu:")), log))
    assert client.get("/api/food-logs", headers=h).json()["items"] == []

    client.portal.call(chat.any_text, FakeMsg(tg_id, "+300", log))
    assert log[-1][0].startswith("💧 +300 мл · 0,3 из")
    client.portal.call(chat.water_button, FakeCall(tg_id, "w:-300", log))
    assert client.get("/api/water", headers=h).json()["ml"] == 0

    client.portal.call(chat.any_text, FakeMsg(tg_id, "вес 77,5", log))
    assert log[-1][0].startswith("⚖️ Записал: 77,5 кг.")
    assert client.get("/api/measurements", headers=h).json()[0]["weight_kg"] == 77.5
    assert client.get("/api/profile", headers=h).json()["weight_kg"] == 77.5  # the norm follows the latest weight

    client.portal.call(chat.today_cmd, FakeMsg(tg_id, log=log))
    assert log[-1][0].startswith("📊 <b>Сегодня") and "ккал" in log[-1][0] and "💧" in log[-1][0]
    client.portal.call(chat.workout_cmd, FakeMsg(tg_id, log=log))
    text, markup = log[-1]
    assert "Тренировка" in text or "тренировка" in text
    assert any(b.web_app and "open=workout" in b.web_app.url for b in buttons_of(markup))


def test_bot_plan_message_after_first_questionnaire(client):
    import random

    from sqlalchemy import select

    from backend.bot import outbox
    from backend.database.db import SessionLocal
    from backend.database.models import Outbox

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    client.put("/api/profile", headers=h, json=PROFILE)  # an edit: no second "plan ready"
    sent = []

    class Bot:
        async def send_message(self, chat_id, text, **kw):
            sent.append((chat_id, text, kw.get("reply_markup")))

    async def run():
        async with SessionLocal() as s:
            rows = list(await s.scalars(select(Outbox).where(Outbox.telegram_id == tg_id, Outbox.kind == "plan")))
            for m in rows:
                await outbox.send_plan(Bot(), s, m)
            return len(rows)

    assert client.portal.call(run) == 1
    assert "Твой план готов" in sent[0][1] and "ккал" in sent[0][1] and sent[0][2].keyboard


def test_bot_onboarding_chain(client, seeded):
    import random
    from datetime import datetime, timedelta

    from sqlalchemy import update

    from backend.bot import chat
    from backend.bot.reminders import collect
    from backend.database.db import SessionLocal
    from backend.database.models import User

    now = datetime.now().astimezone()
    newbie = random.randint(3 * 10**9, 4 * 10**9)  # pressed /start, no questionnaire
    client.portal.call(chat.me_for_test, newbie)

    async def age(tg_id, created):
        async with SessionLocal() as s:
            await s.execute(update(User).where(User.telegram_id == tg_id).values(created_at=created))
            await s.commit()

    async def run(at, tg_id):
        async with SessionLocal() as s:
            return [(t, b) for c, t, _, b in await collect(s, at) if c == tg_id]

    afternoon = now.replace(hour=14, minute=0, second=0, microsecond=0)
    client.portal.call(age, newbie, afternoon - timedelta(hours=4))
    assert [t for t, _ in client.portal.call(run, afternoon, newbie)][0].startswith("Осталась пара вопросов")
    assert client.portal.call(run, afternoon + timedelta(minutes=5), newbie) == []  # once
    client.portal.call(age, newbie, afternoon - timedelta(hours=26))
    assert "Последнее напоминание" in client.portal.call(run, afternoon, newbie)[0][0]
    assert client.portal.call(run, afternoon + timedelta(hours=1), newbie) == []  # and then silence

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    evening = now.replace(hour=21, minute=1, second=0, microsecond=0)
    assert client.portal.call(run, evening, tg_id)[0][0].startswith("🌙 Первый день позади")  # created today
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 300, "meal_type": "lunch"})
    client.portal.call(age, tg_id, now - timedelta(days=5))
    if evening.date() == now.date() and now.hour < 21:  # the entry is "today" only when the test runs before 21:00
        text, buttons = client.portal.call(run, evening, tg_id)[0]
        assert text.startswith("🌙 Итог дня: 363 из") and "Белка не хватает" in text
        assert buttons == [("🍽 Записать ужин", "cb:ask:d"), ("Что поесть?", "cbr:eat")]
    client.portal.call(age, tg_id, now - timedelta(days=2))
    assert client.portal.call(run, now.replace(hour=13, minute=2, second=0, microsecond=0), tg_id)[0][0].startswith("📸 Совет")


def test_tour_cards_are_vertical_pngs():
    import io

    from PIL import Image

    from backend.bot import cards

    for i in range(len(cards.TOUR)):
        img = Image.open(io.BytesIO(cards.tour(i)))
        assert img.size == (1080, 1350)


def test_tour_flips_with_arrows():
    from backend.bot.chat import tour_keyboard

    def arrows(i):
        return [b.callback_data for b in tour_keyboard(i).inline_keyboard[0]]

    assert arrows(0) == ["tour:3", "tour:1"] and arrows(3) == ["tour:2", "tour:0"]  # wraps around
    assert tour_keyboard(0).inline_keyboard[1][0].web_app  # the questionnaire button on every slide


def test_tour_copies_the_channel_post_and_falls_back_to_slides(client, tmp_path, monkeypatch):
    import json

    from backend.bot import chat

    log, copied = [], []

    class Bot:
        async def copy_messages(self, chat_id, from_chat_id, ids):
            if from_chat_id == -1:
                raise RuntimeError("bot is not a member")
            copied.append((chat_id, from_chat_id, ids))

    class Msg(FakeMsg):
        async def answer_photo(self, photo, caption=None, reply_markup=None):
            self.log.append(("photo", reply_markup))

    call = FakeCall(42, "tour", log)
    call.message = Msg(42, "", log)
    monkeypatch.setattr(chat, "TOUR_POST", tmp_path / ".tour_post")
    client.portal.call(chat.tour, call, Bot())  # no post saved: the slides with arrows
    assert log[-1][0] == "photo"
    (tmp_path / ".tour_post").write_text(json.dumps({"chat_id": -100123, "ids": [5, 6, 7, 8]}))
    client.portal.call(chat.tour, call, Bot())
    assert copied == [(42, -100123, [5, 6, 7, 8])] and log[-1][0] == chat.TOUR_INVITE
    (tmp_path / ".tour_post").write_text(json.dumps({"chat_id": -1, "ids": [5]}))
    client.portal.call(chat.tour, call, Bot())  # copying failed: still the slides
    assert log[-1][0] == "photo"


def test_bot_products_in_a_row_join_one_card(client, seeded):
    import random

    from backend.bot import chat

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    log: list = []
    client.portal.call(chat.any_text, FakeMsg(tg_id, "тестовый творог 5% 200 г", log))
    first = chat._cards[tg_id][0]
    client.portal.call(chat.any_text, FakeMsg(tg_id, "тестовый творог 5% 100 г", log))
    text, markup = log[-1]
    assert text.count("Тестовый творог 5%") == 2 and "Всего <b>363 ккал</b>" in text  # one card, one total
    assert first in FakeMsg.deleted  # the old card is gone, the new one is at the bottom
    items = client.get("/api/food-logs", headers=h).json()["items"]
    assert len(items) == 2 and len({i["meal_type"] for i in items}) == 1 and len({i["snack_slot"] for i in items}) == 1
    undo = next(b.callback_data for row in markup.inline_keyboard for b in row if b.callback_data.startswith("fu:"))
    call = FakeCall(tg_id, undo, log)
    call.message.message_id = chat._cards[tg_id][0]
    client.portal.call(chat.undo_food, call)
    assert client.get("/api/food-logs", headers=h).json()["items"] == [] and tg_id not in chat._cards
    client.portal.call(chat.any_text, FakeMsg(tg_id, "тестовый творог 5% 100 г", log))
    assert "Всего" not in log[-1][0]  # after undo: a fresh card


def test_bot_understands_any_amount_of_water(client):
    import random

    from backend.bot import chat

    cases = {"+300": 300, "500 мл": 500, "вода 0,5 л": 500, "Выпил 2 стакана воды": 500, "бутылка воды": 500,
             "1,5 л воды": 1500, "-250": -250, "вода": 250, "водички 300 мл": 300}
    assert {t: chat.water_amount(t) for t in cases} == cases
    for food in ("300", "кефир 250 мл", "стакан кефира", "водка 50 мл", "гречка 150 г"):
        assert chat.water_amount(food) is None, food

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    log: list = []
    client.portal.call(chat.any_text, FakeMsg(tg_id, "1,5 л воды", log))  # more than the API's 1 l per call
    assert log[-1][0].startswith("💧 +1500 мл · 1,5 из")
    assert client.get("/api/water", headers=h).json()["ml"] == 1500
    datas = [b.callback_data for row in log[-1][1].inline_keyboard for b in row]
    assert "w:500" in datas and "w:-1500" in datas


def test_workout_evolution_uses_distinct_completions(client, seeded):
    h = new_user_headers()
    ex = client.get("/api/programs").json()[0]["days"][0]["exercises"][0]["exercise_id"]
    for _ in range(5):
        log = client.post("/api/workout-logs", headers=h, json={"title": "Тест"}).json()["id"]
        assert client.post(f"/api/workout-logs/{log}/sets", headers=h, json={
            "exercise_id": ex, "set_number": 1, "reps": 8}).status_code == 200
        assert client.post(f"/api/workout-logs/{log}/complete", headers=h).status_code == 200
    response = client.get("/api/achievements", headers=h).json()
    badge = next(i for i in response["items"] if i["code"] == "iron_will")
    assert (badge["progress"], badge["stage"], badge["target"]) == (5, 1, 25)
    xp = client.post("/api/auth", headers=h).json()["progress"]["xp"]
    assert client.post(f"/api/workout-logs/{log}/complete", headers=h).json()["xp_awarded"] == 0
    client.post("/api/achievements/seen", headers=h)
    assert not client.get("/api/achievements", headers=h).json()["new"]
    assert client.post("/api/auth", headers=h).json()["progress"]["xp"] == xp


def test_showcase_ownership_and_persistence(client, seeded):
    h = new_user_headers()
    endpoint = "/api/achievements/showcase"
    choice = {"showcase": ["first_water"], "pinned": "first_water"}
    assert client.put(endpoint, headers=h, json=choice).status_code == 400
    client.post("/api/water", headers=h, json={"delta_ml": 250}).raise_for_status()
    client.get("/api/achievements", headers=h).raise_for_status()
    client.put(endpoint, headers=h, json=choice).raise_for_status()
    items = client.get("/api/achievements", headers=h).json()["items"]
    assert any(i["code"] == "first_water" and i["featured"] and i["pinned"] for i in items)
    assert client.put(endpoint, headers=new_user_headers(), json=choice).status_code == 400


def test_achievement_title_requires_ownership_and_persists(client, seeded):
    user = new_user_headers()
    other = new_user_headers()
    endpoint = "/api/achievements/title"
    assert client.put(endpoint, headers=user, json={"code": "first_water"}).status_code == 400
    client.post("/api/water", headers=user, json={"delta_ml": 250}).raise_for_status()
    client.get("/api/achievements", headers=user).raise_for_status()
    assert client.put(endpoint, headers=other, json={"code": "first_water"}).status_code == 400
    client.put(endpoint, headers=user, json={"code": "first_water"}).raise_for_status()
    items = client.get("/api/achievements", headers=user).json()["items"]
    assert next(a for a in items if a["code"] == "first_water")["title_selected"]
    client.put(endpoint, headers=user, json={"code": None}).raise_for_status()
    assert not any(a["title_selected"] for a in client.get("/api/achievements", headers=user).json()["items"])


# ---- Coaching features: what to eat, effort and plateaus, check-in, cheers, corrections, menu advice ----

def test_what_to_eat_has_ideas_for_a_new_user_and_follows_history(client, seeded):
    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)
    r = client.get("/api/suggest/meal", params={"meal_type": "breakfast"}, headers=h).json()
    assert r["meal_type"] == "breakfast" and r["kcal_left"] > 1500
    assert r["options"] and all(o["title"].startswith("Идея: ") for o in r["options"])  # no history yet: plain ideas
    assert all(o["kcal"] <= r["kcal_left"] for o in r["options"])


def test_effort_and_plateau_history_for_the_next_workout(client, seeded):
    h = new_user_headers()
    day_id = client.get("/api/programs").json()[0]["days"][0]["id"]
    ex_id = client.get("/api/programs").json()[0]["days"][0]["exercises"][0]["exercise_id"]
    for reps in (9, 10, 9):  # three workouts at the same weight
        w = client.post("/api/workout-logs", headers=h, json={"program_day_id": day_id, "title": "День 1"}).json()
        client.post(f"/api/workout-logs/{w['id']}/sets", headers=h, json={"exercise_id": ex_id, "set_number": 1, "reps": reps, "weight_kg": 60})
        client.post(f"/api/workout-logs/{w['id']}/complete", headers=h)
    assert client.post(f"/api/workout-logs/{w['id']}/effort", headers=h, json={"effort": "hard"}).status_code == 200
    assert client.post(f"/api/workout-logs/{w['id']}/effort", headers=h, json={"effort": "meh"}).status_code == 422
    last = client.get("/api/exercises/last", params={"ids": str(ex_id)}, headers=h).json()[str(ex_id)]
    assert last["effort"] == "hard" and [x["reps"] for x in last["history"]] == [9, 10, 9]  # newest first
    assert client.post(f"/api/workout-logs/{w['id']}/effort", headers=new_user_headers(), json={"effort": "easy"}).status_code == 404


def test_morning_checkin_and_its_insight(client):
    import random
    from datetime import timedelta

    from backend.api.daily import checkin_insight
    from backend.core import clock
    from backend.database.db import SessionLocal
    from backend.database.models import DailyCheckin, FoodLog, Product, User
    from sqlalchemy import select

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    assert client.post("/api/checkin", headers=h, json={"sleep": 3}).json()["sleep"] == 3
    r = client.post("/api/checkin", headers=h, json={"energy": 2}).json()
    assert (r["sleep"], r["energy"], r["insight"]) == (3, 2, None)  # sleep kept, too early for insights
    assert client.post("/api/checkin", headers=h, json={"sleep": 5}).status_code == 422

    async def history():  # 5 good nights with light days, 5 short nights with heavy days
        async with SessionLocal() as s:
            user = await s.scalar(select(User).where(User.telegram_id == tg_id))
            p = Product(name="Еда для теста сна", kcal=100, protein_g=5, fat_g=5, carbs_g=10)
            s.add(p)
            await s.flush()
            for i in range(1, 11):
                d = clock.today() - timedelta(days=i)
                s.add(DailyCheckin(user_id=user.id, day=d, sleep=4 if i <= 5 else 1, energy=2))
                s.add(FoodLog(user_id=user.id, product_id=p.id, amount_g=1800 if i <= 5 else 2400, meal_type="lunch",
                              logged_at=clock.local_start(d) + timedelta(hours=13)))
            await s.commit()
            return await checkin_insight(s, user)

    assert client.portal.call(history) == "В дни после сна 7+ часов ты съедаешь на 600 ккал меньше."


def test_cheer_a_friend_for_a_workout(client, seeded):
    import random

    from backend.database.db import SessionLocal
    from backend.database.models import Outbox
    from sqlalchemy import select

    a, b = (random.randint(3 * 10**9, 4 * 10**9) for _ in range(2))
    ha = {"Authorization": f"tma {make_init_data({**USER, 'id': a, 'first_name': 'Аня'})}"}
    hb = {"Authorization": f"tma {make_init_data({**USER, 'id': b, 'first_name': 'Боря'})}"}
    link = client.get("/api/friends", headers=ha).json()["invite_link"] or ""
    code = link.rsplit("=f", 1)[-1] if link else client.portal.call(_invite_code, a)
    from backend.api.social import befriend

    async def make_friends():
        async with SessionLocal() as s:
            await befriend(s, code, b, "Боря")
    client.portal.call(make_friends)
    day_id = client.get("/api/programs").json()[0]["days"][0]["id"]
    ex_id = client.get("/api/programs").json()[0]["days"][0]["exercises"][0]["exercise_id"]
    w = client.post("/api/workout-logs", headers=hb, json={"program_day_id": day_id, "title": "День 1"}).json()
    client.post(f"/api/workout-logs/{w['id']}/sets", headers=hb, json={"exercise_id": ex_id, "set_number": 1, "reps": 8, "weight_kg": 40})
    client.post(f"/api/workout-logs/{w['id']}/complete", headers=hb)
    boris = next(r for r in client.get("/api/friends", headers=ha).json()["board"] if not r["me"])
    assert boris["trained_today"] and not boris["cheered"]
    assert client.post(f"/api/friends/{boris['id']}/cheer", headers=ha, json={"emoji": "👏"}).json()["sent"] is True
    assert client.post(f"/api/friends/{boris['id']}/cheer", headers=ha, json={"emoji": "🔥"}).json()["sent"] is False  # once a day
    assert next(r for r in client.get("/api/friends", headers=ha).json()["board"] if not r["me"])["cheered"]
    assert client.post(f"/api/friends/{boris['id']}/cheer", headers=new_user_headers(), json={"emoji": "👏"}).status_code == 404

    async def sent():
        async with SessionLocal() as s:
            return [m.text for m in await s.scalars(select(Outbox).where(Outbox.telegram_id == b))]
    assert any(t.startswith("👏 Аня отмечает твою тренировку") for t in client.portal.call(sent))


async def _invite_code(tg_id):
    from backend.api.social import invite_code
    from backend.database.db import SessionLocal
    from backend.database.models import User
    from sqlalchemy import select

    async with SessionLocal() as s:
        return await invite_code(s, await s.scalar(select(User).where(User.telegram_id == tg_id)))


def test_bot_fixes_the_open_card_in_words_and_suggests_food(client, seeded):
    import random

    from backend.bot import chat

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    log: list = []
    client.portal.call(chat.any_text, FakeMsg(tg_id, "тестовый творог 5% 200 г", log))
    client.portal.call(chat.any_text, FakeMsg(tg_id, "тестовый творог обезжиренный 100 г", log))
    client.portal.call(chat.any_text, FakeMsg(tg_id, "творога было 150", log))  # the first one that matches
    items = client.get("/api/food-logs", headers=h).json()["items"]
    assert sorted(i["amount_g"] for i in items) == [100, 150]
    client.portal.call(chat.any_text, FakeMsg(tg_id, "это был ужин", log))
    assert {i["meal_type"] for i in client.get("/api/food-logs", headers=h).json()["items"]} == {"dinner"}
    assert "Ужин" in log[-1][0]
    client.portal.call(chat.any_text, FakeMsg(tg_id, "убери обезжиренный", log))
    assert [i["amount_g"] for i in client.get("/api/food-logs", headers=h).json()["items"]] == [150]

    client.portal.call(chat.any_text, FakeMsg(tg_id, "что поесть?", log))
    text, markup = log[-1]
    assert text.startswith("🍽 <b>Что поесть на") and "Осталось" in text
    pick = next(b.callback_data for row in markup.inline_keyboard for b in row if b.callback_data and b.callback_data.startswith("ea:"))
    before = len(client.get("/api/food-logs", headers=h).json()["items"])
    call = FakeCall(tg_id, pick, log)
    call.message.edit_reply_markup = FakeMsg(tg_id).delete  # accepts reply_markup=None like aiogram's
    client.portal.call(chat.eat_pick, call)
    assert len(client.get("/api/food-logs", headers=h).json()["items"]) > before


def test_menu_advice_picks_what_fits():
    from backend.bot.chat import menu_advice

    dishes = [
        {"name": "Цезарь с курицей", "kcal": 180, "protein_g": 12, "fat_g": 10, "carbs_g": 8, "portion_g": 250, "estimated": True},
        {"name": "Паста карбонара", "kcal": 300, "protein_g": 11, "fat_g": 15, "carbs_g": 30, "portion_g": 350, "estimated": True},
        {"name": "Морс", "kcal": 40, "protein_g": 0, "fat_g": 0, "carbs_g": 10, "portion_g": None},
    ]
    text = menu_advice(dishes, kcal_left=900, protein_left=40, aim=700)
    assert "✅ Цезарь с курицей — ≈450 ккал" in text
    assert "⚠️ Паста карбонара — ≈1 050 ккал, это 117% остатка" in text and "≈ — оценка" in text


def test_fasting_plan_timer_and_reminders(client):
    import random
    from datetime import datetime, timedelta

    from backend.api import fasting
    from backend.bot.reminders import collect
    from backend.database.db import SessionLocal
    from backend.database.models import FastingPlan
    from conftest import USER, make_init_data

    plan = FastingPlan(hours=16, eat_from="12:00")
    assert fasting.eat_to(plan) == "20:00" and fasting.eat_to(FastingPlan(hours=18, eat_from="20:00")) == "02:00"
    day = datetime(2026, 3, 2, tzinfo=datetime.now().astimezone().tzinfo)
    assert fasting.in_window(plan, day.replace(hour=12)) and not fasting.in_window(plan, day.replace(hour=20))
    assert fasting.in_window(FastingPlan(hours=18, eat_from="20:00"), day.replace(hour=1))  # a window past midnight
    # last meal at 19:30 -> at 9:30 the fast is 14 h, the window opens in 150 minutes
    st = fasting.state(plan, day.replace(hour=19, minute=30), day.replace(hour=9, minute=30) + timedelta(days=1))
    assert (st["eating"], st["fasted_h"], st["change_in"]) == (False, 14.0, 150)
    assert "14 ч из 16" in fasting.text(plan, st)
    # nothing logged for days: counted from the last window close, not from a week ago
    old = fasting.state(plan, day - timedelta(days=5), day.replace(hour=10))
    assert old["fasted_h"] == 14.0

    tg_id = random.randint(3 * 10**9, 4 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    client.put("/api/profile", headers=h, json=PROFILE)
    assert client.get("/api/fasting", headers=h).json() == {"plan": None}
    body = {"hours": 16, "eat_from": "12:00", "remind": True, "safe": True}
    assert client.put("/api/fasting", headers=h, json={**body, "safe": False}).status_code == 422  # contraindications not confirmed
    assert client.put("/api/fasting", headers=h, json={**body, "hours": 20}).status_code == 422
    r = client.put("/api/fasting", headers=h, json=body).json()
    assert r["plan"] == {"hours": 16, "eat_from": "12:00", "eat_to": "20:00", "remind": True} and "fast_start" in r

    now = datetime.now().astimezone()

    async def run(at):
        async with SessionLocal() as s:
            return await collect(s, now.replace(hour=at[0], minute=at[1], second=0, microsecond=0))

    def texts(at):
        return [t for chat, t, _, _ in client.portal.call(run, at) if chat == tg_id]

    assert not any("завтрак" in t for t in texts((10, 5)))  # breakfast at 10:00 is outside the 12–20 window
    assert any(t.startswith("🍽 Окно питания открылось (до 20:00)") for t in texts((12, 1)))
    assert any("Через 30 минут, в 20:00" in t and "Белка осталось" in t for t in texts((19, 31)))
    assert client.delete("/api/fasting", headers=h).json() == {"plan": None}



def test_training_day_carbs_protein_from_diary_and_plateau_tips(client):
    import random
    from datetime import date, datetime, time, timedelta

    from backend.bot.reminders import collect
    from backend.core.nutrition import cycle, daily_targets
    from backend.database.db import SessionLocal
    from backend.database.models import FoodLog, Product, User
    from conftest import USER, make_init_data

    t = daily_targets("male", 1998, 190, 76, "moderate", "muscle_gain")
    week = [cycle(t, 190, 76, [0, 2, 4], wd, False) for wd in range(7)]
    assert [d["carbs_shift"] for d in week] == [57, -43, 57, -43, 57, -43, -43]
    assert abs(sum(d["calories"] for d in week) - 7 * t["calories"]) <= 7 * 4  # the week's energy unchanged
    assert cycle(t, 190, 76, None, 3, True)["day"] == "training"  # an unplanned workout done today
    assert cycle(t, 190, 76, None, 3, False)["day"] is None and cycle(t, 190, 76, list(range(7)), 3, True)["day"] is None
    low = daily_targets("female", 1998, 165, 60, "light", "weight_loss")  # carbs already ~2 g/kg: nothing to move
    assert cycle(low, 165, 60, [0, 1, 2, 3, 4], 5, False)["carbs_shift"] == 0

    tg_id = random.randint(6 * 10**9, 7 * 10**9)
    h = {"Authorization": f"tma {make_init_data({**USER, 'id': tg_id})}"}
    today = date.today()
    every = [d for d in range(7) if d != today.weekday()]  # today is a rest day
    p = client.put("/api/profile", headers=h, json={**PROFILE, "training_days": every[:3]}).json()
    assert p["targets"]["day"] == "rest" and p["targets"]["carbs"] < p["targets_base"]["carbs"]
    p = client.put("/api/profile", headers=h, json={**PROFILE, "training_days": [today.weekday()]}).json()
    assert p["targets"]["day"] == "training" and p["targets"]["carbs"] == p["targets_base"]["carbs"] + p["targets"]["carbs_shift"]

    # protein lags in the afternoon: the bot offers the user's own usual protein foods, one tap each
    async def seed():
        async with SessionLocal() as s:
            from sqlalchemy import select

            user = await s.scalar(select(User).where(User.telegram_id == tg_id))
            curd = Product(name=f"Творог зернёный {tg_id}", kcal=100, protein_g=17, fat_g=2, carbs_g=3)
            bread = Product(name=f"Батон {tg_id}", kcal=260, protein_g=8, fat_g=3, carbs_g=50)
            s.add_all([curd, bread])
            await s.flush()
            for i in (2, 3, 5):
                s.add(FoodLog(user_id=user.id, product_id=curd.id, amount_g=200, meal_type="snack",
                              logged_at=datetime.combine(today - timedelta(days=i), time(16)).astimezone()))
            s.add(FoodLog(user_id=user.id, product_id=bread.id, amount_g=400, meal_type="breakfast",  # 1040 kcal, 32 g protein
                          logged_at=datetime.combine(today, time(9)).astimezone()))
            await s.commit()
            return curd.id
    curd_id = client.portal.call(seed)
    now = datetime.now().astimezone()

    async def run(at):
        async with SessionLocal() as s:
            return await collect(s, now.replace(hour=at[0], minute=at[1], second=0, microsecond=0))

    sent = [(t, b) for chat, t, _, b in client.portal.call(run, (16, 31)) if chat == tg_id]
    msg, buttons = next((t, b) for t, b in sent if t.startswith("🥩 Белка пока 32 из"))
    assert f"творог зернёный {tg_id} 200 г (+34 г)" in msg
    assert buttons[0][1].startswith("cb:ea:s:") and buttons[0][1].endswith("x200") and "34 г белка" in buttons[0][0]
    from backend.bot.chat import _b36
    assert _b36(curd_id) in buttons[0][1]
