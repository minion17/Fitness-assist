"""Faster food logging: recent products, favourites, repeating a meal from another day."""
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import selectinload

from backend.api.daily import local_start
from backend.api.deps import get_or_create_user, telegram_user
from backend.database.db import AsyncSession, get_session
from backend.database.models import FavoriteProduct, FoodLog, Product
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")


def product_out(p: Product) -> dict:
    return {
        "id": p.id, "name": p.name, "brand": p.brand, "category": p.category,
        "kcal": p.kcal, "protein_g": p.protein_g, "fat_g": p.fat_g, "carbs_g": p.carbs_g,
    }


@router.get("/products/recent")
async def recent_products(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Products from the user's last entries, newest first, with the last portion size."""
    user = await get_or_create_user(tg, session)
    logs = await session.scalars(
        select(FoodLog).options(selectinload(FoodLog.product))
        .where(FoodLog.user_id == user.id).order_by(FoodLog.logged_at.desc()).limit(200)
    )
    seen: dict[int, dict] = {}
    for log in logs:
        if log.product_id not in seen:
            seen[log.product_id] = {**product_out(log.product), "last_amount_g": log.amount_g}
    return list(seen.values())[:20]


@router.get("/favorites")
async def list_favorites(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    rows = await session.scalars(
        select(FavoriteProduct).options(selectinload(FavoriteProduct.product))
        .where(FavoriteProduct.user_id == user.id).order_by(FavoriteProduct.created_at.desc())
    )
    return [product_out(f.product) for f in rows]


@router.put("/favorites/{product_id}")
async def add_favorite(product_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    product = await session.get(Product, product_id)
    if product is None or product.owner_user_id not in (None, user.id):
        raise HTTPException(404, "Продукт не найден")
    await session.execute(insert(FavoriteProduct).values(user_id=user.id, product_id=product_id).on_conflict_do_nothing())
    await session.commit()
    return {"ok": True}


@router.delete("/favorites/{product_id}")
async def remove_favorite(product_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    fav = await session.get(FavoriteProduct, (user.id, product_id))
    if fav:
        await session.delete(fav)
        await session.commit()
    return {"ok": True}


class CopyIn(BaseModel):
    from_day: date
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"]


@router.post("/food-logs/copy")
async def copy_meal(body: CopyIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Repeat a meal (e.g. yesterday's breakfast) into today."""
    user = await get_or_create_user(tg, session)
    today = date.today()
    if not (today - timedelta(days=30) <= body.from_day < today):
        raise HTTPException(422, "Можно повторить приём пищи только из последних 30 дней")
    start = local_start(body.from_day)
    src = (await session.scalars(
        select(FoodLog).where(
            FoodLog.user_id == user.id, FoodLog.meal_type == body.meal_type,
            FoodLog.logged_at >= start, FoodLog.logged_at < start + timedelta(days=1),
        ).order_by(FoodLog.logged_at)
    )).all()
    if not src:
        raise HTTPException(404, "В этот день такого приёма пищи нет")
    session.add_all(FoodLog(user_id=user.id, product_id=s.product_id, amount_g=s.amount_g, meal_type=s.meal_type) for s in src)
    await session.commit()
    xp = await award_xp(session, user.id, "meal_logged", f"meal:{today}:{body.meal_type}")
    return {"copied": len(src), "xp_awarded": xp}
