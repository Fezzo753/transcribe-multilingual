from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import requests

from tm_core.schemas import TranscriptDocument, TranscriptSegment


class ProviderAdapter(Protocol):
    provider: str

    def transcribe(
        self,
        file_path: Path,
        model: str,
        source_language: str = "auto",
        diarization_enabled: bool = False,
        speaker_count: int | None = None,
    ) -> TranscriptDocument:
        raise NotImplementedError

    def translate_native(
        self,
        document: TranscriptDocument,
        model: str,
        target_language: str,
    ) -> TranscriptDocument | None:
        return None


def _build_segments_from_words(words: list[dict[str, Any]]) -> list[TranscriptSegment]:
    if not words:
        return []
    segments: list[TranscriptSegment] = []
    chunk: list[dict[str, Any]] = []
    seg_id = 1
    for word in words:
        chunk.append(word)
        token = str(word.get("punctuated_word") or word.get("word") or "").strip()
        if token.endswith((".", "?", "!")) and chunk:
            start = float(chunk[0].get("start", 0.0))
            end = float(chunk[-1].get("end", start))
            text = " ".join(str(it.get("punctuated_word") or it.get("word") or "").strip() for it in chunk).strip()
            speaker = chunk[0].get("speaker")
            segments.append(
                TranscriptSegment(
                    id=seg_id,
                    start=start,
                    end=end,
                    text=text,
                    speaker=f"spk-{speaker}" if speaker is not None else None,
                )
            )
            seg_id += 1
            chunk = []
    if chunk:
        start = float(chunk[0].get("start", 0.0))
        end = float(chunk[-1].get("end", start))
        text = " ".join(str(it.get("punctuated_word") or it.get("word") or "").strip() for it in chunk).strip()
        speaker = chunk[0].get("speaker")
        segments.append(
            TranscriptSegment(
                id=seg_id,
                start=start,
                end=end,
                text=text,
                speaker=f"spk-{speaker}" if speaker is not None else None,
            )
        )
    return segments


def _single_segment_from_text(text: str) -> list[TranscriptSegment]:
    normalized = text.strip()
    if not normalized:
        normalized = "[empty transcript]"
    return [TranscriptSegment(id=1, start=0.0, end=0.0, text=normalized)]


