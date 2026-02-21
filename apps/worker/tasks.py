from __future__ import annotations

from app.dependencies import get_job_service


def process_job_task(job_id: str) -> dict:
    response = get_job_service().process_job(job_id)
    return response.model_dump(mode="json")


def cleanup_task() -> dict:
    removed = get_job_service().cleanup_expired()
    return {"removed": removed}
