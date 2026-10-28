"""Import reference data from content/ into the database.

Safe to re-run: rows that already exist (by name) are skipped, so nothing is duplicated.
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


async def import_products(s) -> int:
    added = 0
    for p in load("products/products.json", ("name", "kcal"), ("kcal", "protein_g", "fat_g", "carbs_g")):
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
        ))
        added += 1
    return added


async def import_exercises(s) -> int:
    added = 0
    for e in load("exercises/exercises.json"):
        if await s.scalar(select(Exercise.id).where(Exercise.name == e["name"])):
            continue
        s.add(Exercise(
            name=e["name"], muscle_groups=e.get("muscle_groups", []), equipment=e.get("equipment", []),
            difficulty=e.get("difficulty", "beginner"), description=e.get("description"),
            is_bodyweight=e.get("is_bodyweight", False),
        ))
        added += 1
    await s.flush()  # programs below look exercises up by name
    return added


async def import_programs(s) -> int:
    exercise_ids = dict((await s.execute(select(Exercise.name, Exercise.id))).all())
    added = 0
    for p in load("programs/programs.json"):
        if await s.scalar(select(Program.id).where(Program.name == p["name"])):
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
                    rest_seconds=x["rest_seconds"], notes=x.get("notes"), position=k,
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
