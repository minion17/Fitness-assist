"""Faster food logging: recent products, favourites, repeating a meal from another day."""
from datetime import date, timedelta
from typing import Literal

import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import selectinload

from backend.api.daily import local_start
from backend.api.deps import get_or_create_user, telegram_user
from backend.core import off
from backend.database.db import AsyncSession, get_session
from backend.database.models import FavoriteProduct, FoodLog, Product, UserBarcode
from backend.database.rewards import award_xp

router = APIRouter(prefix="/api")
log = logging.getLogger(__name__)
BARCODE = re.compile(r"\d{8,14}")


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
    session.add_all(
        FoodLog(user_id=user.id, product_id=s.product_id, amount_g=s.amount_g, meal_type=s.meal_type, snack_slot=s.snack_slot)
        for s in src
    )
    await session.commit()
    xp = await award_xp(session, user.id, "meal_logged", f"meal:{today}:{body.meal_type}")
    return {"copied": len(src), "xp_awarded": xp}


@router.get("/products/barcode/{code}")
async def product_by_barcode(code: str, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Our catalog first; otherwise Open Food Facts, and the found product is saved to the shared catalog."""
    if not BARCODE.fullmatch(code):
        raise HTTPException(422, "Штрихкод — это 8–14 цифр")
    if len(code) == 14 and code.startswith("0"):
        code = code[1:]  # GTIN-14 with a leading zero is the same product as its EAN-13
    user = await get_or_create_user(tg, session)
    product = await session.scalar(select(Product).where(Product.barcode == code)) or await session.scalar(
        select(Product).join(UserBarcode, UserBarcode.product_id == Product.id)
        .where(UserBarcode.user_id == user.id, UserBarcode.barcode == code)
    )
    if product:
        return product_out(product)
    try:
        found = await off.fetch(code)
    except httpx.HTTPError as e:
        log.warning("Open Food Facts lookup failed for %s: %s", code, e)
        raise HTTPException(503, "Не удалось проверить штрихкод — попробуйте позже или добавьте продукт вручную")
    if found is None:
        raise HTTPException(404, "Товар не найден — добавьте его вручную, это займёт минуту")
    product = Product(barcode=code, category="Из штрихкода", **found)
    session.add(product)
    try:
        await session.commit()
    except IntegrityError:  # someone saved it a moment ago, or same name+brand already in the catalog
        await session.rollback()
        product = await session.scalar(select(Product).where(Product.barcode == code)) or await session.scalar(
            select(Product).where(Product.owner_user_id.is_(None), Product.name == found["name"], Product.brand == found["brand"])
        )
        if product is None:
            raise HTTPException(409, "Не удалось сохранить товар, попробуйте ещё раз")
    return product_out(product)


class ProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    barcode: str | None = Field(default=None, pattern=r"^\d{8,14}$")  # scanned but unknown: remember it for this user
    kcal: float = Field(ge=0, le=900)
    protein_g: float = Field(ge=0, le=100)
    fat_g: float = Field(ge=0, le=100)
    carbs_g: float = Field(ge=0, le=100)


@router.post("/products")
async def create_product(body: ProductIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """A custom product, visible only to its author (values per 100 g)."""
    user = await get_or_create_user(tg, session)
    if body.protein_g + body.fat_g + body.carbs_g > 100:
        raise HTTPException(422, "Белков, жиров и углеводов вместе не может быть больше 100 г на 100 г")
    product = Product(owner_user_id=user.id, category="Мои продукты", **{**body.model_dump(exclude={"barcode"}), "name": body.name.strip()})
    session.add(product)
    await session.flush()
    if body.barcode:
        await session.execute(
            insert(UserBarcode).values(user_id=user.id, barcode=body.barcode, product_id=product.id)
            .on_conflict_do_update(index_elements=["user_id", "barcode"], set_={"product_id": product.id})
        )
    await session.commit()
    return product_out(product)
