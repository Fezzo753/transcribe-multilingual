# Cloudflare Deployment

This directory contains a Cloudflare Worker profile for `transcribe-multilingual`.

## Components

- Worker API + UI routes (Hono)
- D1 database for keys, jobs, files, artifacts
- R2 for uploads and output files
- Queues for async job execution
- Cron trigger for retention cleanup

## Setup

1. Install dependencies:

```bash
cd deploy/cloudflare
npm install
```

2. Create Cloudflare resources:

- D1 database
- R2 bucket
- Queue

3. Apply schema:

```bash
wrangler d1 execute transcribe-multilingual --file=./schema.sql
```

4. Configure `wrangler.toml` IDs and names.

5. Set secret for key encryption:

```bash
wrangler secret put TM_ENCRYPTION_KEY
```

Use a 32-byte random key encoded in base64.

6. Deploy:

```bash
npm run deploy
```

## Notes

- `whisper-local` is intentionally disabled in cloud mode.
- Cloud mode supports upload batch jobs (no local folder ingestion).
