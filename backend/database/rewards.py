from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from backend.core.gamification import (BOOST, BOOST_HOURS, BOOST_MAX_BONUS, CAP_WINDOW_HOURS, EVOLUTIONS, NOT_BOOSTED, ROLLING_CAPS,
                                       level_progress, xp_for_rule)
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
    inserted = await session.scalar(
        insert(XpEvent)
        .values(user_id=user_id, event_type=event_type, event_key=event_key, xp=amount)
        .on_conflict_do_nothing(index_elements=["user_id", "event_key"])
        .returning(XpEvent.id)
    )
    if inserted is None:
        return 0
    boost_until = event_type not in NOT_BOOSTED and await session.scalar(
        select(User.boost_until).where(User.id == user_id, User.boost_until > func.now()))
    if boost_until:  # the duel boost: its own "boost_bonus" rows, BOOST_MAX_BONUS in all per boost
        given = await session.scalar(select(func.coalesce(func.sum(XpEvent.xp), 0)).where(
            XpEvent.user_id == user_id, XpEvent.event_type == "boost_bonus", XpEvent.created_at > boost_until - timedelta(hours=BOOST_HOURS)))
        bonus = min(round(amount * (BOOST - 1)), BOOST_MAX_BONUS - given)
        if bonus > 0:
            session.add(XpEvent(user_id=user_id, event_type="boost_bonus", event_key=f"boost:{event_key}", xp=bonus))
            amount += bonus
    new_xp = await session.scalar(
        update(User).where(User.id == user_id).values(xp=User.xp + amount).returning(User.xp)
    )
    await session.execute(update(User).where(User.id == user_id).values(level=level_progress(new_xp)["level"]))
    if commit:
        await session.commit()
    return amount


async def revoke_xp(session: AsyncSession, user_id: int, event_key: str, *, commit: bool = True) -> int:
    """Take back an award whose reason is gone (the meal deleted, the water undone): log-and-delete must not pay.
    Returns the XP taken back (0 if there was none)."""
    from sqlalchemy import delete

    xp = sum(await session.scalars(delete(XpEvent).where(XpEvent.user_id == user_id, XpEvent.event_key.in_((event_key, f"boost:{event_key}")))
                                   .returning(XpEvent.xp)))
    if xp:
        new_xp = await session.scalar(update(User).where(User.id == user_id).values(xp=func.greatest(0, User.xp - xp)).returning(User.xp))
        await session.execute(update(User).where(User.id == user_id).values(level=level_progress(new_xp)["level"]))
    if commit:
        await session.commit()
    return xp or 0


MIN_MEAL_KCAL = 50  # a meal worth XP: not "1 g of cucumber"


async def settle_meal_xp(session: AsyncSession, user_id: int, day, meal_type: str) -> int:
    """XP for a meal follows what's in it: awarded once it has MIN_MEAL_KCAL (today or yesterday — a forgotten dinner
    counts, older back-fills don't), taken back if it's emptied. Call after any add / delete / move / edit."""
    from datetime import timedelta

    from backend.core import clock
    from backend.database.models import FoodLog, Product

    key = f"meal:{day}:{meal_type}"
    start = clock.local_start(day)
    kcal = await session.scalar(select(func.coalesce(func.sum(FoodLog.amount_g * Product.kcal / 100), 0))
                                .join(Product, Product.id == FoodLog.product_id)
                                .where(FoodLog.user_id == user_id, FoodLog.meal_type == meal_type,
                                       FoodLog.logged_at >= start, FoodLog.logged_at < start + timedelta(days=1)))
    if kcal >= MIN_MEAL_KCAL and day >= clock.today() - timedelta(days=1):
        return await award_xp(session, user_id, "meal_logged", key)
    if kcal < MIN_MEAL_KCAL:
        await revoke_xp(session, user_id, key)
    return 0


async def sync_evolution(session: AsyncSession, user_id: int, code: str) -> dict:
    title, source, thresholds, hint, icon = EVOLUTIONS[code]
    await session.scalar(select(User.id).where(User.id == user_id).with_for_update())
    count = await session.scalar(select(func.count(XpEvent.id)).where(
        XpEvent.user_id == user_id, XpEvent.event_type == source))
    stage = sum(count >= target for target in thresholds)
    quotes = {"iron_will": "Каждая тренировка — шаг вперёд.", "like_water": "Маленькие привычки складываются в большой результат.", "personal_best": "Сравнивай себя только с собой вчерашним.", "food_habits": "Постоянство важнее идеального дня."}
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
            "unlocked_at": newest, "unseen": unseen, "quote": quotes[code], "stage_xp": xp_for_rule("achievement")}
