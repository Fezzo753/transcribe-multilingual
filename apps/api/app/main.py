from __future__ import annotations

import asyncio
from contextlib import suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import router as api_router
from app.config import get_settings
from app.dependencies import get_db, get_job_service, get_storage
from app.ui import router as ui_router


settings = get_settings()
app = FastAPI(title="Transcribe Multilingual", version="0.1.0")

origins = [item.strip() for item in settings.cors_origins.split(",") if item.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
app.include_router(ui_router)

_cleanup_task: asyncio.Task | None = None


async def _periodic_cleanup() -> None:
    while True:
        try:
            get_job_service().cleanup_expired()
        except Exception:
            pass
        await asyncio.sleep(max(60, settings.cleanup_interval_minutes * 60))


@app.on_event("startup")
async def startup() -> None:
    get_db()
    get_storage()
    global _cleanup_task
    if _cleanup_task is None:
        _cleanup_task = asyncio.create_task(_periodic_cleanup())


@app.on_event("shutdown")
async def shutdown() -> None:
    global _cleanup_task
    if _cleanup_task is not None:
        _cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await _cleanup_task
        _cleanup_task = None
