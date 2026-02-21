from __future__ import annotations

from functools import lru_cache

from app.config import Settings, get_settings
from app.crypto import EncryptionService
from app.db import Database
from app.jobs import JobService
from app.providers import ProviderManager
from app.queueing import QueueDispatcher
from app.storage import StorageService


@lru_cache(maxsize=1)
def get_db() -> Database:
    settings = get_settings()
    db = Database(settings.db_path)
    db.initialize()
    return db


@lru_cache(maxsize=1)
def get_crypto() -> EncryptionService:
    return EncryptionService(get_settings())


@lru_cache(maxsize=1)
def get_storage() -> StorageService:
    settings = get_settings()
    return StorageService(settings.storage_dir)


@lru_cache(maxsize=1)
def get_provider_manager() -> ProviderManager:
    return ProviderManager(get_settings(), get_db(), get_crypto())


@lru_cache(maxsize=1)
def get_queue_dispatcher() -> QueueDispatcher:
    return QueueDispatcher(get_settings())


@lru_cache(maxsize=1)
def get_job_service() -> JobService:
    return JobService(
        settings=get_settings(),
        db=get_db(),
        storage=get_storage(),
        providers=get_provider_manager(),
        queue_dispatcher=get_queue_dispatcher(),
    )


def resolve_settings() -> Settings:
    return get_settings()
