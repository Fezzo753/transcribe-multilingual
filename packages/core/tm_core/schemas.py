from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

ProviderName = Literal["whisper-local", "openai", "elevenlabs-scribe", "deepgram"]
TranslationBackend = Literal["native", "openai", "deepgram"]
OutputFormat = Literal["srt", "vtt", "html", "txt", "json"]
ArtifactVariant = Literal["source", "translated", "combined"]
ArtifactKind = Literal["source", "translated", "combined", "bundle"]
InputSource = Literal["upload", "folder"]
JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]
FileStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


class JobCreateRequest(BaseModel):
    provider: ProviderName
    model: str
    source_language: str = "auto"
    target_language: str | None = None
    formats: list[OutputFormat] = Field(default_factory=lambda: ["json", "txt"])
    diarization_enabled: bool = False
    speaker_count: int | None = None
    translation_enabled: bool = True
    sync_preferred: bool = True

    @field_validator("formats")
    @classmethod
    def unique_formats(cls, value: list[OutputFormat]) -> list[OutputFormat]:
        return list(dict.fromkeys(value))


class BatchJobCreateRequest(JobCreateRequest):
    files_count: int = Field(default=1, ge=1)
    batch_label: str | None = None
    local_folder: str | None = None


class TranscriptSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    translated_text: str | None = None
    confidence: float | None = None
    speaker: str | None = None


class TranscriptDocument(BaseModel):
    provider: ProviderName
    model: str
    detected_language: str | None = None
    segments: list[TranscriptSegment]
    metadata: dict = Field(default_factory=dict)


class ArtifactInfo(BaseModel):
    id: str
    file_id: str | None = None
    name: str
    mime_type: str
    kind: ArtifactKind
    format: OutputFormat | Literal["zip"]
    variant: ArtifactVariant | None = None
    size_bytes: int | None = None


class FileJobStatus(BaseModel):
    id: str
    input_name: str
    input_source: InputSource
    status: FileStatus
    detected_language: str | None = None
    duration_sec: float | None = None
    error_code: str | None = None
    error_message: str | None = None
    translation_warning_code: str | None = None
    translation_warning_message: str | None = None
    artifacts: list[ArtifactInfo] = Field(default_factory=list)


class BatchJobStatusResponse(BaseModel):
    id: str
    status: JobStatus
    provider: ProviderName
    model: str
    source_language: str
    target_language: str | None
    created_at: datetime
    updated_at: datetime
    duration_sec: float | None = None
    error_code: str | None = None
    error_message: str | None = None
    translation_warning_code: str | None = None
    translation_warning_message: str | None = None
    files: list[FileJobStatus] = Field(default_factory=list)
    artifacts: list[ArtifactInfo] = Field(default_factory=list)
    result: dict | None = None


class KeyUpdateRequest(BaseModel):
    provider: ProviderName
    key: str = Field(min_length=1)


class KeyStatus(BaseModel):
    provider: ProviderName
    configured: bool
    updated_at: datetime | None = None


class AppSettingsResponse(BaseModel):
    app_mode: str
    sync_size_threshold_mb: int
    retention_days: int
    translation_fallback_order: list[TranslationBackend]
    local_folder_allowlist: list[str] = Field(default_factory=list)


class AppSettingsUpdateRequest(BaseModel):
    sync_size_threshold_mb: int | None = Field(default=None, ge=1)
    retention_days: int | None = Field(default=None, ge=1)
    translation_fallback_order: list[TranslationBackend] | None = None
    local_folder_allowlist: list[str] | None = None


# Backwards alias for callers that still use the single-job name.
JobStatusResponse = BatchJobStatusResponse
