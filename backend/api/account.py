"""Consent to data processing (152-ФЗ) and deleting the account with all its data."""
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import delete, select, update

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import clock
from backend.core.config import settings
from backend.database.db import AsyncSession, get_session
from backend.database.models import MealPreferences, Profile, SavedMealPlan, User

router = APIRouter(prefix="/api")


class ConsentIn(BaseModel):
    health: bool  # the separate, optional consent to allergies and injuries


@router.post("/consent")
async def consent(body: ConsentIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Give consent, or change the health part later. Taking the health consent back erases those answers."""
    user = await get_or_create_user(tg, session)
    user = await session.scalar(select(User).where(User.id == user.id).with_for_update().execution_options(populate_existing=True))
    now = clock.now()
    user.consent_at = user.consent_at or now
    user.health_consent_at = (user.health_consent_at or now) if body.health else None
    if not body.health:
        await session.execute(update(Profile).where(Profile.user_id == user.id).values(allergies=None, injury=None))
        await session.execute(delete(SavedMealPlan).where(SavedMealPlan.user_id == user.id))
        await session.execute(update(MealPreferences).where(MealPreferences.user_id == user.id).values(allergies=""))
    await session.commit()
    return {"consent": True, "health_consent": body.health}


async def delete_account(session: AsyncSession, telegram_id: int) -> bool:
    """Everything of the user goes with the row (ON DELETE CASCADE); backups age out in 14 days. False if none."""
    gone = await session.scalar(delete(User).where(User.telegram_id == telegram_id).returning(User.id))
    await session.commit()
    return gone is not None


@router.delete("/account", status_code=204)
async def delete_me(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    await delete_account(session, tg["id"])
    return Response(status_code=204)



# ---- the user's Telegram avatar: the Mini App rarely gets photo_url, so the bot fetches it (respects their privacy settings) ----
PHOTO_TTL = 6 * 3600
_photos: dict[int, tuple[float, bytes | None]] = {}  # shortcut: per-process cache, fine for one server; cap below keeps it small


async def fetch_photo(user_id: int) -> bytes | None:
    api = f"https://api.telegram.org/bot{settings.bot_token}"
    async with httpx.AsyncClient(timeout=10) as c:
        photos = (await c.get(f"{api}/getUserProfilePhotos", params={"user_id": user_id, "limit": 1})).json().get("result", {}).get("photos", [])
        if not photos:
            return None
        sizes = photos[0]
        size = next((s for s in sizes if s.get("width", 0) >= 300), sizes[-1])  # ~320 px: sharp at 64 px on a 3x screen
        path = (await c.get(f"{api}/getFile", params={"file_id": size["file_id"]})).json()["result"]["file_path"]
        r = await c.get(f"https://api.telegram.org/file/bot{settings.bot_token}/{path}")
        r.raise_for_status()
        return r.content


@router.get("/me/photo")
async def my_photo(tg: dict = Depends(telegram_user)):
    uid = int(tg["id"])
    hit = _photos.get(uid)
    if not hit or time.time() - hit[0] > PHOTO_TTL:
        try:
            img = await fetch_photo(uid)
        except (httpx.HTTPError, KeyError, ValueError):
            img = hit[1] if hit else None  # Telegram unreachable: keep the old one, try again later
        if len(_photos) > 5000:
            _photos.clear()
        hit = (time.time(), img)
        _photos[uid] = hit
    if not hit[1]:
        raise HTTPException(404, "Нет фото профиля")
    return Response(hit[1], media_type="image/jpeg", headers={"Cache-Control": "private, max-age=21600"})
