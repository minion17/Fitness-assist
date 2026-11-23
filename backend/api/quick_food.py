"""Faster food logging: recent products, favourites, repeating a meal from another day."""
from datetime import date, timedelta
from typing import Literal

import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, distinct, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import selectinload

from backend.api.daily import local_start
from backend.api.deps import get_or_create_user, telegram_user
from backend.core import off
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import BarcodeMiss, FavoriteProduct, FoodLog, Product, ProductCheck, User, UserBarcode
from backend.database.rewards import award_xp
from backend.api.social import notify

router = APIRouter(prefix="/api")
log = logging.getLogger(__name__)
BARCODE = re.compile(r"\d{8,14}")


# shortcut: drinks from Open Food Facts carry no density; by the name they count in ml at 1 g/ml (good to ±5%)
LIQUID = re.compile(r"молоко|кефир|ряженк|айран|тан\b|снежок|простокваш|напит|сок\b|нектар|морс|компот|квас|лимонад|"
                    r"вода\b|чай|кофе|капучино|латте|какао|пиво|вино|сидр|энергетик|кола|тоник|смузи|йогурт питьев|бульон")


def product_out(p: Product) -> dict:
    ml_g = p.ml_g or (1.0 if LIQUID.search(p.name.lower()) else None)
    return {
        "id": p.id, "name": p.name, "brand": p.brand, "category": p.category,
        "kcal": p.kcal, "protein_g": p.protein_g, "fat_g": p.fat_g, "carbs_g": p.carbs_g,
        "portion_g": p.portion_g, "portion_name": p.portion_name,
        "piece_g": p.piece_g, "piece_name": p.piece_name, "ml_g": ml_g, "tbsp_g": p.tbsp_g or (round(15 * ml_g, 1) if ml_g else None),
        "barcode": p.barcode, "unverified": bool(p.unverified),
    }


