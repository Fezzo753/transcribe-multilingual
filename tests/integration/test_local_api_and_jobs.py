from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import router as api_router
from app.config import Settings
from app.crypto import EncryptionService
from app.db import Database
from app.dependencies import get_crypto, get_db, get_job_service, get_storage, resolve_settings
from app.jobs import InputMedia, JobService
from app.storage import StorageService
from tm_core.schemas import BatchJobCreateRequest, TranscriptDocument, TranscriptSegment


@dataclass
class FakeTranslator:
    provider: str = "openai"
    should_fail: bool = False

    def translate(self, text: str, target_language: str, source_language: str | None = None) -> str:
        del source_language
        if self.should_fail:
            raise RuntimeError("translator backend failure")
        return f"{text}-{target_language}"


class FakeAdapter:
    provider = "openai"

    def __init__(self, fail_markers: set[str] | None = None) -> None:
        self._fail_markers = fail_markers or set()

    def transcribe(
        self,
        file_path: Path,
        model: str,
        source_language: str = "auto",
        diarization_enabled: bool = False,
        speaker_count: int | None = None,
    ) -> TranscriptDocument:
        del source_language, diarization_enabled, speaker_count
        file_name = file_path.name.lower()
        if any(marker in file_name for marker in self._fail_markers):
            raise RuntimeError(f"forced transcription failure for {file_name}")
        return TranscriptDocument(
            provider="openai",
            model=model,
            detected_language="en",
            segments=[TranscriptSegment(id=1, start=0.0, end=1.0, text=f"source-{Path(file_name).stem}")],
        )

    def translate_native(
        self,
        document: TranscriptDocument,
        model: str,
        target_language: str,
    ) -> TranscriptDocument | None:
        del document, model, target_language
        return None


class FakeProviderManager:
    def __init__(self, adapter: FakeAdapter, translators: dict[str, FakeTranslator] | None = None) -> None:
        self._adapter = adapter
        self._translators = translators or {}

    def build_adapter(self, provider: str) -> FakeAdapter:
        del provider
        return self._adapter

    def build_translators(self) -> dict[str, FakeTranslator]:
        return self._translators


def _build_runtime(tmp_path: Path, *, adapter: FakeAdapter, translators: dict[str, FakeTranslator] | None = None):
    allowlist_dir = tmp_path / "allowed"
    allowlist_dir.mkdir(parents=True, exist_ok=True)

    settings = Settings(
        app_mode="local",
        db_path=tmp_path / "app.db",
        storage_dir=tmp_path / "storage",
        temp_dir=tmp_path / "temp",
        key_file_path=tmp_path / "secret.key",
        local_folder_allowlist=str(allowlist_dir),
    )
    db = Database(settings.db_path)
    db.initialize()
    crypto = EncryptionService(settings)
    storage = StorageService(settings.storage_dir)
    providers = FakeProviderManager(adapter=adapter, translators=translators)
    service = JobService(
        settings=settings,
        db=db,
        storage=storage,
        providers=providers,
        queue_dispatcher=None,
    )

    app = FastAPI()
    app.include_router(api_router)
    app.dependency_overrides[resolve_settings] = lambda: settings
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_crypto] = lambda: crypto
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_job_service] = lambda: service
    client = TestClient(app)
    return settings, db, crypto, storage, service, client, allowlist_dir


