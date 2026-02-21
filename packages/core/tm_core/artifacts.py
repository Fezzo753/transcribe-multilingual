from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from re import sub
from zipfile import ZIP_DEFLATED, ZipFile

from tm_core.formatters import render_format
from tm_core.schemas import OutputFormat, TranscriptDocument


@dataclass(frozen=True)
class ArtifactRenderResult:
    file_name: str
    mime_type: str
    content: str


_MIME_TYPES: dict[OutputFormat, str] = {
    "srt": "application/x-subrip",
    "vtt": "text/vtt",
    "html": "text/html",
    "txt": "text/plain",
    "json": "application/json",
}


def sanitize_prefix(name: str) -> str:
    stem = Path(name).stem.strip().lower()
    stem = sub(r"[^a-z0-9._-]+", "_", stem)
    stem = sub(r"_+", "_", stem)
    return stem.strip("_") or "file"


def build_artifact_name(prefix: str, variant: str, fmt: OutputFormat) -> str:
    if fmt == "json":
        return f"{prefix}__transcript.json"
    if fmt == "html":
        return f"{prefix}__combined.html"
    return f"{prefix}__{variant}.{fmt}"


def render_artifact(
    document: TranscriptDocument,
    prefix: str,
    fmt: OutputFormat,
    variant: str,
) -> ArtifactRenderResult:
    file_name = build_artifact_name(prefix, variant, fmt)
    content = render_format(document, fmt, variant=variant)
    return ArtifactRenderResult(file_name=file_name, mime_type=_MIME_TYPES[fmt], content=content)


def create_zip_bundle(bundle_path: Path, files: list[tuple[str, Path]], manifest: str) -> Path:
    bundle_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(bundle_path, "w", compression=ZIP_DEFLATED) as zf:
        zf.writestr("job_manifest.json", manifest)
        for arc_name, file_path in files:
            zf.write(file_path, arcname=arc_name)
    return bundle_path
