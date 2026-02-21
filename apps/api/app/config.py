from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TM_", case_sensitive=False)

    app_mode: str = Field(default="local")  # local | cloudflare
    db_path: Path = Field(default=Path("data/app.db"))
    storage_dir: Path = Field(default=Path("data/storage"))
    temp_dir: Path = Field(default=Path("data/temp"))
    key_file_path: Path = Field(default=Path.home() / ".transcribe-multilingual" / "secret.key")
    redis_url: str = Field(default="redis://localhost:6379/0")
    rq_queue_name: str = Field(default="transcribe")
    sync_duration_threshold_sec: int = Field(default=900)
    max_upload_mb: int = Field(default=512)
    cors_origins: str = Field(default="*")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

