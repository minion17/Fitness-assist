"""Exercise library extras: the exercise photos (from free-exercise-db, Unlicense) cached here, and the week's muscle load."""
import asyncio
import re
from datetime import timedelta
from io import BytesIO
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from PIL import Image
from sqlalchemy import select

from backend.api.deps import get_or_create_user, telegram_user
from backend.core import clock
from backend.database.db import AsyncSession, get_session
from backend.database.models import Exercise, WorkoutLog, WorkoutSet

router = APIRouter(prefix="/api")
SOURCE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/"
CACHE = Path(__file__).resolve().parents[2] / "cache" / "exercise-images"
NAME = re.compile(r"^[A-Za-z0-9_\-(),.']{1,90}$")
_slots = asyncio.Semaphore(4)  # a list of thumbnails must not hit GitHub with 40 requests at once
_locks: dict[str, asyncio.Lock] = {}  # one download per photo even if asked twice at once


@router.get("/exercise-image/{folder}/{n}.webp")
async def exercise_image(folder: str, n: int):
    """The photo once from GitHub, then from disk: smaller WebP, the phone keeps it for a year. No sign-in: plain <img>."""
    if not NAME.match(folder) or n not in (0, 1):
        raise HTTPException(404, "Нет такого фото")
    path = CACHE / folder / f"{n}.webp"
    if not path.exists():
        lock = _locks.setdefault(f"{folder}/{n}", asyncio.Lock())
        async with lock, _slots:
            if not path.exists():
                try:
                    async with httpx.AsyncClient(timeout=15) as c:
                        r = await c.get(f"{SOURCE}{folder}/{n}.jpg")
                    r.raise_for_status()
                    img = Image.open(BytesIO(r.content)).convert("RGB")
                except (httpx.HTTPError, OSError):
                    raise HTTPException(404, "Фото недоступно") from None
                img.thumbnail((640, 640))
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")
                img.save(tmp, "WEBP", quality=72)
                tmp.replace(path)
        _locks.pop(f"{folder}/{n}", None)
    return Response(path.read_bytes(), media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/muscles/week")
async def muscles_week(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Sets per muscle over the last 7 days: a set counts 1 for the exercise's main muscles and ½ for the helpers."""
    user = await get_or_create_user(tg, session)
    since = clock.local_start(clock.today() - timedelta(days=6))
    rows = await session.execute(
        select(Exercise.primary_muscles, Exercise.secondary_muscles)
        .join(WorkoutSet, WorkoutSet.exercise_id == Exercise.id).join(WorkoutLog, WorkoutLog.id == WorkoutSet.workout_log_id)
        .where(WorkoutLog.user_id == user.id, WorkoutLog.started_at >= since))
    load: dict[str, float] = {}
    for primary, secondary in rows:
        for m in primary or []:
            load[m] = load.get(m, 0) + 1
        for m in secondary or []:
            load[m] = load.get(m, 0) + 0.5
    return {"days": 7, "sets": {m: round(v, 1) for m, v in sorted(load.items(), key=lambda x: -x[1])}}
