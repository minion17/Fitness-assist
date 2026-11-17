"""Import reference data from content/ into the database.

Safe to re-run: existing rows are updated in place (exercises by source_id or name), nothing is duplicated.
    python -m backend.seed.import_data
"""
import asyncio
import json
from pathlib import Path

from sqlalchemy import select

from backend.database.db import SessionLocal, engine, init_db
from backend.database.models import Exercise, Product, Program, ProgramDay, ProgramExercise

CONTENT = Path(__file__).resolve().parents[2] / "content"


def load(rel: str, required: tuple[str, ...] = ("name",), numeric: tuple[str, ...] = ()) -> list[dict]:
    path = CONTENT / rel
    if not path.exists():
        print(f"- нет файла {rel}, пропускаю")
        return []
    try:
        rows = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"{rel}: ошибка JSON в строке {e.lineno}, позиция {e.colno}: {e.msg}")
    if not isinstance(rows, list):
        raise SystemExit(f"{rel}: ожидается список [ ... ]")
    for i, row in enumerate(rows, 1):
        missing = [k for k in required if row.get(k) in (None, "")]
        bad = [k for k in numeric if k in row and not (isinstance(row[k], (int, float)) and row[k] >= 0)]
        if missing or bad:
            what = (f"нет поля {', '.join(missing)}" if missing else "") + (f" не число ≥ 0: {', '.join(bad)}" if bad else "")
            raise SystemExit(f"{rel}: запись №{i} ({row.get('name', '?')}): {what.strip()}")
    return rows


UNIT_FIELDS = ("piece_g", "piece_name", "ml_g", "tbsp_g", "portion_g", "portion_name")


async def import_products(s) -> int:
    added = 0
    # products.json: the team's list; usda_basics.json: staples from the USDA nutrient database (SR26, public domain),
    # named in Russian; basics_ru.json: everyday foods and dishes (build_basics_ru.py).
    # Same name+brand already in the catalog -> skipped, so the team's values win.
    numeric = ("kcal", "protein_g", "fat_g", "carbs_g")
    rows = [*load("products/products.json", ("name", "kcal"), numeric),
            *load("products/usda_basics.json", ("name", "kcal"), numeric),
            *load("products/basics_ru.json", ("name", "kcal"), numeric)]
    for p in rows:
        brand = p.get("brand") or None
        if brand and brand.strip().lower() in ("не указан", "нет", "-"):  # placeholder, not a real brand
            brand = None
        if await s.scalar(select(Product.id).where(
            Product.owner_user_id.is_(None), Product.name == p["name"], Product.brand.is_not_distinct_from(brand)
        )):
            continue
        s.add(Product(
            name=p["name"], brand=brand, barcode=p.get("barcode") or None, category=p.get("category"),
            kcal=p["kcal"], protein_g=p.get("protein_g", 0), fat_g=p.get("fat_g", 0), carbs_g=p.get("carbs_g", 0),
            **{k: p[k] for k in UNIT_FIELDS if p.get(k) is not None},
        ))
        added += 1
    await s.flush()
    # pieces, ml and spoons for products already in the catalog: filled where still empty, never overwritten
    units = json.loads((CONTENT / "products/units.json").read_text(encoding="utf-8")) if (CONTENT / "products/units.json").exists() else {}
    for name, fields in units.items():
        for product in await s.scalars(select(Product).where(Product.owner_user_id.is_(None), Product.name == name)):
            for k, v in fields.items():
                if k in UNIT_FIELDS and getattr(product, k) is None:
                    setattr(product, k, v)
    return added


LIBRARY_FIELDS = ("muscle_groups", "equipment", "difficulty", "description", "is_bodyweight", "source_id",
                  "primary_muscles", "secondary_muscles", "images", "category", "mechanic")


async def import_exercises(s) -> int:
    """New exercises are added; library ones are kept up to date in place (by source_id), so a corrected translation
    renames the row that programs and workout history already point to instead of adding a twin."""
    old_names = {e["source_id"]: e["name_ru"] for e in load("exercises/sources/free-exercise-db-ru.json", required=("source_id",))}
    added = 0
    items = [*load("exercises/exercises.json"), *load("exercises/translated_exercises.json")]
    current = {e["name"] for e in items}
    for e in items:  # ours first: they claim their rows before a library item could by an old name
        shared = Exercise.owner_user_id.is_(None)
        sid = e.get("source_id")
        free = Exercise.source_id.is_(None) if not sid else (Exercise.source_id.is_(None) | (Exercise.source_id == sid))
        row = await s.scalar(select(Exercise).where(shared, Exercise.source_id == sid).limit(1)) if sid else None
        if row is None:  # rows from before source_id: by the current name
            row = await s.scalar(select(Exercise).where(shared, free, Exercise.name == e["name"]).order_by(Exercise.id).limit(1))
        old = old_names.get(sid)
        if row is None and old and old not in current:  # or by the old machine-translated name, unless that's a name in use now
            row = await s.scalar(select(Exercise).where(shared, Exercise.source_id.is_(None), Exercise.name == old).order_by(Exercise.id).limit(1))
        if row is None:
            row = Exercise(name=e["name"])
            s.add(row)
            added += 1
        row.name = e["name"]
        for k in LIBRARY_FIELDS:
            v = e.get(k)
            if v is not None or k in ("description",):
                setattr(row, k, v if v is not None else getattr(row, k))
        row.muscle_groups = e.get("muscle_groups", []) or []
        row.equipment = e.get("equipment", []) or []
        row.difficulty = e.get("difficulty", "beginner")
        row.is_bodyweight = e.get("is_bodyweight", False)
    await s.flush()  # programs below look exercises up by name
    return added


async def import_programs(s) -> int:
    exercise_ids = dict((await s.execute(select(Exercise.name, Exercise.id).where(Exercise.owner_user_id.is_(None)))).all())
    added = 0
    for p in load("programs/programs.json"):
        if await s.scalar(select(Program.id).where(Program.name == p["name"], Program.owner_user_id.is_(None))):
            continue
        program = Program(
            name=p["name"], goal=p["goal"], level=p["level"],
            days_per_week=p["days_per_week"], description=p.get("description"),
        )
        for n, d in enumerate(p["days"], 1):
            day = ProgramDay(day_name=d["day_name"], day_order=d.get("day_order", n))
            for k, x in enumerate(d["exercises"], 1):
                if x["name"] not in exercise_ids:  # fail loudly: a silently missing exercise breaks the program
                    raise ValueError(f"Программа «{p['name']}»: упражнения «{x['name']}» нет в exercises.json")
                day.items.append(ProgramExercise(
                    exercise_id=exercise_ids[x["name"]], sets=x["sets"], reps=str(x["reps"]),
                    rest_seconds=x["rest_seconds"], notes=x.get("notes"), unit=x.get("unit", "reps"), position=k,
                ))
            program.days.append(day)
        s.add(program)
        added += 1
    return added


async def run() -> dict:
    await init_db()
    async with SessionLocal() as s:
        result = {
            "products": await import_products(s),
            "exercises": await import_exercises(s),
            "programs": await import_programs(s),
        }
        await s.commit()  # all or nothing
    return result


async def main() -> None:
    try:
        r = await run()
    finally:
        await engine.dispose()
    print(f"Импорт: продуктов +{r['products']}, упражнений +{r['exercises']}, программ +{r['programs']}")


if __name__ == "__main__":
    asyncio.run(main())
