# Local Deployment

Local profile runs:

- FastAPI API + server-rendered UI
- Redis + RQ worker for async jobs
- SQLite metadata store
- Filesystem storage for uploads/artifacts/bundles

## Run

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
