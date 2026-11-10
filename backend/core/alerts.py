"""Tell the owner (ADMIN_IDS) about errors in the API, the bot and the Mini App, through the bot's outbox.
The same error is reported at most once per QUIET minutes, so a broken screen doesn't flood the chat."""
import logging
import time
import traceback

from backend.core.config import settings
from backend.database.db import SessionLocal
from backend.database.models import Outbox

log = logging.getLogger("alerts")
QUIET = 30 * 60
_last: dict[str, float] = {}  # signature -> when reported (per process: API and bot each keep their own)


def admin_ids() -> list[int]:
    return [int(x) for x in settings.admin_ids.replace(" ", "").split(",") if x.isdigit()]


def describe(exc: BaseException) -> str:
    """'ValueError: bad thing' + the last frames, short enough for one Telegram message."""
    frames = traceback.extract_tb(exc.__traceback__)[-3:]
    where = "\n".join(f"  {f.filename.split('backend')[-1]}:{f.lineno} {f.name}" for f in frames)
    return f"{type(exc).__name__}: {str(exc)[:300]}\n{where}"


async def report(where: str, text: str) -> bool:
    """Queue an alert for every admin. Returns False when muted (seen recently) or there are no admins."""
    admins = admin_ids()
    sig = f"{where}|{text.splitlines()[0][:120] if text else ''}"
    now = time.monotonic()
    if not admins or now - _last.get(sig, -QUIET) < QUIET:
        return False
    _last[sig] = now
    try:
        async with SessionLocal() as s:
            for tg_id in admins:
                s.add(Outbox(telegram_id=tg_id, kind="alert", text=f"⚠️ Ошибка · {where}\n\n{text}"[:3500]))
            await s.commit()
    except Exception:  # alerts must never break the thing that failed
        log.warning("could not queue an alert", exc_info=True)
        return False
    return True
