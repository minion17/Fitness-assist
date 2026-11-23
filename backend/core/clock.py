"""The current user's local time. Days in the diary, streaks and reminders follow the user's timezone,
not the server's: the request (or the reminder loop) sets it once with `use_tz`, everything else just calls today()/local()."""
from contextvars import ContextVar
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, available_timezones

_tz: ContextVar[tzinfo | None] = ContextVar("user_tz", default=None)  # None: the server's own zone


def valid(name: str | None) -> bool:
    return bool(name) and name in _zones()


_zones_cache: set[str] = set()


def _zones() -> set[str]:
    if not _zones_cache:
        _zones_cache.update(available_timezones())
        if not _zones_cache:  # Windows without the tzdata package: users' zones silently fall back to the server's
            import logging
            logging.getLogger("clock").warning("Нет базы часовых поясов — установи пакет tzdata (update.bat ставит его сам)")
    return _zones_cache


def use_tz(name: str | None) -> None:
    _tz.set(ZoneInfo(name) if valid(name) else None)


def tz() -> tzinfo | None:
    return _tz.get()


def now() -> datetime:
    return datetime.now(tz()).astimezone(tz())


def client_time(at: datetime | None, earliest: datetime | None = None) -> datetime:
    """A moment the app recorded offline (a workout's start or end), sent later: trusted within the last 48 hours and
    not after now — a phone with a wrong clock or a stale queue can't move it further (it's clamped, not refused,
    so the record isn't lost)."""
    current = now()
    if at is None:
        return current
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    at = min(max(at, current - timedelta(hours=48), earliest or at), current)
    return at


def recent_day(day: date | None) -> date:
    """The day an offline record was made (a glass of water, a habit tick), if it's today or yesterday; else today."""
    t = today()
    return day if day in (t, t - timedelta(days=1)) else t


def today() -> date:
    return now().date()


def local(dt: datetime) -> datetime:
    return dt.astimezone(tz())


def local_start(d: date) -> datetime:
    """Midnight starting day `d` in the user's zone."""
    z = tz()
    return datetime.combine(d, time.min, z) if z else datetime.combine(d, time.min).astimezone()
