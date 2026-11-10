"""Consent to data processing (152-ФЗ) and deleting the account with all its data."""
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy import delete, update

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import Profile, User

router = APIRouter(prefix="/api")


class ConsentIn(BaseModel):
    health: bool  # the separate, optional consent to allergies and injuries


@router.post("/consent")
async def consent(body: ConsentIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Give consent, or change the health part later. Taking the health consent back erases those answers."""
    user = await get_or_create_user(tg, session)
    now = clock.now()
    user.consent_at = user.consent_at or now
    user.health_consent_at = (user.health_consent_at or now) if body.health else None
    if not body.health:
        await session.execute(update(Profile).where(Profile.user_id == user.id).values(allergies=None, injury=None))
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

