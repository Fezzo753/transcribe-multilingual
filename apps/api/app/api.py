from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import Settings
from app.crypto import EncryptionService
from app.db import Database
from app.dependencies import (
    get_crypto,
    get_db,
    get_job_service,
    get_storage,
    resolve_settings,
)
from app.jobs import InputMedia, JobService
from app.storage import StorageService
from tm_core.capabilities import PROVIDER_CAPABILITIES, list_capabilities, provider_enabled, provider_requires_key
from tm_core.schemas import (
    ArtifactInfo,
    AppSettingsResponse,
    AppSettingsUpdateRequest,
    BatchJobCreateRequest,
    BatchJobStatusResponse,
    KeyStatus,
    KeyUpdateRequest,
)


router = APIRouter(prefix="/api", tags=["api"])


class FolderBatchRequest(BatchJobCreateRequest):
    folder_path: str
    recursive: bool = True
    include_extensions: list[str] = Field(default_factory=lambda: [".wav", ".mp3", ".m4a", ".flac", ".mp4", ".mkv", ".webm"])


def _parse_formats(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _resolve_effective_settings(settings: Settings, db: Database) -> AppSettingsResponse:
    sync_size_threshold_mb = int(db.get_app_setting("sync_size_threshold_mb") or settings.sync_size_threshold_mb)
    retention_days = int(db.get_app_setting("retention_days") or settings.retention_days)
    fallback_order_raw = db.get_app_setting("translation_fallback_order") or settings.translation_fallback_order
    fallback_order = [item.strip() for item in fallback_order_raw.split(",") if item.strip()]
    allowlist_raw = db.get_app_setting("local_folder_allowlist") or settings.local_folder_allowlist
    allowlist = [item.strip() for item in allowlist_raw.split(",") if item.strip()]
    return AppSettingsResponse(
        app_mode=settings.app_mode,
        sync_size_threshold_mb=sync_size_threshold_mb,
        retention_days=retention_days,
        translation_fallback_order=fallback_order,
        local_folder_allowlist=allowlist,
    )


@router.get("/capabilities")
def get_capabilities(settings: Settings = Depends(resolve_settings)) -> dict:
    return list_capabilities(app_mode=settings.app_mode)


@router.get("/settings/keys", response_model=list[KeyStatus])
def list_key_settings(
    db: Database = Depends(get_db),
    settings: Settings = Depends(resolve_settings),
) -> list[KeyStatus]:
    configured = {row["provider"]: row["updated_at"] for row in db.list_api_keys()}
    result: list[KeyStatus] = []
    for provider in PROVIDER_CAPABILITIES:
        if not provider_enabled(provider, app_mode=settings.app_mode):
            continue
        result.append(
            KeyStatus(
                provider=provider,
                configured=provider in configured,
                updated_at=configured.get(provider),
            )
        )
    return result


@router.put("/settings/keys/{provider}", response_model=KeyStatus)
def put_key_setting(
    provider: str,
    body: KeyUpdateRequest,
    db: Database = Depends(get_db),
    crypto: EncryptionService = Depends(get_crypto),
) -> KeyStatus:
    if provider != body.provider:
        raise HTTPException(status_code=400, detail="provider path/body mismatch")
    if not provider_requires_key(provider):
        raise HTTPException(status_code=400, detail=f"provider '{provider}' does not use API keys")
    db.upsert_api_key(provider, crypto.encrypt(body.key))
    row = next(item for item in db.list_api_keys() if item["provider"] == provider)
    return KeyStatus(provider=provider, configured=True, updated_at=row["updated_at"])


@router.delete("/settings/keys/{provider}", response_model=KeyStatus)
def delete_key_setting(provider: str, db: Database = Depends(get_db)) -> KeyStatus:
    db.delete_api_key(provider)
    return KeyStatus(provider=provider, configured=False, updated_at=None)


@router.get("/settings/app", response_model=AppSettingsResponse)
def get_app_settings(settings: Settings = Depends(resolve_settings), db: Database = Depends(get_db)) -> AppSettingsResponse:
    return _resolve_effective_settings(settings, db)


@router.put("/settings/app", response_model=AppSettingsResponse)
def put_app_settings(
    body: AppSettingsUpdateRequest,
    settings: Settings = Depends(resolve_settings),
    db: Database = Depends(get_db),
) -> AppSettingsResponse:
    if body.sync_size_threshold_mb is not None:
        db.set_app_setting("sync_size_threshold_mb", str(body.sync_size_threshold_mb))
    if body.retention_days is not None:
        db.set_app_setting("retention_days", str(body.retention_days))
    if body.translation_fallback_order is not None:
        db.set_app_setting("translation_fallback_order", ",".join(body.translation_fallback_order))
    if body.local_folder_allowlist is not None:
        db.set_app_setting("local_folder_allowlist", ",".join(body.local_folder_allowlist))
    return _resolve_effective_settings(settings, db)


@router.get("/jobs", response_model=list[BatchJobStatusResponse])
def list_jobs(service: JobService = Depends(get_job_service)) -> list[BatchJobStatusResponse]:
    return service.list_jobs()


@router.post("/jobs", response_model=BatchJobStatusResponse)
async def create_job_upload(
    files: list[UploadFile] = File(...),
    provider: str = Form(...),
    model: str = Form(...),
    source_language: str = Form("auto"),
    target_language: str | None = Form(None),
    formats: str = Form("json,txt"),
    diarization_enabled: bool = Form(False),
    speaker_count: int | None = Form(None),
    translation_enabled: bool = Form(True),
    sync_preferred: bool = Form(True),
    batch_label: str | None = Form(None),
    storage: StorageService = Depends(get_storage),
    service: JobService = Depends(get_job_service),
) -> BatchJobStatusResponse:
    if not files:
        raise HTTPException(status_code=400, detail="at least one file is required")
    request = BatchJobCreateRequest(
        provider=provider,
        model=model,
        source_language=source_language,
        target_language=target_language,
        formats=_parse_formats(formats),
        diarization_enabled=diarization_enabled,
        speaker_count=speaker_count,
        translation_enabled=translation_enabled,
        sync_preferred=sync_preferred,
        files_count=len(files),
        batch_label=batch_label,
    )
    inputs: list[InputMedia] = []
    job_temp_id = "pending"
    for upload in files:
        payload = await upload.read()
        path = storage.save_upload_bytes(job_id=job_temp_id, file_name=upload.filename or "upload.bin", payload=payload)
        inputs.append(
            InputMedia(
                name=upload.filename or path.name,
                source="upload",
                size_bytes=len(payload),
                path=path,
            )
        )
    try:
        return service.create_job(request, inputs)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _is_allowed_folder(target: Path, allowlist: list[Path]) -> bool:
    resolved = target.resolve()
    return any(resolved == base or base in resolved.parents for base in allowlist)


@router.post("/jobs/from-folder", response_model=BatchJobStatusResponse)
def create_job_folder(
    body: FolderBatchRequest,
    settings: Settings = Depends(resolve_settings),
    db: Database = Depends(get_db),
    service: JobService = Depends(get_job_service),
) -> BatchJobStatusResponse:
    if settings.app_mode != "local":
        raise HTTPException(status_code=400, detail="folder ingestion is available only in local mode")
    target_dir = Path(body.folder_path).resolve()
    allowlist_raw = db.get_app_setting("local_folder_allowlist") or settings.local_folder_allowlist
    allowlist = [Path(item.strip()).resolve() for item in allowlist_raw.split(",") if item.strip()]
    if not allowlist:
        raise HTTPException(status_code=400, detail="local folder allowlist is empty")
    if not _is_allowed_folder(target_dir, allowlist):
        raise HTTPException(status_code=403, detail="folder path is outside allowed roots")
    if not target_dir.exists():
        raise HTTPException(status_code=404, detail="folder path does not exist")

    candidates = target_dir.rglob("*") if body.recursive else target_dir.glob("*")
    ext_set = {ext.lower() for ext in body.include_extensions}
    inputs: list[InputMedia] = []
    for path in candidates:
        if not path.is_file():
            continue
        if ext_set and path.suffix.lower() not in ext_set:
            continue
        inputs.append(
            InputMedia(
                name=path.name,
                source="folder",
                size_bytes=path.stat().st_size,
                path=path.resolve(),
            )
        )
    if not inputs:
        raise HTTPException(status_code=400, detail="no eligible files found in folder")
    try:
        return service.create_job(body, inputs)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/jobs/{job_id}", response_model=BatchJobStatusResponse)
def get_job(job_id: str, service: JobService = Depends(get_job_service)) -> BatchJobStatusResponse:
    try:
        return service.get_job(job_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/artifacts")
def list_job_artifacts(job_id: str, service: JobService = Depends(get_job_service)) -> list[ArtifactInfo]:
    try:
        return service.list_job_artifacts(job_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/artifacts/{artifact_id}")
def download_artifact(job_id: str, artifact_id: str, service: JobService = Depends(get_job_service)) -> FileResponse:
    try:
        path = service.get_artifact_path(job_id, artifact_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path=path, filename=path.name)


@router.get("/jobs/{job_id}/bundle.zip")
def download_bundle(job_id: str, service: JobService = Depends(get_job_service)) -> FileResponse:
    artifacts = service.list_job_artifacts(job_id)
    bundle = next((item for item in artifacts if item.kind == "bundle"), None)
    if bundle is None:
        raise HTTPException(status_code=404, detail="bundle is not available yet")
    path = service.get_artifact_path(job_id, bundle.id)
    return FileResponse(path=path, filename=path.name, media_type="application/zip")


@router.post("/jobs/{job_id}/cancel", response_model=BatchJobStatusResponse)
def cancel_job(job_id: str, service: JobService = Depends(get_job_service)) -> BatchJobStatusResponse:
    try:
        return service.cancel_job(job_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
