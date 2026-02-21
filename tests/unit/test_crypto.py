from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from app.config import Settings
from app.crypto import EncryptionService


def _local_settings(tmp_path: Path) -> Settings:
    return Settings(
        app_mode="local",
        db_path=tmp_path / "app.db",
        storage_dir=tmp_path / "storage",
        temp_dir=tmp_path / "temp",
        key_file_path=tmp_path / "secret.key",
    )


def test_local_encryption_roundtrip_and_key_reuse(tmp_path: Path) -> None:
    settings = _local_settings(tmp_path)
    service = EncryptionService(settings)
    encrypted = service.encrypt("super-secret")
    assert encrypted != "super-secret"
    assert service.decrypt(encrypted) == "super-secret"
    assert settings.key_file_path.exists()

    second = EncryptionService(settings)
    assert second.decrypt(encrypted) == "super-secret"


def test_cloudflare_mode_requires_encryption_key(tmp_path: Path) -> None:
    settings = Settings(
        app_mode="cloudflare",
        db_path=tmp_path / "app.db",
        storage_dir=tmp_path / "storage",
        temp_dir=tmp_path / "temp",
        key_file_path=tmp_path / "secret.key",
        encryption_key=None,
    )
    with pytest.raises(RuntimeError, match="TM_ENCRYPTION_KEY is required"):
        EncryptionService(settings)


def test_cloudflare_mode_encrypts_with_env_key(tmp_path: Path) -> None:
    key = Fernet.generate_key().decode("utf-8")
    settings = Settings(
        app_mode="cloudflare",
        db_path=tmp_path / "app.db",
        storage_dir=tmp_path / "storage",
        temp_dir=tmp_path / "temp",
        key_file_path=tmp_path / "secret.key",
        encryption_key=key,
    )
    service = EncryptionService(settings)
    encrypted = service.encrypt("value")
    assert service.decrypt(encrypted) == "value"
