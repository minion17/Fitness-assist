"""How many times each product was logged, kept on the product (products.eaten_count) so search ranks by it without
counting the diary for every match. Refreshed at start and hourly: popularity needn't be to the minute."""
import asyncio
import logging

from sqlalchemy import text

from backend.database.db import engine

log = logging.getLogger("popularity")
REFRESH = text("""
    UPDATE products p SET eaten_count = c.n
    FROM (SELECT pr.id, COALESCE(f.n, 0) AS n FROM products pr
          LEFT JOIN (SELECT product_id, count(*) AS n FROM food_logs GROUP BY product_id) f ON f.product_id = pr.id) c
    WHERE p.id = c.id AND p.eaten_count IS DISTINCT FROM c.n""")


async def refresh() -> None:
    async with engine.begin() as conn:
        await conn.execute(REFRESH)


async def forever() -> None:
    while True:
        try:
            await refresh()
        except Exception:  # noqa: BLE001 — a failed refresh keeps yesterday's order, search still works
            log.exception("popularity refresh failed")
        await asyncio.sleep(3600)
