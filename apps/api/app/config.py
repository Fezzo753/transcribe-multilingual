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
    encryption_key: str | None = Field(default=None)
    redis_url: str = Field(default="redis://localhost:6379/0")
    rq_queue_name: str = Field(default="transcribe")
    sync_duration_threshold_sec: int = Field(default=900)
    sync_size_threshold_mb: int = Field(default=20)
    retention_days: int = Field(default=7)
    cleanup_interval_minutes: int = Field(default=60)
    translation_fallback_order: str = Field(default="native,openai,deepgram")
    local_folder_allowlist: str = Field(default="")
    max_upload_mb: int = Field(default=0)
    cors_origins: str = Field(default="*")
    openai_translation_model: str = Field(default="gpt-4o-mini")

    @property
    def fallback_order(self) -> list[str]:
        return [x.strip() for x in self.translation_fallback_order.split(",") if x.strip()]

    @property
    def folder_allowlist(self) -> list[Path]:
        paths = []
        for raw in [x.strip() for x in self.local_folder_allowlist.split(",") if x.strip()]:
            paths.append(Path(raw).resolve())
        return paths

@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
