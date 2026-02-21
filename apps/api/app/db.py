from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    provider TEXT PRIMARY KEY,
    encrypted_key TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    source_language TEXT NOT NULL,
    target_language TEXT,
    translation_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    options_json TEXT,
    warning_json TEXT,
    error_json TEXT,
    result_json TEXT
);

CREATE TABLE IF NOT EXISTS job_files (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    input_name TEXT NOT NULL,
    input_source TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    status TEXT NOT NULL,
    detected_language TEXT,
    duration_sec REAL,
    warning_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    file_id TEXT,
    format TEXT NOT NULL,
    variant TEXT,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(file_id) REFERENCES job_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_files_job_id ON job_files(job_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_job_id ON artifacts(job_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_file_id ON artifacts(file_id);
"""


def utc_now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def _json_dump(value: Any | None) -> str | None:
    if value is None:
        return None
    return json.dumps(value)


def _json_load(value: str | None) -> Any | None:
    if not value:
        return None
    return json.loads(value)


class Database:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)

    def initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(SCHEMA_SQL)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def set_app_setting(self, key: str, value: str) -> None:
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, value, now),
            )
            conn.commit()

    def get_app_setting(self, key: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return None if row is None else str(row["value"])

    def upsert_api_key(self, provider: str, encrypted_key: str) -> None:
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO api_keys (provider, encrypted_key, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(provider) DO UPDATE SET
                    encrypted_key = excluded.encrypted_key,
                    updated_at = excluded.updated_at
                """,
                (provider, encrypted_key, now),
            )
            conn.commit()

    def delete_api_key(self, provider: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM api_keys WHERE provider = ?", (provider,))
            conn.commit()

    def get_api_key(self, provider: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT encrypted_key FROM api_keys WHERE provider = ?", (provider,)).fetchone()
        return None if row is None else str(row["encrypted_key"])

    def list_api_keys(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT provider, updated_at FROM api_keys ORDER BY provider ASC").fetchall()
        return [dict(row) for row in rows]

    def create_job(
        self,
        *,
        job_id: str,
        status: str,
        provider: str,
        model: str,
        source_language: str,
        target_language: str | None,
        translation_enabled: bool,
        options: dict[str, Any] | None = None,
    ) -> None:
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, status, provider, model, source_language, target_language,
                    translation_enabled, created_at, updated_at, options_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    status,
                    provider,
                    model,
                    source_language,
                    target_language,
                    int(translation_enabled),
                    now,
                    now,
                    _json_dump(options),
                ),
            )
            conn.commit()

    def update_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        warning: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        fields: list[str] = []
        params: list[Any] = []
        if status is not None:
            fields.append("status = ?")
            params.append(status)
        if warning is not None:
            fields.append("warning_json = ?")
            params.append(_json_dump(warning))
        if error is not None:
            fields.append("error_json = ?")
            params.append(_json_dump(error))
        if result is not None:
            fields.append("result_json = ?")
            params.append(_json_dump(result))
        fields.append("updated_at = ?")
        params.append(utc_now_iso())
        params.append(job_id)
        statement = f"UPDATE jobs SET {', '.join(fields)} WHERE id = ?"
        with self._connect() as conn:
            conn.execute(statement, params)
            conn.commit()

    def create_job_file(
        self,
        *,
        file_id: str,
        job_id: str,
        input_name: str,
        input_source: str,
        size_bytes: int,
        storage_path: str,
        status: str = "queued",
    ) -> None:
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO job_files (
                    id, job_id, input_name, input_source, size_bytes, storage_path, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (file_id, job_id, input_name, input_source, size_bytes, storage_path, status, now, now),
            )
            conn.commit()

    def update_job_file(
        self,
        file_id: str,
        *,
        status: str | None = None,
        detected_language: str | None = None,
        duration_sec: float | None = None,
        warning: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        fields: list[str] = []
        params: list[Any] = []
        if status is not None:
            fields.append("status = ?")
            params.append(status)
        if detected_language is not None:
            fields.append("detected_language = ?")
            params.append(detected_language)
        if duration_sec is not None:
            fields.append("duration_sec = ?")
            params.append(duration_sec)
        if warning is not None:
            fields.append("warning_json = ?")
            params.append(_json_dump(warning))
        if error is not None:
            fields.append("error_json = ?")
            params.append(_json_dump(error))
        fields.append("updated_at = ?")
        params.append(utc_now_iso())
        params.append(file_id)
        statement = f"UPDATE job_files SET {', '.join(fields)} WHERE id = ?"
        with self._connect() as conn:
            conn.execute(statement, params)
            conn.commit()

    def add_artifact(
        self,
        *,
        artifact_id: str,
        job_id: str,
        file_id: str | None,
        format_name: str,
        variant: str | None,
        name: str,
        mime_type: str,
        kind: str,
        storage_path: str,
        size_bytes: int,
    ) -> None:
        now = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO artifacts (
                    id, job_id, file_id, format, variant, name, mime_type, kind, storage_path, size_bytes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact_id,
                    job_id,
                    file_id,
                    format_name,
                    variant,
                    name,
                    mime_type,
                    kind,
                    storage_path,
                    size_bytes,
                    now,
                ),
            )
            conn.commit()

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["warning_json"] = _json_load(result.get("warning_json"))
        result["error_json"] = _json_load(result.get("error_json"))
        result["result_json"] = _json_load(result.get("result_json"))
        result["options_json"] = _json_load(result.get("options_json"))
        result["translation_enabled"] = bool(result["translation_enabled"])
        return result

    def list_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["warning_json"] = _json_load(item.get("warning_json"))
            item["error_json"] = _json_load(item.get("error_json"))
            item["result_json"] = _json_load(item.get("result_json"))
            item["options_json"] = _json_load(item.get("options_json"))
            item["translation_enabled"] = bool(item["translation_enabled"])
            result.append(item)
        return result

    def list_job_files(self, job_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM job_files WHERE job_id = ? ORDER BY created_at ASC",
                (job_id,),
            ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["warning_json"] = _json_load(item.get("warning_json"))
            item["error_json"] = _json_load(item.get("error_json"))
            result.append(item)
        return result

    def list_artifacts(self, job_id: str, file_id: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM artifacts WHERE job_id = ?"
        params: list[Any] = [job_id]
        if file_id is not None:
            query += " AND file_id = ?"
            params.append(file_id)
        query += " ORDER BY created_at ASC"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def get_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM artifacts WHERE id = ?", (artifact_id,)).fetchone()
        return None if row is None else dict(row)

    def delete_records_older_than(self, cutoff_iso: str) -> list[str]:
        with self._connect() as conn:
            artifact_rows = conn.execute(
                "SELECT storage_path FROM artifacts WHERE created_at < ?",
                (cutoff_iso,),
            ).fetchall()
            upload_rows = conn.execute(
                "SELECT storage_path FROM job_files WHERE updated_at < ? AND input_source = 'upload'",
                (cutoff_iso,),
            ).fetchall()
            paths = [str(row["storage_path"]) for row in artifact_rows]
            paths.extend(str(row["storage_path"]) for row in upload_rows)
            conn.execute("DELETE FROM artifacts WHERE created_at < ?", (cutoff_iso,))
            conn.execute("DELETE FROM job_files WHERE updated_at < ?", (cutoff_iso,))
            conn.execute("DELETE FROM jobs WHERE updated_at < ?", (cutoff_iso,))
            conn.commit()
        return paths
