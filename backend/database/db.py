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
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS ix_products_owner_user_id ON products (owner_user_id)",
    *(f"ALTER TABLE profiles ADD COLUMN IF NOT EXISTS {c}" for c in (
        "experience VARCHAR(16)", "equipment VARCHAR[]", "sessions_per_week INTEGER", "session_minutes INTEGER",
        "allergies VARCHAR[]", "meals_per_day INTEGER", "sleep_hours FLOAT", "stress VARCHAR(16)", "injury VARCHAR(16)",
    )),
    # 3 old goals -> 5 Logos goals
    "UPDATE profiles SET goal = CASE goal WHEN 'lose' THEN 'weight_loss' WHEN 'maintain' THEN 'maintenance' "
    "WHEN 'gain' THEN 'muscle_gain' ELSE goal END WHERE goal IN ('lose', 'maintain', 'gain')",
]


__all__ = ["engine", "SessionLocal", "Base", "AsyncSession", "get_session", "init_db"]
