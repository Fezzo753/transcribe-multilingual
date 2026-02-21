from __future__ import annotations

from dataclasses import dataclass

from app.config import Settings


@dataclass
class QueueDispatcher:
    settings: Settings

    def _queue(self):
        try:
            from redis import Redis  # type: ignore
            from rq import Queue  # type: ignore
        except ModuleNotFoundError as exc:  # pragma: no cover - dependency availability
            raise RuntimeError("Queue dependencies are not installed; install redis and rq.") from exc
        redis_conn = Redis.from_url(self.settings.redis_url)
        return Queue(name=self.settings.rq_queue_name, connection=redis_conn)

    def enqueue_job(self, job_id: str) -> str:
        queue = self._queue()
        job = queue.enqueue("apps.worker.tasks.process_job_task", kwargs={"job_id": job_id})
        return str(job.id)

    def enqueue_cleanup(self) -> str:
        queue = self._queue()
        job = queue.enqueue("apps.worker.tasks.cleanup_task")
        return str(job.id)
