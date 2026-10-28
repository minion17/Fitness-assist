"""AI endpoints with the model faked out: we test our logic around it, not Claude."""
import pytest

from conftest import PROFILE, new_user_headers


@pytest.fixture
def fake_ai(monkeypatch):
    from backend.core import ai
    from backend.core.config import settings

    calls = {"tool": [], "text": []}
    replies = {"tool": {"items": []}, "text": "Итог: всё хорошо. Совет: пейте воду."}

    async def call_tool(system, content, tool, max_tokens=2000):
        calls["tool"].append(content)
        return replies["tool"]

    async def call_text(system, content, max_tokens=700):
        calls["text"].append(content)
        return replies["text"]

    monkeypatch.setattr(ai, "call_tool", call_tool)
    monkeypatch.setattr(ai, "call_text", call_text)
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    monkeypatch.setattr(settings, "ai_daily_limit", 30)
    return calls, replies


def test_ai_disabled_without_key(client, monkeypatch):
    from backend.core.config import settings

    monkeypatch.setattr(settings, "anthropic_api_key", "")
    h = new_user_headers()
    assert client.post("/api/ai/meal/text", headers=h, json={"text": "яблоко"}).status_code == 503
    assert client.get("/api/ai/status", headers=h).json() == {"enabled": False, "used_today": 0, "daily_limit": settings.ai_daily_limit}


def test_meal_text_draft_trusts_catalog_and_clamps_estimates(client, seeded, fake_ai):
    calls, replies = fake_ai
    h = new_user_headers()
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    replies["tool"] = {"meal_type": "lunch", "note": "", "items": [
        {"catalog_id": pid, "name": "творог", "grams": 200, "kcal_100g": 999, "protein_100g": 1, "fat_100g": 1, "carbs_100g": 1},
        {"catalog_id": None, "name": "Плов домашний", "grams": 300, "kcal_100g": 5000, "protein_100g": 7, "fat_100g": 9, "carbs_100g": 25},
        {"catalog_id": 10**9, "name": "Непонятное", "grams": 50, "kcal_100g": 100, "protein_100g": 1, "fat_100g": 1, "carbs_100g": 1},
        {"catalog_id": None, "name": "Пустое", "grams": 0, "kcal_100g": 1, "protein_100g": 0, "fat_100g": 0, "carbs_100g": 0},
    ]}
    draft = client.post("/api/ai/meal/text", headers=h, json={"text": "творог и плов"}).json()

    assert "Тестовый творог 5%" in calls["tool"][0][0]["text"]  # catalog is sent to the model
    assert draft["meal_type"] == "lunch"
    cottage, plov, unknown = draft["items"]  # zero-gram item dropped
    assert (cottage["product_id"], cottage["kcal_100g"], cottage["from_catalog"]) == (pid, 121, True)  # DB beats the model
    assert (plov["product_id"], plov["kcal_100g"]) == (None, 900)  # absurd estimate clamped
    assert unknown["product_id"] is None  # id not in catalog -> treated as unknown


def test_confirm_creates_private_products_and_xp(client, seeded, fake_ai):
    h, other = new_user_headers(), new_user_headers()
    item = {"product_id": None, "name": "Плов домашний", "grams": 300, "kcal_100g": 180, "protein_100g": 7, "fat_100g": 9, "carbs_100g": 20}

    r1 = client.post("/api/ai/meal/confirm", headers=h, json={"meal_type": "dinner", "items": [item]}).json()
    assert r1 == {"added": 1, "xp_awarded": 10}
    r2 = client.post("/api/ai/meal/confirm", headers=h, json={"meal_type": "dinner", "items": [{**item, "kcal_100g": 170}]}).json()
    assert r2["xp_awarded"] == 0  # same meal type today

    mine = client.get("/api/products/search", headers=h, params={"q": "плов домашний"}).json()
    assert len(mine) == 1 and mine[0]["kcal"] == 170  # reused, latest numbers kept
    assert client.get("/api/products/search", headers=other, params={"q": "плов домашний"}).json() == []
    assert client.get("/api/products/search", params={"q": "плов домашний"}).json() == []

    day = client.get("/api/food-logs", headers=h).json()
    assert [i["kcal"] for i in day["items"]] == [510, 510]  # 170 * 3; both entries point to the same product

    stolen = {**item, "product_id": mine[0]["id"]}
    assert client.post("/api/ai/meal/confirm", headers=other, json={"meal_type": "lunch", "items": [stolen]}).status_code == 404
    assert client.post("/api/food-logs", headers=other, json={"product_id": mine[0]["id"], "amount_g": 100, "meal_type": "lunch"}).status_code == 404
    assert client.post("/api/ai/meal/confirm", headers=h, json={"meal_type": "dinner", "items": [{**item, "grams": 0}]}).status_code == 422


def test_meal_photo(client, seeded, fake_ai):
    calls, _ = fake_ai
    h = new_user_headers()
    bad = client.post("/api/ai/meal/photo", headers=h, files={"file": ("a.txt", b"hello", "text/plain")})
    assert bad.status_code == 415
    ok = client.post("/api/ai/meal/photo", headers=h, files={"file": ("plate.jpg", b"\xff\xd8\xff fake jpeg", "image/jpeg")})
    assert ok.status_code == 200
    image = calls["tool"][-1][1]
    assert image["type"] == "image" and image["source"]["media_type"] == "image/jpeg"


def test_daily_limit(client, seeded, fake_ai, monkeypatch):
    from backend.core.config import settings

    monkeypatch.setattr(settings, "ai_daily_limit", 2)
    h = new_user_headers()
    for _ in range(2):
        assert client.post("/api/ai/meal/text", headers=h, json={"text": "яблоко"}).status_code == 200
    assert client.post("/api/ai/meal/text", headers=h, json={"text": "яблоко"}).status_code == 429
    assert client.get("/api/ai/status", headers=h).json()["used_today"] == 2


def test_summary_cached_and_uses_real_data(client, seeded, fake_ai):
    calls, replies = fake_ai
    h = new_user_headers()
    client.put("/api/profile", headers=h, json=PROFILE)
    pid = client.get("/api/products/search", params={"q": "тестовый творог 5%"}).json()[0]["id"]
    client.post("/api/food-logs", headers=h, json={"product_id": pid, "amount_g": 200, "meal_type": "breakfast"})

    first = client.get("/api/ai/summary", headers=h, params={"period": "day"}).json()
    assert first["cached"] is False and first["text"].startswith("Итог")
    data = calls["text"][-1][0]["text"]
    assert "242 ккал" in data and "Тестовый творог 5% 200 г" in data and "Норма в день" in data

    second = client.get("/api/ai/summary", headers=h, params={"period": "day"}).json()
    assert second["cached"] is True and len(calls["text"]) == 1  # no second paid call

    replies["text"] = "Новый итог"
    third = client.get("/api/ai/summary", headers=h, params={"period": "day", "refresh": True}).json()
    assert third["text"] == "Новый итог" and len(calls["text"]) == 2

    week = client.get("/api/ai/summary", headers=h, params={"period": "week"}).json()
    assert week["cached"] is False and "Дней с записями питания: 1 из 7" in calls["text"][-1][0]["text"]
