from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Protocol

import requests

from tm_core.schemas import TranscriptDocument, TranscriptSegment


class TextTranslator(Protocol):
    provider: str

    def translate(self, text: str, target_language: str, source_language: str | None = None) -> str:
        raise NotImplementedError


@dataclass
class OpenAITextTranslator:
    api_key: str
    provider: str = "openai"
    model: str = "gpt-4o-mini"

    def translate(self, text: str, target_language: str, source_language: str | None = None) -> str:
        source_hint = f" from {source_language}" if source_language else ""
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a translation engine. Return only translated text with no commentary.",
                    },
                    {
                        "role": "user",
                        "content": f"Translate this text{source_hint} to {target_language}: {text}",
                    },
                ],
                "temperature": 0,
            },
            timeout=120,
        )
        payload = response.json()
        if response.status_code >= 400:
            raise RuntimeError(f"openai translation failed ({response.status_code}): {payload}")
        return str(payload["choices"][0]["message"]["content"]).strip()


@dataclass
class DeepgramTextTranslator:
    api_key: str
    provider: str = "deepgram"

    def translate(self, text: str, target_language: str, source_language: str | None = None) -> str:
        response = requests.post(
            "https://api.deepgram.com/v1/translate",
            headers={"Authorization": f"Token {self.api_key}"},
            json={"text": text, "target_language": target_language, "source_language": source_language},
            timeout=120,
        )
        payload = response.json()
        if response.status_code >= 400:
            raise RuntimeError(f"deepgram translation failed ({response.status_code}): {payload}")
        translated = str(payload.get("translated_text", "")).strip()
        if not translated:
            raise RuntimeError("deepgram translation returned empty text")
        return translated


@dataclass(frozen=True)
class TranslationOutcome:
    document: TranscriptDocument
    backend: str | None
    warning_code: str | None = None
    warning_message: str | None = None


def _translate_segments(
    document: TranscriptDocument,
    translator: TextTranslator,
    target_language: str,
) -> TranscriptDocument:
    translated_segments: list[TranscriptSegment] = []
    for segment in document.segments:
        translated_text = translator.translate(
            text=segment.text,
            target_language=target_language,
            source_language=document.detected_language,
        )
        translated_segments.append(segment.model_copy(update={"translated_text": translated_text}))
    return document.model_copy(update={"segments": translated_segments})


def apply_translation_fallback(
    document: TranscriptDocument,
    *,
    target_language: str,
    fallback_order: Iterable[str],
    provider_native_translator: Any | None = None,
    translators: dict[str, TextTranslator] | None = None,
    provider_model: str,
) -> TranslationOutcome:
    translators = translators or {}
    for backend in fallback_order:
        try:
            if backend == "native":
                if provider_native_translator is None:
                    continue
                translated_doc = provider_native_translator.translate_native(
                    document=document,
                    model=provider_model,
                    target_language=target_language,
                )
                if translated_doc is None:
                    continue
                return TranslationOutcome(document=translated_doc, backend="native")
            if backend in translators:
                translated_doc = _translate_segments(document=document, translator=translators[backend], target_language=target_language)
                return TranslationOutcome(document=translated_doc, backend=backend)
        except Exception:
            continue
    return TranslationOutcome(
        document=document,
        backend=None,
        warning_code="translation_failed",
        warning_message="Translation failed for all backends; returning source transcript only.",
    )
