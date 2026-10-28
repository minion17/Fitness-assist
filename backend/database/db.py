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
]


__all__ = ["engine", "SessionLocal", "Base", "AsyncSession", "get_session", "init_db"]
