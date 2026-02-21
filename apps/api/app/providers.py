from __future__ import annotations

from pathlib import Path

from app.config import Settings
from app.crypto import EncryptionService
from app.db import Database
from tm_core.adapters import ProviderAdapter, build_provider_adapter
from tm_core.translation import DeepgramTextTranslator, OpenAITextTranslator, TextTranslator


class ProviderManager:
    def __init__(self, settings: Settings, db: Database, crypto: EncryptionService) -> None:
        self._settings = settings
        self._db = db
        self._crypto = crypto

    def get_provider_key(self, provider: str) -> str | None:
        encrypted = self._db.get_api_key(provider)
        if encrypted is None:
            return None
        return self._crypto.decrypt(encrypted)

    def build_adapter(self, provider: str) -> ProviderAdapter:
        key = self.get_provider_key(provider)
        return build_provider_adapter(
            provider=provider,
            api_key=key,
            model_cache_dir=self._settings.temp_dir / "whisper-models",
        )

    def build_translators(self) -> dict[str, TextTranslator]:
        translators: dict[str, TextTranslator] = {}
        openai_key = self.get_provider_key("openai")
        if openai_key:
            translators["openai"] = OpenAITextTranslator(
                api_key=openai_key,
                model=self._settings.openai_translation_model,
            )
        deepgram_key = self.get_provider_key("deepgram")
        if deepgram_key:
            translators["deepgram"] = DeepgramTextTranslator(api_key=deepgram_key)
        return translators
