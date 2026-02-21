from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from tm_core.artifacts import create_zip_bundle


class StorageService:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.upload_dir = root / "uploads"
        self.artifact_dir = root / "artifacts"
        self.bundle_dir = root / "bundles"
        for path in (self.upload_dir, self.artifact_dir, self.bundle_dir):
            path.mkdir(parents=True, exist_ok=True)

    def save_upload_bytes(self, *, job_id: str, file_name: str, payload: bytes) -> Path:
        destination = self.upload_dir / job_id / f"{uuid4().hex}_{file_name}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
        return destination

    def register_local_file(self, *, job_id: str, source_path: Path) -> Path:
        return source_path.resolve()

    def write_artifact_text(self, *, job_id: str, file_id: str, file_name: str, content: str) -> Path:
        destination = self.artifact_dir / job_id / file_id / file_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
        return destination

    def build_bundle(self, *, job_id: str, files: list[tuple[str, Path]], manifest: str) -> Path:
        destination = self.bundle_dir / f"{job_id}.zip"
        return create_zip_bundle(destination, files=files, manifest=manifest)
