from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet

from app.config import Settings


class EncryptionService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._fernet = Fernet(self._load_or_create_key())

    def _load_or_create_key(self) -> bytes:
        if self._settings.app_mode == "cloudflare":
            if not self._settings.encryption_key:
                raise RuntimeError("TM_ENCRYPTION_KEY is required in cloudflare mode")
            return self._settings.encryption_key.encode("utf-8")

        key_file: Path = self._settings.key_file_path
        key_file.parent.mkdir(parents=True, exist_ok=True)
        if key_file.exists():
            return key_file.read_bytes().strip()
        key = Fernet.generate_key()
        key_file.write_bytes(key)
        return key

    def encrypt(self, raw: str) -> str:
        return self._fernet.encrypt(raw.encode("utf-8")).decode("utf-8")

    def decrypt(self, encrypted: str) -> str:
        return self._fernet.decrypt(encrypted.encode("utf-8")).decode("utf-8")
