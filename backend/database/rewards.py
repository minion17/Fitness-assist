from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from backend.core.gamification import BOOST, EVOLUTIONS, CAP_WINDOW_HOURS, NOT_BOOSTED, ROLLING_CAPS, level_progress, xp_for_rule
from backend.database.db import AsyncSession
from backend.database.models import User, UserAchievement, XpEvent


async def award_xp(session: AsyncSession, user_id: int, event_type: str, event_key: str, *, commit: bool = True) -> int:
    """Award XP once per (user, event_key). Returns XP granted (0 if already awarded).

    event_key identifies the source event, e.g. "meal:123" or "workout:2026-10-28".
    The unique constraint makes this safe under retries and concurrent requests.
    """
    amount = xp_for_rule(event_type)
    if event_type in ROLLING_CAPS and await session.scalar(
        select(func.count()).where(XpEvent.user_id == user_id, XpEvent.event_type == event_type,
                                   XpEvent.created_at > func.now() - timedelta(hours=CAP_WINDOW_HOURS))
    ) >= ROLLING_CAPS[event_type]:
        return 0
    if event_type not in NOT_BOOSTED and await session.scalar(
        select(User.id).where(User.id == user_id, User.boost_until > func.now())
    ):
        amount = round(amount * BOOST)
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
    if commit:
        await session.commit()
    return amount


async def sync_evolution(session: AsyncSession, user_id: int, code: str) -> dict:
    title, source, thresholds, hint, icon = EVOLUTIONS[code]
    await session.scalar(select(User.id).where(User.id == user_id).with_for_update())
    count = await session.scalar(select(func.count(XpEvent.id)).where(
        XpEvent.user_id == user_id, XpEvent.event_type == source))
    stage = sum(count >= target for target in thresholds)
    newest = None
    unseen = False
    for number in range(1, stage + 1):
        key = f"{code}:{number}"
        row = await session.scalar(insert(UserAchievement).values(user_id=user_id, code=key)
                                   .on_conflict_do_nothing().returning(UserAchievement.code))
        if row:
            await award_xp(session, user_id, "achievement", f"achievement:{key}", commit=False)
        badge = await session.get(UserAchievement, (user_id, key))
        newest = badge.unlocked_at.isoformat()
        unseen = unseen or not badge.seen
    return {"code": code, "title": title, "hint": hint, "icon": icon, "stage": stage,
            "target": thresholds[min(stage, len(thresholds)-1)], "progress": count,
            "unlocked_at": newest, "unseen": unseen, "stage_xp": xp_for_rule("achievement")}
