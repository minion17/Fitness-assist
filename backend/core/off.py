"""Open Food Facts lookup by barcode (free open database, many Russian products)."""
import html
import re

import httpx

URL = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
UNIT_FIELDS = "quantity,product_quantity,product_quantity_unit,serving_size,serving_quantity"
FIELDS = f"product_name,product_name_ru,generic_name_ru,brands,nutriments,categories_tags,{UNIT_FIELDS}"
HEADERS = {"User-Agent": "Setly/1.0 (Telegram Mini App)"}  # OFF asks apps to identify themselves


def _num(n: dict, key: str) -> float | None:
    v = n.get(key)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


AMOUNT = re.compile(r"(?:(\d+)\s*[xх×*]\s*)?(\d+(?:[.,]\d+)?)\s*(кг|kg|гр?|g|мл|ml|л|l|cl)\b", re.I)
SCALE = {"кг": (1000, False), "kg": (1000, False), "г": (1, False), "гр": (1, False), "g": (1, False),
         "мл": (1, True), "ml": (1, True), "cl": (10, True), "л": (1000, True), "l": (1000, True)}
PIECE = re.compile(r"\b(шт|штук|piece|pcs?|pc|батончик|бутылк|банк|пакет|стакан)", re.I)


def amount(text: str | None) -> tuple[int, float, bool] | None:
    """"6 x 50 г" -> (6, 50.0, False); "0,5 л" -> (1, 500.0, True): count, grams-or-ml each, liquid."""
    m = AMOUNT.search(text or "")
    if not m:
        return None
    k, liquid = SCALE[m.group(3).lower()]
    return int(m.group(1) or 1), float(m.group(2).replace(",", ".")) * k, liquid


def units(p: dict) -> dict:
    """How to count an OFF product besides grams: a piece of a multipack or a labelled piece, the whole package,
    a serving from the label; drinks in ml. shortcut: 1 ml = 1 g (milk 1.03, juice 1.05: within 5%)."""
    out: dict = {}
    pack = amount(p.get("quantity"))
    q, unit = _num(p, "product_quantity"), str(p.get("product_quantity_unit") or "").lower()
    if not pack and q and unit in ("g", "ml"):
        pack = (1, q, unit == "ml")
    liquid = bool(pack and pack[2])
    serving = _num(p, "serving_quantity")
    if pack and pack[0] > 1 and 1 <= pack[1] <= 1500:
        out.update(piece_g=pack[1], piece_name="шт")  # one of a multipack
    elif serving and 1 <= serving <= 1500 and PIECE.search(p.get("serving_size") or ""):
        out.update(piece_g=serving, piece_name="шт")  # "1 батончик (40 г)"
    whole = pack[0] * pack[1] if pack else None
    if whole and 5 <= whole <= 2000:
        if "piece_g" not in out:
            out.update(piece_g=whole, piece_name="упаковка")
        elif abs(whole - out["piece_g"]) > 1:
            out.update(portion_g=whole, portion_name="упаковка")
    if serving and 1 <= serving <= 1500 and "portion_g" not in out and all(abs(serving - out.get(k, -99)) > 1 for k in ("piece_g",)):
        out.update(portion_g=serving, portion_name="порция")
    if liquid:
        out["ml_g"] = 1.0
    return {k: round(v, 1) if isinstance(v, float) else v for k, v in out.items()}


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
        "protein_g": round(protein, 1), "fat_g": round(fat, 1), "carbs_g": round(carbs, 1), **units(p),
    }


async def fetch(code: str) -> dict | None:
    """Product by barcode, None if unknown or unusable. Network errors propagate (caller decides)."""
    async with httpx.AsyncClient(timeout=8, headers=HEADERS) as c:
        r = await c.get(URL.format(code=code), params={"fields": FIELDS})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return parse(r.json())
