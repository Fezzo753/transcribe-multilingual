from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

ProviderName = str


@dataclass(frozen=True)
class ModelCapability:
    id: str
    max_duration_sec: int
    max_size_mb: int
    supports_diarization: bool
    supports_speaker_count: bool
    supports_auto_language: bool
    supports_translation_native: bool
    supports_batch: bool
    supported_target_languages: list[str] | str


@dataclass(frozen=True)
class ProviderCapability:
    provider: ProviderName
    requires_api_key: bool
    models: list[ModelCapability]


_ALL_LANGUAGES = "*"

PROVIDER_CAPABILITIES: dict[ProviderName, ProviderCapability] = {
    "whisper-local": ProviderCapability(
        provider="whisper-local",
        requires_api_key=False,
        models=[
            ModelCapability(
                id="tiny",
                max_duration_sec=7200,
                max_size_mb=200,
                supports_diarization=False,
                supports_speaker_count=False,
                supports_auto_language=True,
                supports_translation_native=False,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
            ModelCapability(
                id="small",
                max_duration_sec=7200,
                max_size_mb=300,
                supports_diarization=False,
                supports_speaker_count=False,
                supports_auto_language=True,
                supports_translation_native=False,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
            ModelCapability(
                id="medium",
                max_duration_sec=10800,
                max_size_mb=500,
                supports_diarization=False,
                supports_speaker_count=False,
                supports_auto_language=True,
                supports_translation_native=False,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
        ],
    ),
    "openai": ProviderCapability(
        provider="openai",
        requires_api_key=True,
        models=[
            ModelCapability(
                id="gpt-4o-mini-transcribe",
                max_duration_sec=7200,
                max_size_mb=200,
                supports_diarization=False,
                supports_speaker_count=False,
                supports_auto_language=True,
                supports_translation_native=True,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
            ModelCapability(
                id="whisper-1",
                max_duration_sec=7200,
                max_size_mb=200,
                supports_diarization=False,
                supports_speaker_count=False,
                supports_auto_language=True,
                supports_translation_native=True,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
        ],
    ),
    "elevenlabs-scribe": ProviderCapability(
        provider="elevenlabs-scribe",
        requires_api_key=True,
        models=[
            ModelCapability(
                id="scribe_v1",
                max_duration_sec=7200,
                max_size_mb=400,
                supports_diarization=True,
                supports_speaker_count=True,
                supports_auto_language=True,
                supports_translation_native=False,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
            ModelCapability(
                id="scribe_v2",
                max_duration_sec=10800,
                max_size_mb=500,
                supports_diarization=True,
                supports_speaker_count=True,
                supports_auto_language=True,
                supports_translation_native=False,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
        ],
    ),
    "deepgram": ProviderCapability(
        provider="deepgram",
        requires_api_key=True,
        models=[
            ModelCapability(
                id="nova-3",
                max_duration_sec=10800,
                max_size_mb=500,
                supports_diarization=True,
                supports_speaker_count=False,
                supports_auto_language=True,
                supports_translation_native=True,
                supports_batch=True,
                supported_target_languages=_ALL_LANGUAGES,
            ),
        ],
    ),
}


def list_capabilities(app_mode: str = "local") -> dict[str, Any]:
    providers = PROVIDER_CAPABILITIES
    if app_mode == "cloudflare":
        providers = {k: v for k, v in providers.items() if k != "whisper-local"}
    return {
        "providers": [
            {
                "provider": p.provider,
                "requires_api_key": p.requires_api_key,
                "models": [asdict(m) for m in p.models],
            }
            for p in providers.values()
        ]
    }


def get_model_capability(provider: str, model: str, app_mode: str = "local") -> ModelCapability:
    if app_mode == "cloudflare" and provider == "whisper-local":
        raise ValueError("whisper-local is disabled in cloudflare mode")
    if provider not in PROVIDER_CAPABILITIES:
        raise ValueError(f"unsupported provider '{provider}'")
    capabilities = PROVIDER_CAPABILITIES[provider]
    for model_capability in capabilities.models:
        if model_capability.id == model:
            return model_capability
    raise ValueError(f"unsupported model '{model}' for provider '{provider}'")


def provider_requires_key(provider: str) -> bool:
    if provider not in PROVIDER_CAPABILITIES:
        raise ValueError(f"unsupported provider '{provider}'")
    return PROVIDER_CAPABILITIES[provider].requires_api_key


def provider_enabled(provider: str, app_mode: str = "local") -> bool:
    if provider not in PROVIDER_CAPABILITIES:
        return False
    if app_mode == "cloudflare" and provider == "whisper-local":
        return False
    return True
