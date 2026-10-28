from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    bot_token: str = ""
    webapp_url: str = "http://localhost:5173"
    database_url: str = "postgresql+asyncpg://fitness:fitness@localhost:5432/fitness"
    # initData older than this is rejected (replay protection)
    init_data_max_age: int = 86400
    cors_origins: str = "*"


settings = Settings()
