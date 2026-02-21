from __future__ import annotations

import pytest

from tm_core.capabilities import get_model_capability, list_capabilities, provider_enabled


def test_list_capabilities_filters_local_whisper_in_cloudflare_mode() -> None:
    local = list_capabilities(app_mode="local")
    cloud = list_capabilities(app_mode="cloudflare")

    local_providers = {item["provider"] for item in local["providers"]}
    cloud_providers = {item["provider"] for item in cloud["providers"]}

    assert "whisper-local" in local_providers
    assert "whisper-local" not in cloud_providers


def test_get_model_capability_blocks_local_whisper_in_cloudflare_mode() -> None:
    with pytest.raises(ValueError, match="whisper-local is disabled in cloudflare mode"):
        get_model_capability("whisper-local", "tiny", app_mode="cloudflare")


def test_provider_enabled_matches_runtime_mode() -> None:
    assert provider_enabled("whisper-local", app_mode="local") is True
    assert provider_enabled("whisper-local", app_mode="cloudflare") is False
    assert provider_enabled("openai", app_mode="cloudflare") is True
