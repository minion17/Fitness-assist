"""The current user's local time. Days in the diary, streaks and reminders follow the user's timezone,
not the server's: the request (or the reminder loop) sets it once with `use_tz`, everything else just calls today()/local()."""
from contextvars import ContextVar
from datetime import date, datetime, time, tzinfo
from zoneinfo import ZoneInfo, available_timezones

_tz: ContextVar[tzinfo | None] = ContextVar("user_tz", default=None)  # None: the server's own zone


def valid(name: str | None) -> bool:
    return bool(name) and name in _zones()


_zones_cache: set[str] = set()


def _zones() -> set[str]:
    if not _zones_cache:
        _zones_cache.update(available_timezones())
    return _zones_cache


def use_tz(name: str | None) -> None:
    _tz.set(ZoneInfo(name) if valid(name) else None)


def tz() -> tzinfo | None:
    return _tz.get()


def now() -> datetime:
    return datetime.now(tz()).astimezone(tz())


def today() -> date:
    return now().date()


def local(dt: datetime) -> datetime:
    return dt.astimezone(tz())


def local_start(d: date) -> datetime:
    """Midnight starting day `d` in the user's zone."""
    z = tz()
    return datetime.combine(d, time.min, z) if z else datetime.combine(d, time.min).astimezone()
