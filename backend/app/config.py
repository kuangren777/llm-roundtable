from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache
import os


_PROJECT_ROOT = os.environ.get("PROJECT_ROOT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
_DB_PATH = os.path.join(_PROJECT_ROOT, "debate.db")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=os.path.join(os.path.dirname(__file__), "..", "..", "config", ".env"),
        env_file_encoding="utf-8",
    )

    database_url: str = f"sqlite+aiosqlite:///{_DB_PATH}"
    host: str = Field(default="0.0.0.0", validation_alias=AliasChoices("HOST", "BACKEND_HOST"))
    port: int = Field(default=8000, validation_alias=AliasChoices("BACKEND_PORT", "PORT"))
    jwt_secret_key: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 7
    auth_cookie_name: str = "rt_session"
    auth_cookie_secure: bool = False
    auth_cookie_samesite: str = "lax"
    seed_admin_email: str = "admin@example.com"
    seed_admin_password: str = "ChangeMe123!"


@lru_cache
def get_settings() -> Settings:
    return Settings()
