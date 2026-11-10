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

    # "last time": only the latest workout's sets, only this user's
    w2 = client.post("/api/workout-logs", headers=h, json={"program_day_id": day_id, "title": "День 1"}).json()
    for n, kg in ((1, 62.5), (2, 60)):
        client.post(f"/api/workout-logs/{w2['id']}/sets", headers=h, json={**s, "set_number": n, "weight_kg": kg})
    last = client.get(f"/api/exercises/last?ids={ex_id},999999", headers=h).json()
    assert [x["weight_kg"] for x in last[str(ex_id)]["sets"]] == [62.5, 60] and "999999" not in last
    assert client.get(f"/api/exercises/last?ids={ex_id}", headers=other).json() == {}


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
    assert [x["id"] for x in client.get("/api/products/search", params={"q": "сырник"}, headers=h).json()] == [p["id"]]
    assert client.get("/api/products/search", params={"q": "сырник"}, headers=new_user_headers()).json() == []
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
        return [t for chat, t, _ in client.portal.call(run, at) if chat == tg_id]  # other test users get theirs too

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
    noon = [(t, card) for chat, t, card in client.portal.call(run, (12, 1)) if chat == tg2]
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
    for h in users[:3]:
        r = client.post("/api/products", headers=h, json={**plain, "name": f"Кефир {tag}", "barcode": code}).json()
    assert r["shared"] is True
    assert client.get(f"/api/products/barcode/{code}", headers=new_user_headers()).json()["category"] == "Проверено пользователями"


def test_settings_are_kept_on_the_account(client, seeded):
    h = new_user_headers()
    assert client.post("/api/auth", headers=h).json()["settings"] == {"theme": None, "accent": None, "program_id": None, "boost_until": None, "device_tz": None}
    pid = client.get("/api/programs").json()[0]["id"]
    assert client.put("/api/settings", headers=h, json={"theme": "green"}).json() == {"theme": "green", "accent": None, "program_id": None, "boost_until": None, "device_tz": None}
    assert client.put("/api/settings", headers=h, json={"accent": "#a98bff", "program_id": pid}).json()["theme"] == "green"  # partial
    assert client.post("/api/auth", headers=h).json()["settings"] == {"theme": "green", "accent": "#a98bff", "program_id": pid, "boost_until": None, "device_tz": None}
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
            *(cards.welcome_back(kind, theme, "#a98bff") for kind in cards.BACK_KINDS),
            cards.share("Егор", 21, 1340, 4, 7, theme, "#a98bff"),
        ):
            assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) < 400_000


def test_bot_greeting_handles_empty_and_invisible_names():
    from backend.bot.main import greeting

    assert greeting("Егор", False).startswith("Привет, Егор! 👋")
    assert greeting("­", False).startswith("Привет! 👋")  # soft hyphen only: Telegram shows it as blank
    assert greeting("​ ⁣", False).startswith("Привет! 👋")
    assert greeting(None, False).startswith("Привет! 👋")
    assert greeting("<b>Хакер</b>", False).startswith("Привет, &lt;b&gt;Хакер&lt;/b&gt;!")  # HTML caption
    assert greeting("Анна Мария", True).startswith("С возвращением, Анна Мария!")


def test_welcome_back_varies_and_never_repeats_in_a_row():
    from backend.bot import cards
    from backend.bot.main import BACK, greeting, pick_back

    assert {b[3] for b in BACK} <= set(cards.BACK_KINDS)
    picks = [pick_back(42) for _ in range(60)]
    assert all(a != b for a, b in zip(picks, picks[1:])) and len(set(picks)) == len(BACK)
    for i, (word, emoji, body, _) in enumerate(BACK):
        assert greeting("Егор", True, i) == f"{word}, Егор! {emoji}\n\n{body}"


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
            return [(t, card) for chat, t, card in await collect(s, at) if chat == tg_id]

    assert not any("Итоги недели" in t for t, _ in client.portal.call(run, monday))  # only on Sundays
    weekly = [(t, card) for t, card in client.portal.call(run, sunday) if "Итоги недели" in t]
    if sunday.date() == now.date():  # the food entry is inside that week only when the test runs on a Sunday
        assert "в среднем" in weekly[0][0]
    assert len(weekly) == 1 and weekly[0][0].endswith("Совет: больше белка на ужин.")
    assert weekly[0][1]()[:4] == b"\x89PNG"
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
            return [txt for chat, txt, _ in await collect(s, t) if chat == tg_id]
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

    async def texts(s):
        return list(await s.scalars(select(Outbox.text).where(Outbox.telegram_id.in_(ids))))
    t = db(texts)
    assert any("+40 XP и бустер ×1,5" in x for x in t) and any("Реванш" in x for x in t) and any("вызывает вас на дуэль" in x for x in t)
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
    assert r["items"][1]["title"] == "Взвесьтесь 1 раз"


def test_bootstrap_has_the_whole_first_screen(client, seeded):
    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)
    b = client.post("/api/bootstrap", headers=h).json()
    assert set(b) == {"auth", "food_day", "water", "week", "workout_logs", "measurements", "achievements", "ai", "programs", "quests", "yesterday"}
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
