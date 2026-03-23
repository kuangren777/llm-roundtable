from functools import lru_cache
import os

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_JWT_SECRET = "change-me-in-production"
_DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
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
    jwt_secret_key: str = Field(default=DEFAULT_JWT_SECRET, validation_alias=AliasChoices("JWT_SECRET_KEY"))
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 7
    auth_cookie_name: str = "rt_session"
    auth_cookie_secure: bool = Field(default=True, validation_alias=AliasChoices("AUTH_COOKIE_SECURE"))
    auth_cookie_samesite: str = "lax"
    cors_allowed_origins: str = Field(
        default=_DEFAULT_CORS_ORIGINS,
        validation_alias=AliasChoices("CORS_ALLOWED_ORIGINS", "CORS_ORIGINS", "ALLOWED_ORIGINS"),
    )
    seed_admin_email: str = "admin@example.com"
    seed_admin_password: str = "ChangeMe123!"
    llm_max_concurrency: int = Field(default=10, validation_alias=AliasChoices("LLM_MAX_CONCURRENCY"))

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
