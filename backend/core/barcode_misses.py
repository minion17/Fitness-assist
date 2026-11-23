"""Barcodes scanned and found nowhere (BarcodeMiss): asked again in Open Food Facts every week — new products get
added there all the time — and the most wanted of the rest go to the owner on Monday, to see the gaps in the base."""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert

from backend.core import alerts, off
from backend.database.db import SessionLocal
from backend.database.models import BarcodeMiss, Outbox, Product

log = logging.getLogger("barcode_misses")
STATE = Path(__file__).resolve().parents[2] / ".barcode_report"
RECHECK_AFTER = timedelta(days=7)
BATCH, PAUSE = 100, 1.5  # per run; OFF asks for gentle use
TOP = 15


async def recheck() -> int:
    """One pass over the misses not asked for a week. Returns how many were found this time."""
    async with SessionLocal() as s:
        codes = list(await s.scalars(select(BarcodeMiss.barcode).where(BarcodeMiss.checked_at < func.now() - RECHECK_AFTER)
                                     .order_by(BarcodeMiss.scans.desc()).limit(BATCH)))
    found = 0
    for code in codes:
        try:
            data = await off.fetch(code)
        except httpx.HTTPError:
            break  # OFF is down: the rest next time
        async with SessionLocal() as s:
            if data:
                await s.execute(insert(Product).values(barcode=code, category="Из штрихкода", **data).on_conflict_do_nothing())
                await s.execute(delete(BarcodeMiss).where(BarcodeMiss.barcode == code))
                found += 1
            else:
                await s.execute(update(BarcodeMiss).where(BarcodeMiss.barcode == code).values(checked_at=func.now()))
            await s.commit()
        await asyncio.sleep(PAUSE)
    if found:
        log.info("Open Food Facts: нашлись %s товаров, которых раньше не было", found)
    return found


async def forever() -> None:
    while True:
        try:
            await recheck()
        except Exception:
            log.warning("barcode recheck failed", exc_info=True)
        await asyncio.sleep(6 * 3600)


async def weekly_report(session) -> bool:
    """Monday from 10:00 (server time): the most scanned barcodes still missing, to the owner. Once a week."""
    now = datetime.now().astimezone()
    week = (now - timedelta(days=now.weekday())).date().isoformat()
    if now.weekday() != 0 or now.hour < 10 or not alerts.admin_ids():
        return False
    try:
        if json.loads(STATE.read_text(encoding="utf-8")).get("week") == week:
            return False
    except (OSError, ValueError):
        pass
    since = datetime.now(timezone.utc) - timedelta(days=7)
    rows = list(await session.execute(select(BarcodeMiss.barcode, BarcodeMiss.scans, BarcodeMiss.last_at >= since)
                                      .order_by(BarcodeMiss.scans.desc()).limit(TOP)))
    total = await session.scalar(select(func.count()).select_from(BarcodeMiss))
    STATE.write_text(json.dumps({"week": week}), encoding="utf-8")
    if not rows:
        return False
    lines = [f"{i + 1}. {code} — сканировали {n} раз" + (" (на этой неделе тоже)" if recent else "") for i, (code, n, recent) in enumerate(rows)]
    text = (f"🔎 Штрихкоды, которых нет в базе: {total}. Чаще всего искали:\n\n" + "\n".join(lines)
            + "\n\nКаждый такой товар появится у всех, как только кто-то добавит его по фото этикетки.")
    for admin in alerts.admin_ids():
        session.add(Outbox(telegram_id=admin, text=text))
    await session.commit()
    return True