def test_post_jobs_with_mocked_provider_generates_artifacts(tmp_path: Path) -> None:
    _, _, _, _, _, client, _ = _build_runtime(tmp_path, adapter=FakeAdapter())

    response = client.post(
        "/api/jobs",
        data={
            "provider": "openai",
            "model": "gpt-4o-mini-transcribe",
            "formats": "txt,json,srt",
            "translation_enabled": "false",
            "sync_preferred": "true",
        },
        files=[("files", ("ok.wav", b"abc", "audio/wav"))],
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["files"][0]["status"] == "completed"
    file_artifacts = [item["name"] for item in payload["files"][0]["artifacts"]]
    assert any(name.endswith("__source.txt") for name in file_artifacts)
    assert any(name.endswith("__source.srt") for name in file_artifacts)
    assert any(item["kind"] == "bundle" for item in payload["artifacts"])


def test_batch_job_mixed_outcomes_reports_failed_files(tmp_path: Path) -> None:
    settings, _, _, _, service, _, _ = _build_runtime(tmp_path, adapter=FakeAdapter(fail_markers={"bad"}))

    good = tmp_path / "good.wav"
    bad = tmp_path / "bad.wav"
    good.write_bytes(b"good")
    bad.write_bytes(b"bad")
    response = service.create_job(
        BatchJobCreateRequest(
            provider="openai",
            model="gpt-4o-mini-transcribe",
            formats=["txt"],
            translation_enabled=False,
            sync_preferred=True,
            files_count=2,
        ),
        [
            InputMedia(name="good.wav", source="upload", size_bytes=good.stat().st_size, path=good),
            InputMedia(name="bad.wav", source="upload", size_bytes=bad.stat().st_size, path=bad),
        ],
    )

    assert response.status == "completed"
    statuses = {item.input_name: item.status for item in response.files}
    assert statuses["good.wav"] == "completed"
    assert statuses["bad.wav"] == "failed"
    assert response.result == {"processed_files": 1, "failed_files": 1}


def test_translation_failure_returns_warning_and_source_outputs(tmp_path: Path) -> None:
    settings, _, _, _, service, _, _ = _build_runtime(
        tmp_path,
        adapter=FakeAdapter(),
        translators={
            "openai": FakeTranslator(provider="openai", should_fail=True),
            "deepgram": FakeTranslator(provider="deepgram", should_fail=True),
        },
    )

    media = tmp_path / "translate.wav"
    media.write_bytes(b"audio")
    response = service.create_job(
        BatchJobCreateRequest(
            provider="openai",
            model="gpt-4o-mini-transcribe",
            source_language="auto",
            target_language="fr",
            formats=["txt", "json"],
            translation_enabled=True,
            sync_preferred=True,
            files_count=1,
        ),
        [InputMedia(name="translate.wav", source="upload", size_bytes=media.stat().st_size, path=media)],
    )

    assert response.status == "completed"
    file_status = response.files[0]
    assert file_status.translation_warning_code == "translation_failed"
    names = {artifact.name for artifact in file_status.artifacts}
    assert any(name.endswith("__source.txt") for name in names)
    assert not any("__translated.txt" in name for name in names)


def test_key_crud_persists_encrypted_values(tmp_path: Path) -> None:
    _, db, crypto, _, _, client, _ = _build_runtime(tmp_path, adapter=FakeAdapter())

    put_response = client.put(
        "/api/settings/keys/openai",
        json={"provider": "openai", "key": "sk-demo"},
    )
    assert put_response.status_code == 200

    encrypted = db.get_api_key("openai")
    assert encrypted is not None
    assert encrypted != "sk-demo"
    assert crypto.decrypt(encrypted) == "sk-demo"

    status_response = client.get("/api/settings/keys")
    assert status_response.status_code == 200
    openai_row = next(item for item in status_response.json() if item["provider"] == "openai")
    assert openai_row["configured"] is True

    delete_response = client.delete("/api/settings/keys/openai")
    assert delete_response.status_code == 200
    assert db.get_api_key("openai") is None


def test_folder_batch_enforces_allowlist(tmp_path: Path) -> None:
    _, _, _, _, _, client, allowlist_dir = _build_runtime(tmp_path, adapter=FakeAdapter())

    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "outside.wav").write_bytes(b"audio")

    blocked_payload = {
        "provider": "openai",
        "model": "gpt-4o-mini-transcribe",
        "source_language": "auto",
        "target_language": None,
        "formats": ["txt"],
        "diarization_enabled": False,
        "speaker_count": None,
        "translation_enabled": False,
        "sync_preferred": True,
        "files_count": 1,
        "folder_path": str(outside),
    }
    blocked = client.post("/api/jobs/from-folder", json=blocked_payload)
    assert blocked.status_code == 403

    (allowlist_dir / "inside.wav").write_bytes(b"audio")
    allowed_payload = dict(blocked_payload)
    allowed_payload["folder_path"] = str(allowlist_dir)
    allowed = client.post("/api/jobs/from-folder", json=allowed_payload)
    assert allowed.status_code == 200


def test_cleanup_removes_uploaded_artifacts_but_keeps_folder_sources(tmp_path: Path) -> None:
    settings, db, _, storage, service, _, _ = _build_runtime(tmp_path, adapter=FakeAdapter())
    db.set_app_setting("retention_days", "1")

    uploaded_source = storage.save_upload_bytes(job_id="legacy", file_name="upload.wav", payload=b"upload-bytes")
    artifact_path = storage.write_artifact_text(
        job_id="legacy",
        file_id="legacy-file",
        file_name="legacy__source.txt",
        content="hello",
    )
    folder_source = tmp_path / "user-folder.wav"
    folder_source.write_bytes(b"user-audio")

    old = (datetime.now(tz=UTC) - timedelta(days=10)).isoformat()
    job_id = uuid4().hex
    upload_file_id = uuid4().hex
    folder_file_id = uuid4().hex
    db.create_job(
        job_id=job_id,
        status="completed",
        provider="openai",
        model="gpt-4o-mini-transcribe",
        source_language="auto",
        target_language=None,
        translation_enabled=False,
        options={"formats": ["txt"]},
    )
    db.create_job_file(
        file_id=upload_file_id,
        job_id=job_id,
        input_name="upload.wav",
        input_source="upload",
        size_bytes=uploaded_source.stat().st_size,
        storage_path=str(uploaded_source),
        status="completed",
    )
    db.create_job_file(
        file_id=folder_file_id,
        job_id=job_id,
        input_name="user-folder.wav",
        input_source="folder",
        size_bytes=folder_source.stat().st_size,
        storage_path=str(folder_source),
        status="completed",
    )
    db.add_artifact(
        artifact_id=uuid4().hex,
        job_id=job_id,
        file_id=upload_file_id,
        format_name="txt",
        variant="source",
        name="legacy__source.txt",
        mime_type="text/plain",
        kind="source",
        storage_path=str(artifact_path),
        size_bytes=artifact_path.stat().st_size,
    )

    with db._connect() as conn:  # noqa: SLF001
        conn.execute("UPDATE jobs SET created_at = ?, updated_at = ? WHERE id = ?", (old, old, job_id))
        conn.execute("UPDATE job_files SET created_at = ?, updated_at = ? WHERE job_id = ?", (old, old, job_id))
        conn.execute("UPDATE artifacts SET created_at = ? WHERE job_id = ?", (old, job_id))
        conn.commit()

    removed_count = service.cleanup_expired()
    assert removed_count >= 2
    assert not uploaded_source.exists()
    assert not artifact_path.exists()
    assert folder_source.exists()
