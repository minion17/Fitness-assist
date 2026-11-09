"""Shared request dependencies."""
from fastapi import Header, HTTPException
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from backend.core import clock
from backend.core.config import settings
from backend.core.telegram_auth import InitDataError, validate_init_data
from backend.database.db import AsyncSession
from backend.database.models import User, Visit


def telegram_user(authorization: str = Header(default=""), x_timezone: str = Header(default="")) -> dict:
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
    return {**data["user"], "tz": x_timezone}  # the phone's zone (unverified, only used if it is a real zone name)


def optional_telegram_user(authorization: str = Header(default="")) -> dict | None:
    """Like telegram_user, but anonymous requests are allowed (public endpoints)."""
    return telegram_user(authorization, "") if authorization else None


async def get_or_create_user(tg: dict, session: AsyncSession) -> User:
    user = await session.scalar(select(User).where(User.telegram_id == tg["id"]))
    if user is None:
        user = User(telegram_id=tg["id"])
        session.add(user)
    user.username = tg.get("username")
    user.first_name = tg.get("first_name")
    user.language_code = tg.get("language_code")
    if clock.valid(tg.get("tz")):
        user.device_tz = tg["tz"]
    await session.flush()  # a new user needs its id for the visit
    await session.execute(insert(Visit).values(user_id=user.id, day=datetime.now(timezone.utc).date()).on_conflict_do_nothing())
    await session.commit()
    await session.refresh(user)
    clock.use_tz(user.device_tz)  # this request's "today" is the user's
    return user
