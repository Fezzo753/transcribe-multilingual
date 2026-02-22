# Transcribe Multilingual

Multilingual transcription + translation app with two runtime profiles:

- Local profile: FastAPI API + server-rendered UI + SQLite + Redis/RQ + local filesystem artifacts.
- Cloudflare profile: TypeScript Worker (Hono) + D1 + R2 + Queues + Cron cleanup.

## What Is Implemented

- Provider adapters: `whisper-local` (local only), `openai`, `elevenlabs-scribe`, `deepgram`.
- Provider-model compatible selection in UI.
- Multi-file batch upload jobs in local and cloud profiles.
- Local folder ingestion (`/api/jobs/from-folder`) in local profile only.
- Optional translation with fallback order: `native -> openai -> deepgram`.
- Job options: diarization, speaker count, timestamp level (`segment` or `word`), translation on/off, target language, verbose output, sync preference.
- Output formats: `srt`, `vtt`, `html`, `txt`, `json`.
- Source and translated artifact variants where applicable.
- Flat ZIP export with prefixed filenames and `job_manifest.json`.
- Polling-based status updates.
- Encrypted API key persistence at rest.
- Retention cleanup (default 7 days).

## Provider and Model Support

- `whisper-local`: `tiny`, `small`, `medium` (disabled in cloud profile).
- `openai`: `gpt-4o-mini-transcribe`, `whisper-1`.
- `elevenlabs-scribe`: `scribe_v1`, `scribe_v2`.
- `deepgram`: `nova-3`.

## Repository Layout

- `apps/api`: local FastAPI API and server-rendered UI.
- `apps/worker`: RQ worker entrypoints and background tasks.
- `packages/core/tm_core`: shared schemas, capabilities, adapters, formatters, translation, artifact utilities.
- `deploy/cloudflare`: Worker source, schema, Wrangler config, tests.
- `deploy/local`: local deployment notes.
- `tests`: unit, integration, and e2e tests for the Python/local profile.

## Local Profile Quickstart

Prerequisites:

- Python 3.12+
- Redis

Install:

```bash
pip install -e ".[dev]"
```

Install local Whisper support:

```bash
pip install -e ".[local-whisper]"
```

Start Redis:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

Run API:

```bash
uvicorn app.main:app --reload --app-dir apps/api
```

Run worker:

```bash
python -m apps.worker.run_worker
```

Open UI:

- `http://localhost:8000/jobs`
- `http://localhost:8000/jobs/new`
- `http://localhost:8000/settings`

## Local Profile Environment Variables (`TM_*`)

- `TM_APP_MODE`: defaults to `local`.
- `TM_DB_PATH`: defaults to `data/app.db`.
- `TM_STORAGE_DIR`: defaults to `data/storage`.
- `TM_TEMP_DIR`: defaults to `data/temp`.
- `TM_KEY_FILE_PATH`: defaults to `~/.transcribe-multilingual/secret.key`.
- `TM_REDIS_URL`: defaults to `redis://localhost:6379/0`.
- `TM_RQ_QUEUE_NAME`: defaults to `transcribe`.
- `TM_SYNC_SIZE_THRESHOLD_MB`: defaults to `20`.
- `TM_RETENTION_DAYS`: defaults to `7`.
- `TM_CLEANUP_INTERVAL_MINUTES`: defaults to `60`.
- `TM_TRANSLATION_FALLBACK_ORDER`: defaults to `native,openai,deepgram`.
- `TM_LOCAL_FOLDER_ALLOWLIST`: comma-separated allowed roots for `/api/jobs/from-folder`.
- `TM_OPENAI_TRANSLATION_MODEL`: defaults to `gpt-4o-mini`.
- `TM_CORS_ORIGINS`: defaults to `*`.

## Cloudflare Profile Deployment

From `deploy/cloudflare`:

```bash
npm install
```

Create resources in Cloudflare:

- D1 database
- R2 bucket
- Queue

Apply schema:

```bash
wrangler d1 execute transcribe-multilingual --file=./schema.sql
```

Update `deploy/cloudflare/wrangler.toml` bindings and IDs:

- `[[d1_databases]]` for `DB`
- `[[r2_buckets]]` for `STORAGE`
- `[[queues.producers]]` and `[[queues.consumers]]` for `JOB_QUEUE`

Set encryption key secret:

```bash
wrangler secret put TM_ENCRYPTION_KEY
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

Cloud profile behavior:

- `whisper-local` is disabled.
- `/api/jobs/from-folder` returns an error (local-only feature).

## API Surface

Common:

- `GET /api/capabilities`
- `GET /api/settings/keys`
- `PUT /api/settings/keys/{provider}`
- `DELETE /api/settings/keys/{provider}`
- `GET /api/settings/app`
- `PUT /api/settings/app`
- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/artifacts`
- `GET /api/jobs/{job_id}/artifacts/{artifact_id}`
- `GET /api/jobs/{job_id}/bundle.zip`
- `POST /api/jobs/{job_id}/cancel`

Local only:

- `POST /api/jobs/from-folder`

## Job Options and Output Behavior

Job options accepted by API/UI:

- `provider`, `model`
- `source_language`, `target_language`
- `translation_enabled`
- `diarization_enabled`, `speaker_count`
- `timestamp_level` (`segment` or `word`)
- `verbose_output`
- `sync_preferred`
- `formats`

Format handling:

- `srt`, `vtt`, `txt`: source artifact plus translated artifact when translated text exists.
- `html`: combined side-by-side output.
- `json`: combined output with transcript metadata and translated text fields when available.

Artifact naming per input prefix:

- `{prefix}__source.srt`
- `{prefix}__translated.srt`
- `{prefix}__source.vtt`
- `{prefix}__translated.vtt`
- `{prefix}__source.txt`
- `{prefix}__translated.txt`
- `{prefix}__combined.html`
- `{prefix}__transcript.json`

Bundle output:

- `{job_id}.zip` with artifacts and `job_manifest.json`.

## Security Model

- Single-user deployment assumption.
- API keys are encrypted at rest in DB.
- Local profile auto-generates a key file if missing.
- Cloudflare profile requires `TM_ENCRYPTION_KEY` secret.

## Testing

Python/local tests:

```bash
pytest -q
```

Cloudflare tests:

```bash
npm --prefix deploy/cloudflare test
```
