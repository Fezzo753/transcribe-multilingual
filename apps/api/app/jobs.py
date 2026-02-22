from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from app.config import Settings
from app.db import Database
from app.providers import ProviderManager
from app.queueing import QueueDispatcher
from app.storage import StorageService
from tm_core.artifacts import render_artifact, sanitize_prefix
from tm_core.capabilities import get_model_capability, provider_enabled
from tm_core.schemas import (
    ArtifactInfo,
    ArtifactVariant,
    BatchJobCreateRequest,
    BatchJobStatusResponse,
    FileJobStatus,
)
from tm_core.translation import apply_translation_fallback


@dataclass
class InputMedia:
    name: str
    source: str
    size_bytes: int
    path: Path


class JobService:
    def __init__(
        self,
        *,
        settings: Settings,
        db: Database,
        storage: StorageService,
        providers: ProviderManager,
        queue_dispatcher: QueueDispatcher | None = None,
    ) -> None:
        self._settings = settings
        self._db = db
        self._storage = storage
        self._providers = providers
        self._queue_dispatcher = queue_dispatcher

    def _artifact_kind_from_variant(self, variant: str | None) -> str:
        if variant == "source":
            return "source"
        if variant == "translated":
            return "translated"
        return "combined"

    def _effective_sync_threshold_mb(self) -> int:
        raw = self._db.get_app_setting("sync_size_threshold_mb")
        return int(raw) if raw else self._settings.sync_size_threshold_mb

    def _effective_retention_days(self) -> int:
        raw = self._db.get_app_setting("retention_days")
        return int(raw) if raw else self._settings.retention_days

    def _effective_fallback_order(self) -> list[str]:
        raw = self._db.get_app_setting("translation_fallback_order")
        if raw:
            return [item.strip() for item in raw.split(",") if item.strip()]
        return self._settings.fallback_order

    def _to_artifact_info(self, row: dict) -> ArtifactInfo:
        return ArtifactInfo(
            id=row["id"],
            file_id=row.get("file_id"),
            name=row["name"],
            mime_type=row["mime_type"],
            kind=row["kind"],
            format=row["format"],
            variant=row.get("variant"),
            size_bytes=row.get("size_bytes"),
        )

    def _build_job_response(self, job_id: str) -> BatchJobStatusResponse:
        job = self._db.get_job(job_id)
        if job is None:
            raise ValueError(f"job '{job_id}' not found")
        files_rows = self._db.list_job_files(job_id)
        artifacts_rows = self._db.list_artifacts(job_id)
        artifacts_by_file: dict[str, list[ArtifactInfo]] = {}
        top_level_artifacts: list[ArtifactInfo] = []
        for artifact in artifacts_rows:
            info = self._to_artifact_info(artifact)
            file_id = artifact.get("file_id")
            if file_id:
                artifacts_by_file.setdefault(file_id, []).append(info)
            else:
                top_level_artifacts.append(info)

        files: list[FileJobStatus] = []
        for row in files_rows:
            warning = row.get("warning_json") or {}
            error = row.get("error_json") or {}
            files.append(
                FileJobStatus(
                    id=row["id"],
                    input_name=row["input_name"],
                    input_source=row["input_source"],
                    status=row["status"],
                    detected_language=row.get("detected_language"),
                    duration_sec=row.get("duration_sec"),
                    error_code=error.get("code"),
                    error_message=error.get("message"),
                    translation_warning_code=warning.get("code"),
                    translation_warning_message=warning.get("message"),
                    artifacts=artifacts_by_file.get(row["id"], []),
                )
            )

        warning = job.get("warning_json") or {}
        error = job.get("error_json") or {}
        created_at = datetime.fromisoformat(job["created_at"])
        updated_at = datetime.fromisoformat(job["updated_at"])
        duration = (updated_at - created_at).total_seconds() if job["status"] in {"completed", "failed", "cancelled"} else None
        return BatchJobStatusResponse(
            id=job["id"],
            status=job["status"],
            provider=job["provider"],
            model=job["model"],
            source_language=job["source_language"],
            target_language=job["target_language"],
            created_at=created_at,
            updated_at=updated_at,
            duration_sec=duration,
            error_code=error.get("code"),
            error_message=error.get("message"),
            translation_warning_code=warning.get("code"),
            translation_warning_message=warning.get("message"),
            files=files,
            artifacts=top_level_artifacts,
            result=job.get("result_json"),
        )

    def create_job(self, request: BatchJobCreateRequest, inputs: list[InputMedia]) -> BatchJobStatusResponse:
        if not inputs:
            raise ValueError("at least one input file is required")
        if not provider_enabled(request.provider, app_mode=self._settings.app_mode):
            raise ValueError(f"provider '{request.provider}' is disabled in app mode '{self._settings.app_mode}'")

        capability = get_model_capability(request.provider, request.model, app_mode=self._settings.app_mode)
        if not capability.supports_batch and len(inputs) > 1:
            raise ValueError(f"model '{request.model}' does not support batch processing")

        job_id = uuid4().hex
        options = {
            "formats": request.formats,
            "diarization_enabled": request.diarization_enabled,
            "speaker_count": request.speaker_count,
            "sync_preferred": request.sync_preferred,
            "timestamp_level": request.timestamp_level,
            "verbose_output": request.verbose_output,
            "batch_label": request.batch_label,
            "local_folder": request.local_folder,
        }
        self._db.create_job(
            job_id=job_id,
            status="queued",
            provider=request.provider,
            model=request.model,
            source_language=request.source_language,
            target_language=request.target_language,
            translation_enabled=request.translation_enabled,
            options=options,
        )
        for item in inputs:
            self._db.create_job_file(
                file_id=uuid4().hex,
                job_id=job_id,
                input_name=item.name,
                input_source=item.source,
                size_bytes=item.size_bytes,
                storage_path=str(item.path),
            )

        should_queue = self._should_queue(request, inputs)
        if should_queue:
            if self._queue_dispatcher:
                try:
                    self._queue_dispatcher.enqueue_job(job_id)
                except Exception:
                    should_queue = False
            else:
                should_queue = False

        if not should_queue:
            self.process_job(job_id)
        return self._build_job_response(job_id)

    def _should_queue(self, request: BatchJobCreateRequest, inputs: list[InputMedia]) -> bool:
        if not request.sync_preferred:
            return True
        if len(inputs) > 1:
            return True
        threshold = self._effective_sync_threshold_mb() * 1024 * 1024
        if threshold <= 0:
            return True
        return any(item.size_bytes > threshold for item in inputs)

    def list_jobs(self, limit: int = 50) -> list[BatchJobStatusResponse]:
        return [self._build_job_response(item["id"]) for item in self._db.list_jobs(limit=limit)]

    def get_job(self, job_id: str) -> BatchJobStatusResponse:
        return self._build_job_response(job_id)

    def list_job_artifacts(self, job_id: str) -> list[ArtifactInfo]:
        return [self._to_artifact_info(row) for row in self._db.list_artifacts(job_id)]

    def get_artifact_path(self, job_id: str, artifact_id: str) -> Path:
        artifact = self._db.get_artifact(artifact_id)
        if artifact is None or artifact["job_id"] != job_id:
            raise ValueError("artifact not found")
        return Path(artifact["storage_path"])

    def cancel_job(self, job_id: str) -> BatchJobStatusResponse:
        self._db.update_job(job_id, status="cancelled")
        files = self._db.list_job_files(job_id)
        for file_row in files:
            if file_row["status"] in {"queued", "running"}:
                self._db.update_job_file(file_row["id"], status="cancelled")
        return self._build_job_response(job_id)

    def process_job(self, job_id: str) -> BatchJobStatusResponse:
        job = self._db.get_job(job_id)
        if job is None:
            raise ValueError("job not found")
        if job["status"] in {"completed", "failed", "cancelled"}:
            return self._build_job_response(job_id)

        self._db.update_job(job_id, status="running", error={})
        adapter = self._providers.build_adapter(job["provider"])
        translators = self._providers.build_translators()
        options = job.get("options_json") or {}
        formats = options.get("formats") or ["json", "txt"]
        diarization_enabled = bool(options.get("diarization_enabled", False))
        speaker_count = options.get("speaker_count")
        timestamp_level = str(options.get("timestamp_level") or "segment")
        verbose_output = bool(options.get("verbose_output", False))
        fallback_order = self._effective_fallback_order()
        processed = 0
        failed = 0

        for file_row in self._db.list_job_files(job_id):
            current = self._db.get_job(job_id)
            if current and current["status"] == "cancelled":
                break
            file_id = file_row["id"]
            self._db.update_job_file(file_id, status="running", error={})
            try:
                document = adapter.transcribe(
                    file_path=Path(file_row["storage_path"]),
                    model=job["model"],
                    source_language=job["source_language"],
                    diarization_enabled=diarization_enabled,
                    speaker_count=speaker_count,
                    timestamp_level=timestamp_level,
                    verbose_output=verbose_output,
                )

                warning_payload = None
                if job["translation_enabled"] and job["target_language"]:
                    outcome = apply_translation_fallback(
                        document=document,
                        target_language=job["target_language"],
                        fallback_order=fallback_order,
                        provider_native_translator=adapter,
                        translators=translators,
                        provider_model=job["model"],
                    )
                    document = outcome.document
                    if outcome.warning_code:
                        warning_payload = {"code": outcome.warning_code, "message": outcome.warning_message}

                prefix = sanitize_prefix(file_row["input_name"])
                translated_exists = any(segment.translated_text for segment in document.segments)
                for fmt in formats:
                    variants: list[ArtifactVariant]
                    if fmt in {"srt", "vtt", "txt"}:
                        variants = ["source"]
                        if translated_exists:
                            variants.append("translated")
                    elif fmt == "html":
                        variants = ["combined"]
                    else:
                        variants = ["combined"]

                    for variant in variants:
                        render_variant = "combined" if fmt in {"html", "json"} else variant
                        result = render_artifact(document, prefix=prefix, fmt=fmt, variant=render_variant)
                        output_path = self._storage.write_artifact_text(
                            job_id=job_id,
                            file_id=file_id,
                            file_name=result.file_name,
                            content=result.content,
                        )
                        self._db.add_artifact(
                            artifact_id=uuid4().hex,
                            job_id=job_id,
                            file_id=file_id,
                            format_name=fmt,
                            variant=None if fmt in {"html", "json"} else variant,
                            name=result.file_name,
                            mime_type=result.mime_type,
                            kind=self._artifact_kind_from_variant(None if fmt in {"html", "json"} else variant),
                            storage_path=str(output_path),
                            size_bytes=output_path.stat().st_size,
                        )

                self._db.update_job_file(
                    file_id,
                    status="completed",
                    detected_language=document.detected_language,
                    warning=warning_payload,
                )
                processed += 1
            except Exception as exc:
                failed += 1
                self._db.update_job_file(file_id, status="failed", error={"code": "file_processing_failed", "message": str(exc)})

        artifacts = [row for row in self._db.list_artifacts(job_id) if row["kind"] != "bundle"]
        bundle_entries = [(row["name"], Path(row["storage_path"])) for row in artifacts if Path(row["storage_path"]).exists()]
        manifest = json.dumps(
            {
                "job_id": job_id,
                "generated_at": datetime.now(tz=UTC).isoformat(),
                "processed_files": processed,
                "failed_files": failed,
                "artifacts": [row["name"] for row in artifacts],
            },
            indent=2,
        )
        bundle_path = self._storage.build_bundle(job_id=job_id, files=bundle_entries, manifest=manifest)
        self._db.add_artifact(
            artifact_id=uuid4().hex,
            job_id=job_id,
            file_id=None,
            format_name="zip",
            variant=None,
            name=f"{job_id}.zip",
            mime_type="application/zip",
            kind="bundle",
            storage_path=str(bundle_path),
            size_bytes=bundle_path.stat().st_size,
        )

        if processed == 0 and failed > 0:
            self._db.update_job(
                job_id,
                status="failed",
                error={"code": "job_failed", "message": "All files failed to process."},
                result={"processed_files": processed, "failed_files": failed},
            )
        else:
            self._db.update_job(
                job_id,
                status="completed",
                result={"processed_files": processed, "failed_files": failed},
            )
        return self._build_job_response(job_id)

    def cleanup_expired(self) -> int:
        cutoff = datetime.now(tz=UTC) - timedelta(days=self._effective_retention_days())
        paths = self._db.delete_records_older_than(cutoff.isoformat())
        removed = 0
        for path_str in paths:
            path = Path(path_str)
            if path.exists():
                path.unlink()
                removed += 1
        return removed
