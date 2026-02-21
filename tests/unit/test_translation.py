from __future__ import annotations

from dataclasses import dataclass

from tm_core.schemas import TranscriptDocument, TranscriptSegment
from tm_core.translation import apply_translation_fallback


@dataclass
class FailTranslator:
    provider: str

    def translate(self, text: str, target_language: str, source_language: str | None = None) -> str:
        del text, target_language, source_language
        raise RuntimeError("translation backend failed")


@dataclass
class SuccessTranslator:
    provider: str
    suffix: str

    def translate(self, text: str, target_language: str, source_language: str | None = None) -> str:
        del source_language
        return f"{text}-{target_language}-{self.suffix}"


class NoNativeTranslation:
    def translate_native(
        self,
        document: TranscriptDocument,
        model: str,
        target_language: str,
    ) -> TranscriptDocument | None:
        del document, model, target_language
        return None


def _doc() -> TranscriptDocument:
    return TranscriptDocument(
        provider="openai",
        model="gpt-4o-mini-transcribe",
        detected_language="en",
        segments=[TranscriptSegment(id=1, start=0.0, end=1.0, text="hello")],
    )


def test_translation_fallback_moves_to_next_backend_after_failure() -> None:
    outcome = apply_translation_fallback(
        _doc(),
        target_language="fr",
        fallback_order=["native", "openai", "deepgram"],
        provider_native_translator=NoNativeTranslation(),
        translators={
            "openai": FailTranslator(provider="openai"),
            "deepgram": SuccessTranslator(provider="deepgram", suffix="dg"),
        },
        provider_model="gpt-4o-mini-transcribe",
    )

    assert outcome.backend == "deepgram"
    assert outcome.warning_code is None
    assert outcome.document.segments[0].translated_text == "hello-fr-dg"


def test_translation_fallback_returns_warning_when_all_backends_fail() -> None:
    outcome = apply_translation_fallback(
        _doc(),
        target_language="de",
        fallback_order=["native", "openai"],
        provider_native_translator=NoNativeTranslation(),
        translators={"openai": FailTranslator(provider="openai")},
        provider_model="gpt-4o-mini-transcribe",
    )

    assert outcome.backend is None
    assert outcome.warning_code == "translation_failed"
    assert outcome.document.segments[0].translated_text is None
