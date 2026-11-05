from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from backend.core.config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_session():
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    # shortcut: create_all instead of migrations; switch to Alembic once the schema starts changing
    from backend.database import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # create_all doesn't add columns to existing tables; idempotent column additions go here.
        for ddl in ADDED_COLUMNS:
            await conn.execute(text(ddl))


ADDED_COLUMNS = [
    "ALTER TABLE exercises ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE exercises DROP CONSTRAINT IF EXISTS exercises_name_key",
    "ALTER TABLE program_exercises ADD COLUMN IF NOT EXISTS unit VARCHAR(10) NOT NULL DEFAULT 'reps'",
    "ALTER TABLE program_exercises ADD COLUMN IF NOT EXISTS superset INTEGER",
    "ALTER TABLE workout_sets ALTER COLUMN reps DROP NOT NULL",
    "ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS duration_seconds INTEGER",
    "ALTER TABLE programs ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_name_key",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS ix_products_owner_user_id ON products (owner_user_id)",
    "ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS snack_slot VARCHAR(5)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(8)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_freezes INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE reminder_settings ADD COLUMN IF NOT EXISTS weekly BOOLEAN NOT NULL DEFAULT true",
    "ALTER TABLE reminder_settings ADD COLUMN IF NOT EXISTS weekly_at VARCHAR(5) NOT NULL DEFAULT '19:00'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS accent VARCHAR(7)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS portion_g FLOAT",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS portion_name VARCHAR(40)",
    # name+brand unique only among shared products (was: across all, which blocked users' own dishes)
    "ALTER TABLE products DROP CONSTRAINT IF EXISTS products_name_brand_key",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_products_shared_name_brand ON products (name, brand) WHERE owner_user_id IS NULL",
    *(f"ALTER TABLE profiles ADD COLUMN IF NOT EXISTS {c}" for c in (
        "experience VARCHAR(16)", "equipment VARCHAR[]", "sessions_per_week INTEGER", "session_minutes INTEGER",
        "allergies VARCHAR[]", "meals_per_day INTEGER", "sleep_hours FLOAT", "stress VARCHAR(16)", "injury VARCHAR(16)",
    )),
    # 3 old goals -> 5 Logos goals
    "UPDATE profiles SET goal = CASE goal WHEN 'lose' THEN 'weight_loss' WHEN 'maintain' THEN 'maintenance' "
    "WHEN 'gain' THEN 'muscle_gain' ELSE goal END WHERE goal IN ('lose', 'maintain', 'gain')",
    # products saved from Open Food Facts before HTML entities were decoded
    *(f"""UPDATE products SET {c} = replace(replace(replace({c}, '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
          WHERE {c} LIKE '%&%;%'""" for c in ("name", "brand", "search_text")),
]


__all__ = ["engine", "SessionLocal", "Base", "AsyncSession", "get_session", "init_db"]
