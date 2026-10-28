from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert

from backend.core.gamification import level_progress, xp_for_rule
from backend.database.db import AsyncSession
from backend.database.models import User, XpEvent


async def award_xp(session: AsyncSession, user_id: int, event_type: str, event_key: str) -> int:
    """Award XP once per (user, event_key). Returns XP granted (0 if already awarded).

    event_key identifies the source event, e.g. "meal:123" or "workout:2026-10-28".
    The unique constraint makes this safe under retries and concurrent requests.
    """
    amount = xp_for_rule(event_type)
    inserted = await session.scalar(
        insert(XpEvent)
        .values(user_id=user_id, event_type=event_type, event_key=event_key, xp=amount)
        .on_conflict_do_nothing(index_elements=["user_id", "event_key"])
        .returning(XpEvent.id)
    )
    if inserted is None:
        return 0
    new_xp = await session.scalar(
        update(User).where(User.id == user_id).values(xp=User.xp + amount).returning(User.xp)
    )
    await session.execute(update(User).where(User.id == user_id).values(level=level_progress(new_xp)["level"]))
    await session.commit()
    return amount
