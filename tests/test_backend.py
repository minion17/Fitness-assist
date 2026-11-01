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
    assert client.put("/api/reminders", headers=h, json=cfg).json() == cfg
    client.put("/api/profile", headers=h, json=PROFILE)  # reminders go to registered users only

    async def run(at):
        async with SessionLocal() as s:
            return await collect(s, now.replace(hour=at[0], minute=at[1], second=0, microsecond=0))

    def texts(at):
        return [t for chat, t in client.portal.call(run, at) if chat == tg_id]  # other test users get theirs too

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
    noon = [t for chat, t in client.portal.call(run, (12, 1)) if chat == tg2]
    assert noon == ["💧 Выпито 0,25 л из 2,5 л. Стакан воды сейчас — самое время."]


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
    assert third["shared"] is True
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
    assert client.post("/api/auth", headers=h).json()["settings"] == {"theme": None, "accent": None, "program_id": None}
    pid = client.get("/api/programs").json()[0]["id"]
    assert client.put("/api/settings", headers=h, json={"theme": "green"}).json() == {"theme": "green", "accent": None, "program_id": None}
    assert client.put("/api/settings", headers=h, json={"accent": "#a98bff", "program_id": pid}).json()["theme"] == "green"  # partial
    assert client.post("/api/auth", headers=h).json()["settings"] == {"theme": "green", "accent": "#a98bff", "program_id": pid}
    assert client.put("/api/settings", headers=h, json={"program_id": None}).json()["program_id"] is None
    assert client.put("/api/settings", headers=h, json={"theme": "neon"}).status_code == 422
    assert client.put("/api/settings", headers=h, json={"accent": "red"}).status_code == 422
    assert client.put("/api/settings", headers=h, json={"program_id": 999999}).status_code == 404


def test_bot_profile_synced_only_when_changed(tmp_path, monkeypatch):
    import asyncio

    from backend.bot import profile

    calls = []

    class FakeBot:
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
    assert calls == ["description", "short", "photo"]  # second start: nothing changed, nothing re-uploaded
    monkeypatch.setattr(profile, "SHORT_DESCRIPTION", profile.SHORT_DESCRIPTION + "!")
    asyncio.run(profile.sync(FakeBot()))
    assert len(calls) == 6
