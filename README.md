# Transcribe Multilingual

Python-first multilingual transcription and translation platform with:

- Local Whisper (`faster-whisper`)
- OpenAI transcription
- ElevenLabs Scribe
- Deepgram

It provides a FastAPI backend, an RQ worker, and a React web UI.

## Features

- Upload audio/video and transcribe with a selected provider/model
- Optional translation to a target language
- Optional diarization and speaker count when supported
- Output formats: `srt`, `vtt`, `html`, `txt`, `json`
- Download individual artifacts or all selected outputs in a ZIP
- Encrypted API key persistence in local settings DB
- Hybrid processing model: sync for small jobs, async queue for larger jobs

## Quick start (local)

1. Install Python dependencies:

```bash
pip install -e ".[dev,local-whisper]"
```

2. Start Redis (required for async queue):

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

3. Start API:

```bash
uvicorn app.main:app --reload --app-dir apps/api
```

4. Start worker (separate shell):

```bash
python -m apps.worker.run_worker
```

5. Start web app:

```bash
cd apps/web
npm install
npm run dev
```

## Cloudflare profile

See `deploy/cloudflare/README.md`. In Cloudflare mode, `whisper-local` is intentionally disabled.

