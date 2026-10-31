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
    assert btn.text == "Открыть Fitness Assistant"
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
    # BMR = 784 + 1137.5 - 150 + 5 = 1776.5; *1.55*0.80 = 2202.9
    assert t == {"calories": 2203, "protein": 157, "fat": 71, "carbs": 234}
    assert daily_targets(**{**PROFILE, "goal": "lose"}) == daily_targets(**PROFILE)  # old saved goal still works
    # tiny woman, sedentary, aggressive deficit -> safety floor
    floor = daily_targets("female", date.today().year - 60, 150, 42, "low", "weight_loss")
    assert floor["calories"] == 1200


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
    saved = client.put("/api/profile", headers=h, json={**PROFILE, **EXTENDED}).json()
    assert {k: saved[k] for k in EXTENDED} == EXTENDED

    rec = client.post("/api/auth", headers=h).json()["recommended_program"]
    programs = {p["id"]: p["name"] for p in client.get("/api/programs").json()}
    assert programs[rec["program_id"]] == "Домашняя тренировка (без инвентаря)"  # beginner, 2 days, no barbell

    gym = {**EXTENDED, "experience": "intermediate", "sessions_per_week": 3,
           "equipment": ["barbell", "bench", "pullup_bar", "dumbbells", "machine"]}
    client.put("/api/profile", headers=h, json={**PROFILE, **gym})
    rec = client.post("/api/auth", headers=h).json()["recommended_program"]
    assert programs[rec["program_id"]] == "Тяни-Толкай-Ноги (PPL)" and "всё оборудование у вас есть" in rec["reasons"]

    # old-style profile (no extended answers) is still valid
    assert client.put("/api/profile", headers=h, json=PROFILE).json()["experience"] is None


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