def _provider_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: dict[str, Any] | None = None,
    files: dict[str, Any] | None = None,
    json_payload: dict[str, Any] | None = None,
    timeout: int = 1800,
) -> dict[str, Any]:
    response = requests.request(
        method=method,
        url=url,
        headers=headers,
        data=data,
        files=files,
        json=json_payload,
        timeout=timeout,
    )
    try:
        payload = response.json()
    except Exception as exc:  # pragma: no cover - defensive
        raise RuntimeError(f"non-json response from provider: {response.text[:200]}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"provider request failed ({response.status_code}): {payload}")
    return payload


@dataclass
class WhisperLocalAdapter:
    provider: str = "whisper-local"
    model_cache_dir: Path | None = None

    def transcribe(
        self,
        file_path: Path,
        model: str,
        source_language: str = "auto",
        diarization_enabled: bool = False,
        speaker_count: int | None = None,
    ) -> TranscriptDocument:
        del diarization_enabled, speaker_count
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except Exception as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("faster-whisper is not installed; install optional dependency 'local-whisper'") from exc

        device = "cpu"
        compute_type = "int8"
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                device = "cuda"
                compute_type = "float16"
        except Exception:
            pass

        model_obj = WhisperModel(model, device=device, compute_type=compute_type, download_root=str(self.model_cache_dir) if self.model_cache_dir else None)
        segments_iter, info = model_obj.transcribe(
            str(file_path),
            language=None if source_language == "auto" else source_language,
            vad_filter=True,
        )
        segments: list[TranscriptSegment] = []
        for idx, segment in enumerate(segments_iter, start=1):
            segments.append(
                TranscriptSegment(
                    id=idx,
                    start=float(segment.start),
                    end=float(segment.end),
                    text=str(segment.text).strip(),
                )
            )
        return TranscriptDocument(
            provider=self.provider, model=model, detected_language=getattr(info, "language", None), segments=segments
        )


@dataclass
class OpenAIAdapter:
    api_key: str
    provider: str = "openai"

    def transcribe(
        self,
        file_path: Path,
        model: str,
        source_language: str = "auto",
        diarization_enabled: bool = False,
        speaker_count: int | None = None,
    ) -> TranscriptDocument:
        del diarization_enabled, speaker_count
        with file_path.open("rb") as handle:
            data: dict[str, Any] = {"model": model, "response_format": "verbose_json"}
            if source_language != "auto":
                data["language"] = source_language
            payload = _provider_request(
                "POST",
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                data=data,
                files={"file": (file_path.name, handle)},
            )
        segments_raw = payload.get("segments") or []
        segments: list[TranscriptSegment] = []
        for idx, item in enumerate(segments_raw, start=1):
            segments.append(
                TranscriptSegment(
                    id=int(item.get("id", idx)),
                    start=float(item.get("start", 0.0)),
                    end=float(item.get("end", 0.0)),
                    text=str(item.get("text", "")).strip(),
                )
            )
        if not segments:
            segments = _single_segment_from_text(str(payload.get("text", "")))
        return TranscriptDocument(
            provider=self.provider,
            model=model,
            detected_language=payload.get("language"),
            segments=segments,
            metadata={"request_id": payload.get("id")},
        )

    def translate_native(
        self,
        document: TranscriptDocument,
        model: str,
        target_language: str,
    ) -> TranscriptDocument | None:
        if model != "whisper-1":
            return None
        translated_segments: list[TranscriptSegment] = []
        for segment in document.segments:
            translated_segments.append(segment.model_copy(update={"translated_text": segment.text}))
        return document.model_copy(update={"segments": translated_segments})


@dataclass
class ElevenLabsScribeAdapter:
    api_key: str
    provider: str = "elevenlabs-scribe"

    def transcribe(
        self,
        file_path: Path,
        model: str,
        source_language: str = "auto",
        diarization_enabled: bool = False,
        speaker_count: int | None = None,
    ) -> TranscriptDocument:
        with file_path.open("rb") as handle:
            data: dict[str, Any] = {"model_id": model}
            if source_language != "auto":
                data["language_code"] = source_language
            if diarization_enabled:
                data["diarize"] = "true"
            if speaker_count is not None:
                data["num_speakers"] = str(speaker_count)
            payload = _provider_request(
                "POST",
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={"xi-api-key": self.api_key},
                files={"file": (file_path.name, handle)},
                data=data,
            )
        segments_raw = payload.get("segments") or payload.get("words") or []
        segments: list[TranscriptSegment] = []
        for idx, item in enumerate(segments_raw, start=1):
            text = str(item.get("text") or item.get("word") or "").strip()
            if not text:
                continue
            segments.append(
                TranscriptSegment(
                    id=idx,
                    start=float(item.get("start", item.get("start_time", 0.0))),
                    end=float(item.get("end", item.get("end_time", 0.0))),
                    text=text,
                    speaker=str(item.get("speaker")) if item.get("speaker") is not None else None,
                )
            )
        if not segments:
            segments = _single_segment_from_text(str(payload.get("text", "")))
        return TranscriptDocument(
            provider=self.provider,
            model=model,
            detected_language=payload.get("language_code") or payload.get("language"),
            segments=segments,
        )


@dataclass
class DeepgramAdapter:
    api_key: str
    provider: str = "deepgram"

    def transcribe(
        self,
        file_path: Path,
        model: str,
        source_language: str = "auto",
        diarization_enabled: bool = False,
        speaker_count: int | None = None,
    ) -> TranscriptDocument:
        del speaker_count
        url = (
            f"https://api.deepgram.com/v1/listen?model={model}"
            "&punctuate=true&smart_format=true"
            f"&diarize={'true' if diarization_enabled else 'false'}"
        )
        if source_language != "auto":
            url += f"&language={source_language}"
        with file_path.open("rb") as handle:
            payload = _provider_request(
                "POST",
                url,
                headers={"Authorization": f"Token {self.api_key}", "Content-Type": "application/octet-stream"},
                data=handle.read(),
            )
        channel = ((payload.get("results") or {}).get("channels") or [{}])[0]
        alternative = (channel.get("alternatives") or [{}])[0]
        words = alternative.get("words") or []
        segments = _build_segments_from_words(words)
        if not segments:
            segments = _single_segment_from_text(str(alternative.get("transcript", "")))
        return TranscriptDocument(
            provider=self.provider,
            model=model,
            detected_language=payload.get("results", {}).get("detected_language"),
            segments=segments,
        )

    def translate_native(
        self,
        document: TranscriptDocument,
        model: str,
        target_language: str,
    ) -> TranscriptDocument | None:
        del model
        translated_segments: list[TranscriptSegment] = []
        for segment in document.segments:
            payload = _provider_request(
                "POST",
                "https://api.deepgram.com/v1/translate",
                headers={"Authorization": f"Token {self.api_key}"},
                json_payload={"text": segment.text, "target_language": target_language},
            )
            translated_text = str(payload.get("translated_text", "")).strip() or segment.text
            translated_segments.append(segment.model_copy(update={"translated_text": translated_text}))
        return document.model_copy(update={"segments": translated_segments})


def build_provider_adapter(provider: str, api_key: str | None = None, model_cache_dir: Path | None = None) -> ProviderAdapter:
    if provider == "whisper-local":
        return WhisperLocalAdapter(model_cache_dir=model_cache_dir)
    if provider == "openai":
        if not api_key:
            raise RuntimeError("openai provider requires an API key")
        return OpenAIAdapter(api_key=api_key)
    if provider == "elevenlabs-scribe":
        if not api_key:
            raise RuntimeError("elevenlabs-scribe provider requires an API key")
        return ElevenLabsScribeAdapter(api_key=api_key)
    if provider == "deepgram":
        if not api_key:
            raise RuntimeError("deepgram provider requires an API key")
        return DeepgramAdapter(api_key=api_key)
    raise ValueError(f"unsupported provider '{provider}'")
