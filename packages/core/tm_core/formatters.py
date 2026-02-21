from __future__ import annotations

import json
from html import escape
from typing import Literal

from tm_core.schemas import TranscriptDocument


def _format_timestamp_srt(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def _format_timestamp_vtt(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}.{millis:03}"


def to_srt(document: TranscriptDocument, variant: Literal["source", "translated"] = "source") -> str:
    blocks: list[str] = []
    for idx, segment in enumerate(document.segments, start=1):
        text = segment.text
        if variant == "translated" and segment.translated_text:
            text = segment.translated_text
        blocks.append(
            "\n".join(
                [
                    str(idx),
                    f"{_format_timestamp_srt(segment.start)} --> {_format_timestamp_srt(segment.end)}",
                    text.strip(),
                ]
            )
        )
    return "\n\n".join(blocks).strip() + "\n"


def to_vtt(document: TranscriptDocument, variant: Literal["source", "translated"] = "source") -> str:
    lines = ["WEBVTT", ""]
    for segment in document.segments:
        text = segment.text
        if variant == "translated" and segment.translated_text:
            text = segment.translated_text
        lines.extend(
            [
                f"{_format_timestamp_vtt(segment.start)} --> {_format_timestamp_vtt(segment.end)}",
                text.strip(),
                "",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def to_txt(document: TranscriptDocument, variant: Literal["source", "translated"] = "source") -> str:
    chunks: list[str] = []
    for segment in document.segments:
        text = segment.text
        if variant == "translated" and segment.translated_text:
            text = segment.translated_text
        chunks.append(text.strip())
    return "\n".join(chunks).strip() + "\n"


def to_html(document: TranscriptDocument) -> str:
    rows = []
    for segment in document.segments:
        rows.append(
            "<tr>"
            f"<td>{segment.id}</td>"
            f"<td>{segment.start:.2f}</td>"
            f"<td>{segment.end:.2f}</td>"
            f"<td>{escape(segment.text)}</td>"
            f"<td>{escape(segment.translated_text or '')}</td>"
            f"<td>{escape(segment.speaker or '')}</td>"
            "</tr>"
        )
    return (
        "<!doctype html>"
        "<html><head><meta charset='utf-8'><title>Transcript</title>"
        "<style>body{font-family:ui-sans-serif,system-ui}table{border-collapse:collapse;width:100%}"
        "td,th{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f3f4f6}</style></head><body>"
        f"<h1>Transcript ({escape(document.provider)} / {escape(document.model)})</h1>"
        f"<p>Detected language: {escape(document.detected_language or 'unknown')}</p>"
        "<table><thead><tr><th>#</th><th>Start</th><th>End</th><th>Source</th><th>Translated</th><th>Speaker</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></body></html>"
    )


def to_json(document: TranscriptDocument) -> str:
    return document.model_dump_json(indent=2)

