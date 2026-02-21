from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

ProviderName = Literal["whisper-local", "openai", "elevenlabs-scribe", "deepgram"]
OutputFormat = Literal["srt", "vtt", "html", "txt", "json"]
JobStatus = Literal["queued", "running", "completed", "failed"]


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
    name: str
    mime_type: str
    kind: Literal["source", "translated", "bundle"]


class JobStatusResponse(BaseModel):
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
    artifacts: list[ArtifactInfo] = Field(default_factory=list)
    result: dict | None = None


class KeyUpdateRequest(BaseModel):
    provider: ProviderName
    key: str = Field(min_length=1)


class KeyStatus(BaseModel):
    provider: ProviderName
    configured: bool
    updated_at: datetime | None = None

