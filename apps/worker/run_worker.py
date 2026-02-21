from __future__ import annotations

from redis import Redis
from rq import Connection, Worker

from app.config import get_settings


def main() -> None:
    settings = get_settings()
    redis_conn = Redis.from_url(settings.redis_url)
    with Connection(redis_conn):
        worker = Worker([settings.rq_queue_name])
        worker.work(with_scheduler=True)


if __name__ == "__main__":
    main()
