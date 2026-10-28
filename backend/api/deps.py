"""Shared request dependencies."""
from fastapi import Header, HTTPException
from sqlalchemy import select

from backend.core.config import settings
from backend.core.telegram_auth import InitDataError, validate_init_data
from backend.database.db import AsyncSession
from backend.database.models import User


def telegram_user(authorization: str = Header(default="")) -> dict:
    """Mini App sends `Authorization: tma <initData>`."""
    scheme, _, init_data = authorization.partition(" ")
    if scheme.lower() != "tma":
        raise HTTPException(401, "missing Telegram initData")
    try:
        data = validate_init_data(init_data, settings.bot_token, settings.init_data_max_age)
    except InitDataError as e:
        raise HTTPException(401, f"invalid initData: {e}")
    if "user" not in data:
        raise HTTPException(401, "no user in initData")
    return data["user"]


def optional_telegram_user(authorization: str = Header(default="")) -> dict | None:
    """Like telegram_user, but anonymous requests are allowed (public endpoints)."""
    return telegram_user(authorization) if authorization else None


async def get_or_create_user(tg: dict, session: AsyncSession) -> User:
    user = await session.scalar(select(User).where(User.telegram_id == tg["id"]))
    if user is None:
        user = User(telegram_id=tg["id"])
        session.add(user)
    user.username = tg.get("username")
    user.first_name = tg.get("first_name")
    user.language_code = tg.get("language_code")
    await session.commit()
    await session.refresh(user)
    return user
