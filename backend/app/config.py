from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache
import os


_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_DB_PATH = os.path.join(_PROJECT_ROOT, "debate.db")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=os.path.join(os.path.dirname(__file__), "..", "..", "config", ".env"),
        env_file_encoding="utf-8",
    )

    database_url: str = f"sqlite+aiosqlite:///{_DB_PATH}"
    host: str = "0.0.0.0"
    port: int = 8000


@lru_cache
def get_settings() -> Settings:
    return Settings()
