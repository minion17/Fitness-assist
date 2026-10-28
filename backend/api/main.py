from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text

from backend.core.config import settings
from backend.core.gamification import level_progress
from backend.core.telegram_auth import InitDataError, validate_init_data
from backend.database.db import AsyncSession, get_session, init_db
from backend.database.models import User


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Fitness Assistant API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/health")
async def health(session: AsyncSession = Depends(get_session)):
    try:
        await session.execute(text("SELECT 1"))
        db = "ok"
    except Exception as e:  # report, don't crash the probe
        db = f"error: {type(e).__name__}"
    return {"status": "ok" if db == "ok" else "degraded", "database": db}


@app.post("/api/auth")
async def auth(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Register or refresh the user from verified initData. Base for the upcoming profile flow."""
    user = await session.scalar(select(User).where(User.telegram_id == tg["id"]))
    if user is None:
        user = User(telegram_id=tg["id"])
        session.add(user)
    user.username = tg.get("username")
    user.first_name = tg.get("first_name")
    user.language_code = tg.get("language_code")
    await session.commit()
    await session.refresh(user)
    return {
        "id": user.id,
        "telegram_id": user.telegram_id,
        "first_name": user.first_name,
        "username": user.username,
        "progress": level_progress(user.xp),
    }


# Serve the built Mini App from the same origin, so one HTTPS tunnel covers UI + API.
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="webapp")
