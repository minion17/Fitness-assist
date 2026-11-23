"""Your data and your voice: a full export of the diary (CSV in a zip, sent by the bot) and a way to write to the team
(ideas, bugs, a product with wrong numbers). Competitors' reviews complain about both: no export, unreachable support."""
import csv
import io
import zipfile
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import alerts, clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import (
    BodyMeasurement, Exercise, Feedback, FoodLog, Outbox, Product, User, WaterIntake, WorkoutLog, WorkoutSet,
)

router = APIRouter(prefix="/api")
MEALS_RU = {"breakfast": "завтрак", "lunch": "обед", "dinner": "ужин", "snack": "перекус"}


def _csv(head: list[str], rows: list[list]) -> bytes:
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")  # ";" opens in Russian Excel without an import wizard
    w.writerow(head)
    w.writerows(rows)
    return ("﻿" + out.getvalue()).encode("utf-8")  # BOM: Excel reads it as UTF-8


async def build_export(session: AsyncSession, user: User) -> bytes:
    """All of the user's records as CSV files in one zip. Times in the user's zone (call with it set)."""
    r1 = lambda x: round(x, 1)  # noqa: E731
    food = list(await session.scalars(select(FoodLog).options(selectinload(FoodLog.product))
                                      .where(FoodLog.user_id == user.id).order_by(FoodLog.logged_at)))
    food_rows = [[clock.local(f.logged_at).strftime("%Y-%m-%d %H:%M"), MEALS_RU.get(f.meal_type, f.meal_type), f.product.name,
                  f.product.brand or "", r1(f.amount_g), r1(f.product.kcal * f.amount_g / 100), r1(f.product.protein_g * f.amount_g / 100),
                  r1(f.product.fat_g * f.amount_g / 100), r1(f.product.carbs_g * f.amount_g / 100)] for f in food]
    body = list(await session.scalars(select(BodyMeasurement).where(BodyMeasurement.user_id == user.id).order_by(BodyMeasurement.measured_on)))
    body_rows = [[m.measured_on.isoformat(), m.weight_kg or "", m.waist_cm or "", m.chest_cm or "", m.hips_cm or "", m.body_fat_pct or ""] for m in body]
    water = list(await session.scalars(select(WaterIntake).where(WaterIntake.user_id == user.id).order_by(WaterIntake.day)))
    sets = (await session.execute(
        select(WorkoutLog, WorkoutSet, Exercise.name).join(WorkoutSet, WorkoutSet.workout_log_id == WorkoutLog.id)
        .join(Exercise, Exercise.id == WorkoutSet.exercise_id).where(WorkoutLog.user_id == user.id)
        .order_by(WorkoutLog.started_at, WorkoutSet.id))).all()
    set_rows = [[clock.local(w.started_at).strftime("%Y-%m-%d %H:%M"), w.title, name, s.set_number, s.reps or "",
                 s.duration_seconds or "", s.weight_kg] for w, s, name in sets]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("питание.csv", _csv(["Время", "Приём", "Продукт", "Бренд", "Граммы", "Ккал", "Белки", "Жиры", "Углеводы"], food_rows))
        z.writestr("вес_и_замеры.csv", _csv(["Дата", "Вес, кг", "Талия, см", "Грудь, см", "Бёдра, см", "% жира"], body_rows))
        z.writestr("вода.csv", _csv(["Дата", "Мл"], [[w.day.isoformat(), w.ml] for w in water]))
        z.writestr("тренировки.csv", _csv(["Начало", "Тренировка", "Упражнение", "Подход", "Повторы", "Секунды", "Вес, кг"], set_rows))
    return buf.getvalue()


@router.post("/export")
async def order_export(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """The bot builds the file and sends it to the chat (a Mini App can't save files on every phone)."""
    user = await get_or_create_user(tg, session)
    recent = await session.scalar(select(func.count()).where(
        Outbox.telegram_id == user.telegram_id, Outbox.kind == "export", Outbox.created_at > func.now() - timedelta(minutes=2)))
    if recent:
        raise HTTPException(429, "Файл уже готовится — загляни в чат с ботом")
    session.add(Outbox(telegram_id=user.telegram_id, kind="export", text="", user_id=user.id))
    await session.commit()
    return {"ok": True}


class FeedbackIn(BaseModel):
    kind: str = Field(pattern="^(idea|bug|product)$")
    text: str = Field(min_length=3, max_length=2000)
    product_id: int | None = None


KIND_RU = {"idea": "💡 Идея", "bug": "🐞 Ошибка", "product": "🥫 Неверный продукт"}
DAILY_LIMIT = 10


@router.post("/feedback")
async def send_feedback(body: FeedbackIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    today = await session.scalar(select(func.count()).where(Feedback.user_id == user.id, Feedback.created_at > func.now() - timedelta(days=1)))
    if today >= DAILY_LIMIT:
        raise HTTPException(429, "Сегодня ты уже много написал — спасибо! Продолжим завтра")
    product = await session.get(Product, body.product_id) if body.product_id else None
    session.add(Feedback(user_id=user.id, kind=body.kind, text=body.text.strip(), product_id=product.id if product else None))
    who = f"@{user.username}" if user.username else (user.first_name or f"id {user.telegram_id}")
    about = f"\nПродукт: {product.name}{f' ({product.brand})' if product.brand else ''} · id {product.id}" if product else ""
    for admin in alerts.admin_ids():  # the team sees it in the chat at once
        session.add(Outbox(telegram_id=admin, kind="alert", text=f"{KIND_RU[body.kind]} от {who}{about}\n\n{body.text.strip()}"[:3500]))
    await session.commit()
    return {"ok": True}
