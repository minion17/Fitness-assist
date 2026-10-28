"""Validation of Telegram Mini App initData.

https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
"""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl


class InitDataError(ValueError):
    pass


def validate_init_data(init_data: str, bot_token: str, max_age: int = 86400) -> dict:
    """Return parsed initData (with `user` decoded) or raise InitDataError."""
    if not init_data or not bot_token:
        raise InitDataError("empty initData or bot token")

    pairs = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=False))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        raise InitDataError("hash missing")

    check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        raise InitDataError("bad signature")

    auth_date = int(pairs.get("auth_date", "0"))
    if max_age and time.time() - auth_date > max_age:
        raise InitDataError("initData expired")

    if "user" in pairs:
        pairs["user"] = json.loads(pairs["user"])
    return pairs
