"""Open Food Facts lookup by barcode (free open database, many Russian products)."""
import html

import httpx

URL = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
FIELDS = "product_name,product_name_ru,generic_name_ru,brands,nutriments,categories_tags"
HEADERS = {"User-Agent": "Setly/1.0 (Telegram Mini App)"}  # OFF asks apps to identify themselves


def _num(n: dict, key: str) -> float | None:
    v = n.get(key)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def parse(data: dict) -> dict | None:
    """Our product fields from an OFF response, or None if it lacks a name or nutrition per 100 g."""
    if data.get("status") != 1:
        return None
    p = data.get("product") or {}
    # some OFF entries keep HTML entities (&quot;) in names
    name = html.unescape(p.get("product_name_ru") or p.get("product_name") or p.get("generic_name_ru") or "").strip()
    n = p.get("nutriments") or {}
    kcal = _num(n, "energy-kcal_100g")
    if kcal is None and (kj := _num(n, "energy_100g")) is not None:
        kcal = kj / 4.184
    macros = [_num(n, k) for k in ("proteins_100g", "fat_100g", "carbohydrates_100g")]
    if not name or kcal is None:
        return None
    protein, fat, carbs = (m or 0.0 for m in macros)
    # crowd-sourced data: reject physically impossible values instead of storing them
    if not (0 <= kcal <= 900 and all(0 <= m <= 100 for m in (protein, fat, carbs)) and protein + fat + carbs <= 101):
        return None
    brand = html.unescape(p.get("brands") or "").split(",")[0].strip() or None
    return {
        "name": name[:200], "brand": brand[:100] if brand else None, "kcal": round(kcal),
        "protein_g": round(protein, 1), "fat_g": round(fat, 1), "carbs_g": round(carbs, 1),
    }


async def fetch(code: str) -> dict | None:
    """Product by barcode, None if unknown or unusable. Network errors propagate (caller decides)."""
    async with httpx.AsyncClient(timeout=8, headers=HEADERS) as c:
        r = await c.get(URL.format(code=code), params={"fields": FIELDS})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return parse(r.json())
