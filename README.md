# Transcribe Multilingual

Dual-profile multilingual transcription and translation platform.

## Runtime Profiles

1. Local profile:
- FastAPI API + server-rendered UI
- Redis/RQ worker for async jobs
- SQLite metadata store
- Local filesystem storage
- Local Whisper (`faster-whisper`) + API providers

2. Cloudflare profile:
- Cloudflare Worker (Hono)
- D1 metadata store
- R2 storage
- Queues for async jobs
- Provider APIs only (`whisper-local` disabled)

## Supported Providers

- `whisper-local` (local profile only)
- `openai`
- `elevenlabs-scribe` (`scribe_v1`, `scribe_v2`)
- `deepgram`

## Features

- Multi-file batch jobs
- Optional translation to target language with fallback order
- Outputs: `srt`, `vtt`, `html`, `txt`, `json`
- Source + translated variants where applicable
- ZIP bundle generation with flat prefixed naming
- Encrypted API key persistence
- Polling-based progress tracking
- Retention cleanup (default 7 days)

## Local Quick Start

1. Install dependencies:

```bash
pip install -e ".[dev,local-whisper]"
```

2. Start Redis:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

3. Start API:

```bash
uvicorn app.main:app --reload --app-dir apps/api
```

4. Start worker:

```bash
python -m apps.worker.run_worker
```

5. Open UI:

- Jobs list: `http://localhost:8000/jobs`
- New job: `http://localhost:8000/jobs/new`
- Settings: `http://localhost:8000/settings`

## API Endpoints (local + cloud)

- `GET /api/capabilities`
- `GET /api/settings/keys`
- `PUT /api/settings/keys/{provider}`
- `DELETE /api/settings/keys/{provider}`
- `GET /api/settings/app`
- `PUT /api/settings/app`
- `POST /api/jobs`
- `POST /api/jobs/from-folder` (local only)
- `GET /api/jobs`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/artifacts`
- `GET /api/jobs/{job_id}/artifacts/{artifact_id}`
- `GET /api/jobs/{job_id}/bundle.zip`
- `POST /api/jobs/{job_id}/cancel`

## Deployment

- Local details: `deploy/local/README.md`
- Cloudflare details: `deploy/cloudflare/README.md`
