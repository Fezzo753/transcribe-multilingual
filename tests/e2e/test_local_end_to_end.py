from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import router as api_router
from app.config import Settings
from app.crypto import EncryptionService
from app.db import Database
from app.dependencies import get_crypto, get_db, get_job_service, get_storage, resolve_settings
from app.jobs import JobService
from app.storage import StorageService
from tm_core.schemas import TranscriptDocument, TranscriptSegment


@dataclass
class Translator:
    provider: str = "openai"

    def translate(self, text: str, target_language: str, source_language: str | None = None) -> str:
        del source_language
        return f"{text}-{target_language}"


class Adapter:
    provider = "openai"

    def transcribe(
        self,
        file_path: Path,
        model: str,
        source_language: str = "auto",
        diarization_enabled: bool = False,
        speaker_count: int | None = None,
    ) -> TranscriptDocument:
        del file_path, source_language, diarization_enabled, speaker_count
        return TranscriptDocument(
            provider="openai",
            model=model,
            detected_language="en",
            segments=[
                TranscriptSegment(id=1, start=0.0, end=1.0, text="hello world"),
                TranscriptSegment(id=2, start=1.0, end=2.0, text="another line"),
            ],
        )

    def translate_native(
        self,
        document: TranscriptDocument,
        model: str,
        target_language: str,
    ) -> TranscriptDocument | None:
        del document, model, target_language
        return None


class ProviderManager:
    def __init__(self) -> None:
        self._adapter = Adapter()

    def build_adapter(self, provider: str) -> Adapter:
        del provider
        return self._adapter

    def build_translators(self) -> dict[str, Translator]:
        return {"openai": Translator()}


def _client(tmp_path: Path) -> TestClient:
    settings = Settings(
        app_mode="local",
        db_path=tmp_path / "app.db",
        storage_dir=tmp_path / "storage",
        temp_dir=tmp_path / "temp",
        key_file_path=tmp_path / "secret.key",
        local_folder_allowlist=str(tmp_path / "allowed"),
    )
    db = Database(settings.db_path)
    db.initialize()
    crypto = EncryptionService(settings)
    storage = StorageService(settings.storage_dir)
    service = JobService(
        settings=settings,
        db=db,
        storage=storage,
        providers=ProviderManager(),
        queue_dispatcher=None,
    )

    app = FastAPI()
    app.include_router(api_router)
    app.dependency_overrides[resolve_settings] = lambda: settings
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_crypto] = lambda: crypto
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_job_service] = lambda: service
    return TestClient(app)


def test_end_to_end_upload_translate_and_download_bundle(tmp_path: Path) -> None:
    client = _client(tmp_path)
    response = client.post(
        "/api/jobs",
        data={
            "provider": "openai",
            "model": "gpt-4o-mini-transcribe",
            "source_language": "auto",
            "target_language": "fr",
            "formats": "srt,vtt,html,txt,json",
            "translation_enabled": "true",
            "sync_preferred": "true",
        },
        files=[("files", ("clip.wav", b"audio-bytes", "audio/wav"))],
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    file_artifacts = {artifact["name"] for artifact in payload["files"][0]["artifacts"]}
    assert any(name.endswith("__source.srt") for name in file_artifacts)
    assert any(name.endswith("__translated.srt") for name in file_artifacts)
    assert any(name.endswith("__combined.html") for name in file_artifacts)
    assert any(name.endswith("__transcript.json") for name in file_artifacts)

    bundle = client.get(f"/api/jobs/{payload['id']}/bundle.zip")
    assert bundle.status_code == 200
    assert bundle.headers["content-type"].startswith("application/zip")
