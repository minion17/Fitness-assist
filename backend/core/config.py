from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # absolute path: works no matter which folder the bot/server is started from
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parents[2] / ".env", extra="ignore")

    bot_token: str = ""
    bot_proxy: str = ""
    bot_username: str = ""
    admin_ids: str = ""
    pg_dump: str = ""  # path to pg_dump if it isn't found automatically (daily backups)
    backups: bool = True  # daily database backup into backups/ (off in tests)
    off_sync: bool = True  # background copy of Russian products from Open Food Facts (off in tests)  # Telegram ids (comma-separated) allowed to use /stats  # for invite links; normally the bot writes it to .bot_username itself  # e.g. socks5://127.0.0.1:1080 if Telegram is blocked
    webapp_url: str = "http://localhost:5173"
    privacy_url: str = ""  # the published privacy policy; linked from the consent screen
    database_url: str = "postgresql+asyncpg://fitness:fitness@localhost:5432/fitness"
    # initData older than this is rejected (replay protection)
    init_data_max_age: int = 86400
    cors_origins: str = "*"
    # AI (Claude API). Without a key the AI features answer 503 and the rest of the app works.
    anthropic_api_key: str = ""
    ai_model: str = "claude-haiku-5-5"
    ai_daily_limit: int = 30  # AI requests per user per day (cost guard)


settings = Settings()
