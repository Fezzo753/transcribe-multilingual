# Transcribe Multilingual

Multilingual transcription + translation platform with dual runtime profiles:

- Local profile: FastAPI + server-rendered UI + SQLite + Redis/RQ + local filesystem storage
- Cloudflare profile: Worker (Hono) + D1 + R2 + Queues + Cron cleanup

## Plan Status

The implementation plan is completed in this repo:

- Shared core contracts/utilities: done (`packages/core/tm_core`)
- Local API/UI/worker pipeline: done (`apps/api`, `apps/worker`)
- Cloudflare Worker API/UI/queue pipeline: done (`deploy/cloudflare`)
- Provider adapters and fallback translation orchestration: done
- Source/translated artifact generation + ZIP bundles: done
- Encrypted API key persistence (local file key / cloud secret key): done
- Retention cleanup jobs (local periodic + cloud cron): done
- Test coverage for unit, integration, and e2e flows: done

## Supported Providers

- `whisper-local` (local profile only)
- `openai`
- `elevenlabs-scribe` (`scribe_v1`, `scribe_v2`)
- `deepgram`

## Core Features

- Multi-file batch jobs
- Optional translation to target language
- Fallback order: `native -> openai -> deepgram` (configurable)
- Output formats: `srt`, `vtt`, `html`, `txt`, `json`
- Source + translated variants for subtitle/text outputs
- Combined HTML + JSON transcript outputs
- Flat ZIP bundle naming with manifest (`job_manifest.json`)
- Polling-based progress/status APIs
- 7-day retention cleanup (default)

## Repository Layout

- `apps/api`: FastAPI backend + server-rendered UI
- `apps/worker`: RQ worker tasks
- `packages/core/tm_core`: shared schemas, formatters, adapters, capabilities, translation, artifacts
- `deploy/cloudflare`: Worker runtime, schema, config, tests
- `deploy/local`: local deployment notes
- `tests/unit`, `tests/integration`, `tests/e2e`: Python test suites

## Local Setup

1. Install dependencies:

```bash
pip install -e ".[dev,local-whisper]"
```

2. Run Redis:

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

- `http://localhost:8000/jobs`
- `http://localhost:8000/jobs/new`
- `http://localhost:8000/settings`

## Cloudflare Setup

See `deploy/cloudflare/README.md`.

Key files:

- Worker app: `deploy/cloudflare/src/index.ts`
- D1 schema: `deploy/cloudflare/schema.sql`
- Wrangler config: `deploy/cloudflare/wrangler.toml`

Cloud mode intentionally disables:

- `whisper-local`
- `/api/jobs/from-folder`

## API Surface

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

## Security and Key Storage

- Local mode:
  - Generates/uses a local Fernet key file (`TM_KEY_FILE_PATH`)
  - Stores encrypted provider API keys in SQLite
- Cloud mode:
  - Requires `TM_ENCRYPTION_KEY` secret
  - Stores encrypted provider API keys in D1

## Artifact Naming

Per file prefix (`{safe_input_prefix}`):

- `{prefix}__source.srt`
- `{prefix}__translated.srt` (when translation is available)
- `{prefix}__source.vtt`
- `{prefix}__translated.vtt` (when translation is available)
- `{prefix}__source.txt`
- `{prefix}__translated.txt` (when translation is available)
- `{prefix}__combined.html`
- `{prefix}__transcript.json`

Bundle output:

- `{job_id}.zip`
- contains all generated artifacts + `job_manifest.json`

## Testing

Python tests:

```bash
pytest -q
```

Cloudflare tests:

```bash
npm --prefix deploy/cloudflare test
```

Current expected status:

- Python: `20 passed`
- Cloudflare Vitest: `5 passed`