@router.get("/products/recent")
async def recent_products(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Products from the user's last entries, newest first, with the last portion size and how often each meal had it
    (the app puts this meal's usual products first: porridge at breakfast, soup at lunch)."""
    user = await get_or_create_user(tg, session)
    logs = await session.scalars(
        select(FoodLog).options(selectinload(FoodLog.product))
        .where(FoodLog.user_id == user.id).order_by(FoodLog.logged_at.desc()).limit(200)
    )
    seen: dict[int, dict] = {}
    for log in logs:
        if log.product_id not in seen:
            seen[log.product_id] = {**product_out(log.product), "last_amount_g": log.amount_g, "meals": {}}
        meals = seen[log.product_id]["meals"]
        meals[log.meal_type] = meals.get(log.meal_type, 0) + 1
    return list(seen.values())[:30]


LOCAL_CATALOG = 500  # the most eaten plain products: kept on the phone so search answers from the first letter
LOCAL_MINE = 300


@router.get("/products/local")
async def local_catalog(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """What the app keeps on the phone for instant search: what this user eats (and their own products) + the common
    plain products. The server search still runs after it and has the last word."""
    user = await get_or_create_user(tg, session)
    eaten = func.count(FoodLog.id)
    mine_ids = [pid for pid, _ in await session.execute(
        select(FoodLog.product_id, eaten).where(FoodLog.user_id == user.id).group_by(FoodLog.product_id).order_by(eaten.desc()).limit(LOCAL_MINE))]
    own = list(await session.scalars(select(Product.id).where(Product.owner_user_id == user.id).limit(LOCAL_MINE)))
    popular = (select(Product.id).outerjoin(FoodLog, FoodLog.product_id == Product.id)
               .where(Product.owner_user_id.is_(None), Product.brand.is_(None))
               .group_by(Product.id).order_by(eaten.desc(), func.length(Product.name)).limit(LOCAL_CATALOG))
    ids = list(dict.fromkeys([*mine_ids, *own, *await session.scalars(popular)]))
    rows = {p.id: p for p in await session.scalars(select(Product).where(Product.id.in_(ids or [0])))}
    mine = set(mine_ids) | set(own)
    return [{**product_out(rows[i]), "mine": i in mine} for i in ids if i in rows]


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
    to_day: date | None = None  # default today


@router.post("/food-logs/copy")
async def copy_meal(body: CopyIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Repeat a meal (e.g. yesterday's breakfast) into today or another recent day."""
    from backend.api.main import entry_time, meal_xp

    user = await get_or_create_user(tg, session)
    today = clock.today()
    if not (today - timedelta(days=30) <= body.from_day <= today) or body.from_day == (body.to_day or today):
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
    when, day = entry_time(body.to_day, body.meal_type, None)
    session.add_all(
        FoodLog(user_id=user.id, product_id=s.product_id, amount_g=s.amount_g, unit=s.unit, qty=s.qty, meal_type=s.meal_type,
                **{**when, "snack_slot": s.snack_slot})
        for s in src
    )
    await session.commit()
    xp = await meal_xp(session, user, day, body.meal_type)
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
    ) or await attached(session, code)
    if product:
        return product_out(product)
    try:
        found = await off.fetch(code)
    except httpx.HTTPError as e:
        log.warning("Open Food Facts lookup failed for %s: %s", code, e)
        raise HTTPException(503, "Не удалось проверить штрихкод — попробуй позже или добавь продукт вручную")
    if found is None:
        await session.execute(insert(BarcodeMiss).values(barcode=code).on_conflict_do_update(
            index_elements=["barcode"], set_={"scans": BarcodeMiss.scans + 1, "last_at": func.now()}))
        await session.commit()
        raise HTTPException(404, "Товар не найден — добавь его вручную, это займёт минуту")
    await session.execute(delete(BarcodeMiss).where(BarcodeMiss.barcode == code))
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
            raise HTTPException(409, "Не удалось сохранить товар, попробуй ещё раз")
    return product_out(product)


class ProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    brand: str | None = Field(default=None, max_length=100)  # brand or restaurant, e.g. "Додо"
    barcode: str | None = Field(default=None, pattern=r"^\d{8,14}$")  # scanned but unknown: remember it for this user
    kcal: float = Field(ge=0, le=900)
    protein_g: float = Field(ge=0, le=100)
    fat_g: float = Field(ge=0, le=100)
    carbs_g: float = Field(ge=0, le=100)
    portion_g: float | None = Field(default=None, gt=0, le=3000)
    portion_name: str | None = Field(default=None, max_length=40)
    piece_g: float | None = Field(default=None, gt=0, le=3000)  # one piece or the whole package
    piece_name: str | None = Field(default=None, max_length=20)
    ml_g: float | None = Field(default=None, gt=0.3, le=2)  # set for drinks: counted in ml


# A user's product joins the shared catalog once this many different people entered the same thing with the same
# numbers. Only branded items (brand/restaurant) or barcodes: "домашний сырник" differs from kitchen to kitchen.
CONFIRMATIONS = 3
# A barcode product is shown to everyone from its first author (marked "не проверен"); this many other people make it
# checked: by "Всё верно" or by entering the same numbers — or replace its numbers by agreeing on other ones.
VERIFY = 2
# A barcode tied to an existing catalog product ("Найти по названию") counts for everyone from this many people.
ATTACH_CONFIRMATIONS = 2


def plausible(p) -> bool:
    """The numbers add up: kcal ≈ 4·protein + 9·fat + 4·carbs (fibre, sugar alcohols and rounding allow a margin)."""
    est = 4 * p.protein_g + 9 * p.fat_g + 4 * p.carbs_g
    return abs(p.kcal - est) <= max(25, 0.2 * max(est, p.kcal))


async def attached(session: AsyncSession, code: str) -> Product | None:
    """A catalog product enough people tied this barcode to."""
    return await session.scalar(
        select(Product).join(UserBarcode, UserBarcode.product_id == Product.id)
        .where(UserBarcode.barcode == code, Product.owner_user_id.is_(None))
        .group_by(Product.id).having(func.count(distinct(UserBarcode.user_id)) >= ATTACH_CONFIRMATIONS)
        .order_by(func.count(distinct(UserBarcode.user_id)).desc()).limit(1))


async def review(session: AsyncSession, shared: Product) -> bool:
    """An unverified barcode product: checked once VERIFY other people confirmed it ("Всё верно" or the same numbers);
    corrected once VERIFY people agree on other numbers. XP to whoever's numbers stood. True if it's checked now."""
    peers = [p for p in await session.scalars(
        select(Product).join(UserBarcode, UserBarcode.product_id == Product.id)
        .where(UserBarcode.barcode == shared.barcode, Product.owner_user_id.is_not(None))) if p.owner_user_id != shared.added_by]
    checks = set(await session.scalars(select(ProductCheck.user_id).where(ProductCheck.product_id == shared.id)))
    agree = ({p.owner_user_id for p in peers if same_numbers(p, shared)} | checks) - {shared.added_by}
    winners: set[int] = set()
    if len(agree) >= VERIFY:
        winners = {shared.added_by} if shared.added_by else set()
    else:
        for cand in peers:
            group = [q for q in peers if same_numbers(q, cand) and not same_numbers(q, shared)]
            if len({q.owner_user_id for q in group}) >= VERIFY:
                for k in ("kcal", "protein_g", "fat_g", "carbs_g"):
                    setattr(shared, k, round(sum(getattr(q, k) for q in group) / len(group), 1))
                winners = {q.owner_user_id for q in group}
                break
        else:
            return False
    shared.unverified, shared.category = False, "Проверено пользователями"
    await session.commit()
    for uid in winners:
        got = await award_xp(session, uid, "product_shared", f"product:{shared.id}")
        if got:
            notify(session, await session.get(User, uid),
                   f"🙌 «{shared.name}» проверили другие — цифры подтверждены, товар в общем каталоге Setly. +{got} XP, спасибо!")
    await session.commit()
    return True


def close(a: float, b: float, rel: float, floor: float) -> bool:
    return abs(a - b) <= max(floor, rel * max(a, b))


def same_numbers(a: Product, b: Product) -> bool:
    return close(a.kcal, b.kcal, 0.05, 5) and all(
        close(getattr(a, k), getattr(b, k), 0.1, 1) for k in ("protein_g", "fat_g", "carbs_g")
    )


async def promote(session: AsyncSession, product: Product, barcode: str | None) -> tuple[Product, set[int]] | None:
    """Copy `product` to the shared catalog if enough other users confirmed it.
    Returns (the shared product, ids of the users whose entries agreed) if created."""
    if barcode:
        if await session.scalar(select(Product.id).where(Product.barcode == barcode)):
            return None
        peers = await session.scalars(
            select(Product).join(UserBarcode, UserBarcode.product_id == Product.id).where(UserBarcode.barcode == barcode)
        )
    elif product.brand:
        if await session.scalar(select(Product.id).where(
            Product.owner_user_id.is_(None), Product.name == product.name, Product.brand == product.brand
        )):
            return None
        peers = await session.scalars(
            select(Product).where(Product.owner_user_id.is_not(None), Product.search_text == product.search_text)
        )
    else:
        return None
    agree = [p for p in peers if same_numbers(p, product)]
    if len({p.owner_user_id for p in agree}) < CONFIRMATIONS:
        return None
    avg = {k: round(sum(getattr(p, k) for p in agree) / len(agree), 1) for k in ("kcal", "protein_g", "fat_g", "carbs_g")}
    shared = Product(name=product.name, brand=product.brand, barcode=barcode, category="Проверено пользователями",
                     portion_g=product.portion_g, portion_name=product.portion_name, piece_g=product.piece_g,
                     piece_name=product.piece_name, ml_g=product.ml_g, **avg)
    session.add(shared)
    await session.flush()
    return shared, {p.owner_user_id for p in agree}


@router.post("/products")
async def create_product(body: ProductIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """A custom product, visible only to its author (values per 100 g). Same name+brand again updates it."""
    user = await get_or_create_user(tg, session)
    if body.protein_g + body.fat_g + body.carbs_g > 100:
        raise HTTPException(422, "Белков, жиров и углеводов вместе не может быть больше 100 г на 100 г")
    data = {**body.model_dump(exclude={"barcode"}), "name": body.name.strip(), "brand": (body.brand or "").strip() or None}
    product = await session.scalar(select(Product).where(
        Product.owner_user_id == user.id, Product.name == data["name"], Product.brand.is_not_distinct_from(data["brand"])
    ))
    if product:
        for k, v in data.items():
            setattr(product, k, v)
    else:
        product = Product(owner_user_id=user.id, category="Мои продукты", **data)
        session.add(product)
    await session.flush()
    if body.barcode:
        await session.execute(
            insert(UserBarcode).values(user_id=user.id, barcode=body.barcode, product_id=product.id)
            .on_conflict_do_update(index_elements=["user_id", "barcode"], set_={"product_id": product.id})
        )
    try:
        async with session.begin_nested():  # savepoint: a lost promotion race must not lose the user's product
            promoted = await promote(session, product, body.barcode)
    except IntegrityError:  # someone promoted it a moment ago
        promoted = None
    await session.commit()
    xp = 0
    if promoted:  # everyone who entered the same numbers helped: XP and a thank-you from the bot
        shared, authors = promoted
        for uid in authors:
            got = await award_xp(session, uid, "product_shared", f"product:{shared.id}")
            xp += got if uid == user.id else 0
            if got and uid != user.id:
                notify(session, await session.get(User, uid),
                       f"🙌 «{shared.name}» подтвердили другие — товар теперь в общем каталоге Setly. +{got} XP, спасибо!")
        await session.commit()
    published = False
    if body.barcode and not promoted:  # a barcode nobody has: everyone scanning it sees it from now on, marked
        existing = await session.scalar(select(Product).where(Product.barcode == body.barcode))
        if existing is None and plausible(product):
            try:
                async with session.begin_nested():
                    session.add(Product(
                        name=product.name, brand=product.brand, barcode=body.barcode, category="Добавлено пользователями",
                        unverified=True, added_by=user.id, kcal=product.kcal, protein_g=product.protein_g, fat_g=product.fat_g,
                        carbs_g=product.carbs_g, portion_g=product.portion_g, portion_name=product.portion_name,
                        piece_g=product.piece_g, piece_name=product.piece_name, ml_g=product.ml_g))
                published = True
                await session.execute(delete(BarcodeMiss).where(BarcodeMiss.barcode == body.barcode))
            except IntegrityError:  # the same name+brand is in the catalog already: it stays this user's own
                pass
            await session.commit()
        elif existing is not None and existing.unverified:  # "Исправить" on an unverified product: maybe it settles it
            await review(session, existing)
    return {**product_out(product), "shared": promoted is not None, "published": published, "xp_awarded": xp}


@router.post("/products/{product_id}/confirm")
async def confirm_product(product_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """"Всё верно" on an unverified barcode product: compared with the package."""
    user = await get_or_create_user(tg, session)
    p = await session.get(Product, product_id)
    if p is None or p.owner_user_id is not None:
        raise HTTPException(404, "Товар не найден")
    if p.unverified:
        if p.added_by == user.id:
            raise HTTPException(409, "Это ты добавил товар — подтвердить его должны другие")
        await session.execute(insert(ProductCheck).values(product_id=p.id, user_id=user.id).on_conflict_do_nothing())
        await session.commit()
        await review(session, p)
        await session.refresh(p)
    return product_out(p)


class AttachIn(BaseModel):
    barcode: str = Field(pattern=r"^\d{8,14}$")


@router.post("/products/{product_id}/barcode")
async def attach_barcode(product_id: int, body: AttachIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """"Найти по названию": an unknown barcode tied to a product already in the catalog (or the user's own). At once
    for this user; for everyone once ATTACH_CONFIRMATIONS people tied it to the same product."""
    user = await get_or_create_user(tg, session)
    p = await session.get(Product, product_id)
    if p is None or p.owner_user_id not in (None, user.id):
        raise HTTPException(404, "Товар не найден")
    if await session.scalar(select(Product.id).where(Product.barcode == body.barcode, Product.id != p.id)):
        raise HTTPException(409, "У этого штрихкода уже есть товар — отсканируй ещё раз")
    await session.execute(insert(UserBarcode).values(user_id=user.id, barcode=body.barcode, product_id=p.id)
                          .on_conflict_do_update(index_elements=["user_id", "barcode"], set_={"product_id": p.id}))
    await session.commit()
    if await attached(session, body.barcode):
        await session.execute(delete(BarcodeMiss).where(BarcodeMiss.barcode == body.barcode))
        await session.commit()
    return product_out(p)
