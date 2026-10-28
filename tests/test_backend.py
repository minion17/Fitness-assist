import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlencode

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://fitness:fitness@localhost:5432/fitness_test")
os.environ["BOT_TOKEN"] = "123456:TEST-TOKEN"
os.environ["WEBAPP_URL"] = "https://example.test"

import pytest
from fastapi.testclient import TestClient

from backend.core.telegram_auth import InitDataError, validate_init_data

TOKEN = os.environ["BOT_TOKEN"]


def make_init_data(user: dict, token: str = TOKEN, auth_date: int | None = None) -> str:
    fields = {"auth_date": str(auth_date or int(time.time())), "query_id": "AAH", "user": json.dumps(user)}
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


USER = {"id": 777000111, "first_name": "Егор", "username": "egor", "language_code": "ru"}


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


@pytest.fixture(scope="module")
def client():
    from backend.api.main import app

    with TestClient(app) as c:
        yield c


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
    from backend.bot.main import open_app_keyboard

    btn = open_app_keyboard().inline_keyboard[0][0]
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
