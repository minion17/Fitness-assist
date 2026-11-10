"""Daily database backup with pg_dump into backups/ (the newest KEEP files are kept).

Restore: pg_restore --clean --if-exists -d <database url> backups/setly-....dump
shortcut: copies stay on the same computer as the database; on a server, also copy them somewhere else.
"""
import asyncio
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

from backend.core import alerts
from backend.core.config import settings

log = logging.getLogger("backup")
DIR = Path(__file__).resolve().parents[2] / "backups"
KEEP = 14
EVERY = 24 * 3600


def pg_dump() -> str | None:
    """pg_dump from PATH, or next to a Windows PostgreSQL install (C:\\pgsql\\bin)."""
    for candidate in (settings.pg_dump, shutil.which("pg_dump"), r"C:\pgsql\bin\pg_dump.exe"):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def command(exe: str, url: str, out: Path) -> tuple[list[str], dict]:
    u = urlsplit(url.replace("+asyncpg", ""))
    env = {**os.environ, "PGPASSWORD": unquote(u.password or "")}  # not on the command line: other users could see it
    args = [exe, "--format=custom", "--no-owner", f"--file={out}", "-h", u.hostname or "localhost", "-p", str(u.port or 5432),
            "-U", unquote(u.username or "postgres"), u.path.lstrip("/")]
    return args, env


def newest(directory: Path = DIR) -> Path | None:
    files = sorted(directory.glob("setly-*.dump"))
    return files[-1] if files else None


async def make(directory: Path = DIR) -> Path:
    exe = pg_dump()
    if not exe:
        raise RuntimeError("pg_dump не найден: укажите путь в .env как PG_DUMP=...")
    directory.mkdir(exist_ok=True)
    out = directory / f"setly-{datetime.now():%Y-%m-%d-%H%M}.dump"
    args, env = command(exe, settings.database_url, out)
    # a thread, not asyncio subprocesses: those don't work with every event loop on Windows
    proc = await asyncio.to_thread(subprocess.run, args, env=env, capture_output=True, timeout=600)
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        raise RuntimeError(f"pg_dump завершился с ошибкой: {proc.stderr.decode(errors='replace')[:500]}")
    for old in sorted(directory.glob("setly-*.dump"))[:-KEEP]:
        old.unlink(missing_ok=True)
    log.info("backup saved: %s (%d KB)", out.name, out.stat().st_size // 1024)
    return out


async def forever() -> None:
    """Background task in the API: a backup when the newest one is a day old; failures go to the owner."""
    while True:
        last = newest()
        if last is None or time.time() - last.stat().st_mtime > EVERY:
            try:
                await make()
            except Exception as e:
                log.warning("backup failed", exc_info=True)
                await alerts.report("резервная копия базы", str(e))
        await asyncio.sleep(3600)
