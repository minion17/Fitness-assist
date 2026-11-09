"""Bulk copy of Russian products from Open Food Facts (open data, ODbL) into the shared catalog.

Runs inside the API process in the background: a page every few seconds (OFF limits search to ~10 requests
a minute), progress kept in .off_sync so a restart continues where it stopped; a full pass is repeated monthly
to pick up new products. Products are found by barcode as before; this just makes search find them too.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from sqlalchemy.dialects.postgresql import insert

from backend.core.off import HEADERS, parse
from backend.database.db import SessionLocal
from backend.database.models import Product

log = logging.getLogger("off_sync")
STATE = Path(__file__).resolve().parents[2] / ".off_sync"
URL = "https://world.openfoodfacts.org/api/v2/search"
FIELDS = "code,product_name,product_name_ru,generic_name_ru,brands,nutriments"
PAGE_SIZE = 200
PAUSE = 7          # seconds between pages: OFF allows ~10 searches a minute
REPEAT_DAYS = 30


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(s: dict) -> None:
    STATE.write_text(json.dumps(s), encoding="utf-8")


def rows(products: list[dict]) -> list[dict]:
    """Our catalog rows from one OFF search page (unusable entries dropped by off.parse)."""
    out = []
    for p in products:
        code = str(p.get("code") or "").strip()
        if not code.isdigit() or not 8 <= len(code) <= 14:
            continue
        r = parse({"status": 1, "product": p})
        if r:
            out.append({**r, "barcode": code, "category": "Open Food Facts"})
    return out


async def save(batch: list[dict]) -> int:
    if not batch:
        return 0
    async with SessionLocal() as s:
        # one statement per row: a clash on barcode or on name+brand only skips that row
        added = 0
        for r in batch:
            added += (await s.execute(insert(Product).values(**r).on_conflict_do_nothing())).rowcount or 0
        await s.commit()
    return added


async def run() -> None:
    state = load_state()
    done = state.get("done_at")
    if done and datetime.fromisoformat(done) > datetime.now(timezone.utc) - timedelta(days=REPEAT_DAYS):
        return
    page, total = state.get("page", 1), state.get("added", 0)
    log.info("Open Food Facts: загружаю российские товары, с страницы %s", page)
    async with httpx.AsyncClient(timeout=60, headers=HEADERS) as c:
        while True:
            try:
                r = await c.get(URL, params={"countries_tags_en": "russia", "fields": FIELDS,
                                             "page_size": PAGE_SIZE, "page": page, "sort_by": "unique_scans_n"})
                r.raise_for_status()
                products = r.json().get("products") or []
            except (httpx.HTTPError, ValueError) as e:
                log.warning("Open Food Facts недоступен (%s), повтор через 5 минут", e)
                await asyncio.sleep(300)
                continue
            if not products:
                save_state({"page": 1, "added": 0, "done_at": datetime.now(timezone.utc).isoformat(), "last_total": total})
                log.info("Open Food Facts: готово, добавлено %s товаров", total)
                return
            total += await save(rows(products))
            page += 1
            save_state({"page": page, "added": total})
            await asyncio.sleep(PAUSE)


async def forever() -> None:
    """Background task: never lets an error stop the API; re-checks daily whether a new pass is due."""
    while True:
        try:
            await run()
        except Exception:
            log.warning("Open Food Facts sync failed", exc_info=True)
        await asyncio.sleep(86400)
