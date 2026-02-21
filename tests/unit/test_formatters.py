from __future__ import annotations

import pytest

from tm_core.formatters import render_format, to_html, to_srt, to_txt, to_vtt
from tm_core.schemas import TranscriptDocument, TranscriptSegment


def _sample_document() -> TranscriptDocument:
    return TranscriptDocument(
        provider="openai",
        model="gpt-4o-mini-transcribe",
        detected_language="en",
        segments=[
            TranscriptSegment(id=1, start=0.0, end=1.2, text="Hello <world>", translated_text="Bonjour monde"),
            TranscriptSegment(id=2, start=1.2, end=2.0, text="Second line", translated_text="Deuxieme ligne"),
        ],
    )


def test_subtitle_and_text_variants_render_source_and_translated() -> None:
    document = _sample_document()

    srt_source = to_srt(document, variant="source")
    srt_translated = to_srt(document, variant="translated")
    assert "Hello <world>" in srt_source
    assert "Bonjour monde" in srt_translated

    vtt_source = to_vtt(document, variant="source")
    vtt_translated = to_vtt(document, variant="translated")
    assert "WEBVTT" in vtt_source
    assert "Bonjour monde" in vtt_translated

    txt_source = to_txt(document, variant="source")
    txt_translated = to_txt(document, variant="translated")
    assert "Second line" in txt_source
    assert "Deuxieme ligne" in txt_translated


def test_html_renderer_escapes_content() -> None:
    html = to_html(_sample_document())
    assert "<world>" not in html
    assert "&lt;world&gt;" in html


def test_render_format_rejects_combined_variant_for_plain_text_formats() -> None:
    document = _sample_document()
    with pytest.raises(ValueError, match="combined variant is not supported for txt"):
        render_format(document, "txt", variant="combined")
