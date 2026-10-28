from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # absolute path: works no matter which folder the bot/server is started from
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parents[2] / ".env", extra="ignore")

    bot_token: str = ""
    webapp_url: str = "http://localhost:5173"
    database_url: str = "postgresql+asyncpg://fitness:fitness@localhost:5432/fitness"
    # initData older than this is rejected (replay protection)
    init_data_max_age: int = 86400
    cors_origins: str = "*"


settings = Settings()
