"""Shared test setup: env, signed initData, one app client for the whole run (DB pool is bound to its loop)."""
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

TOKEN = os.environ["BOT_TOKEN"]


def make_init_data(user: dict, token: str = TOKEN, auth_date: int | None = None) -> str:
    fields = {"auth_date": str(auth_date or int(time.time())), "query_id": "AAH", "user": json.dumps(user)}
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


USER = {"id": 777000111, "first_name": "Егор", "username": "egor", "language_code": "ru"}


@pytest.fixture(scope="session")
def client():
    from backend.api.main import app

    with TestClient(app) as c:
        yield c


PROFILE = {"sex": "male", "birth_year": 1998, "height_cm": 182, "weight_kg": 78.4, "activity": "moderate", "goal": "lose"}


def new_user_headers():
    import random

    return {"Authorization": f"tma {make_init_data({**USER, 'id': random.randint(3 * 10**9, 4 * 10**9)})}"}


@pytest.fixture(scope="session")
def seeded(client):
    from backend.database.db import SessionLocal
    from backend.database.models import Product
    from backend.seed.import_data import run

    async def seed():
        first = await run()
        second = await run()
        async with SessionLocal() as s:
            for name, kcal in [("Тестовый творог 5%", 121), ("Тестовый творог обезжиренный", 71)]:
                from sqlalchemy import select

                if not await s.scalar(select(Product.id).where(Product.name == name)):
                    s.add(Product(name=name, brand="Тест", kcal=kcal, protein_g=17, fat_g=5, carbs_g=3))
            await s.commit()
        return first, second

    return client.portal.call(seed)
