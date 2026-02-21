from __future__ import annotations

from pathlib import Path
from zipfile import ZipFile

from tm_core.artifacts import build_artifact_name, create_zip_bundle, render_artifact, sanitize_prefix
from tm_core.schemas import TranscriptDocument, TranscriptSegment


def _doc() -> TranscriptDocument:
    return TranscriptDocument(
        provider="openai",
        model="gpt-4o-mini-transcribe",
        segments=[TranscriptSegment(id=1, start=0.0, end=1.0, text="hello", translated_text="bonjour")],
    )


def test_artifact_naming_and_sanitization() -> None:
    assert sanitize_prefix("  Weird Name!!.mp3 ") == "weird_name"
    assert build_artifact_name("demo", "source", "srt") == "demo__source.srt"
    assert build_artifact_name("demo", "translated", "txt") == "demo__translated.txt"
    assert build_artifact_name("demo", "combined", "html") == "demo__combined.html"
    assert build_artifact_name("demo", "combined", "json") == "demo__transcript.json"


def test_render_artifact_and_zip_bundle(tmp_path: Path) -> None:
    result = render_artifact(_doc(), prefix="sample", fmt="txt", variant="translated")
    assert result.file_name == "sample__translated.txt"
    assert "bonjour" in result.content

    content_file = tmp_path / "sample__translated.txt"
    content_file.write_text(result.content, encoding="utf-8")
    bundle = create_zip_bundle(
        tmp_path / "bundle.zip",
        files=[("sample__translated.txt", content_file)],
        manifest='{"ok": true}',
    )
    with ZipFile(bundle, "r") as archive:
        names = set(archive.namelist())
        assert "job_manifest.json" in names
        assert "sample__translated.txt" in names
