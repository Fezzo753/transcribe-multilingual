import { beforeEach, describe, expect, it, vi } from "vitest";

import { app, applyTranslation, cleanupExpiredData, encryptSecret, parseRequestedFormats, processJob } from "./index";

type JobRecord = Record<string, unknown>;
type FileRecord = Record<string, unknown>;
type ArtifactRecord = Record<string, unknown>;

class FakeStatement {
  private args: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.args);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return this.db.all<T>(this.sql, this.args);
  }

  async run(): Promise<{ success: boolean }> {
    this.db.run(this.sql, this.args);
    return { success: true };
  }
}

class FakeD1 {
  settings = new Map<string, string>();
  apiKeys = new Map<string, { encrypted_key: string; updated_at: string }>();
  jobs = new Map<string, JobRecord>();
  files = new Map<string, FileRecord>();
  artifacts = new Map<string, ArtifactRecord>();
  cancelAfterFirstCompletion = false;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  private normalize(sql: string): string {
    return sql.replace(/\s+/g, " ").trim().toLowerCase();
  }

  private olderThan(value: unknown, cutoff: unknown): boolean {
    if (typeof value !== "string" || typeof cutoff !== "string") {
      return false;
    }
    return new Date(value).getTime() < new Date(cutoff).getTime();
  }

  first<T>(sql: string, args: unknown[]): T | null {
    const q = this.normalize(sql);
    if (q.startsWith("select value from app_settings where key = ?")) {
      const key = String(args[0]);
      const value = this.settings.get(key);
      return value == null ? null : ({ value } as T);
    }
    if (q.startsWith("select encrypted_key from api_keys where provider = ?")) {
      const provider = String(args[0]);
      const row = this.apiKeys.get(provider);
      return row ? ({ encrypted_key: row.encrypted_key } as T) : null;
    }
    if (q.startsWith("select * from jobs where id = ?")) {
      const job = this.jobs.get(String(args[0]));
      return (job as T) || null;
    }
    if (q.startsWith("select status from jobs where id = ?")) {
      const job = this.jobs.get(String(args[0]));
      return job ? ({ status: job.status } as T) : null;
    }
    if (q.includes("from artifacts where job_id = ? and kind = 'bundle'")) {
      const jobId = String(args[0]);
      const bundle = [...this.artifacts.values()].reverse().find((item) => item.job_id === jobId && item.kind === "bundle");
      return (bundle as T) || null;
    }
    if (q.startsWith("select * from artifacts where id = ? and job_id = ?")) {
      const artifactId = String(args[0]);
      const jobId = String(args[1]);
      const artifact = this.artifacts.get(artifactId);
      if (!artifact || artifact.job_id !== jobId) {
        return null;
      }
      return artifact as T;
    }
    return null;
  }

  all<T>(sql: string, args: unknown[]): { results: T[] } {
    const q = this.normalize(sql);
    if (q.startsWith("select * from job_files where job_id = ?")) {
      const jobId = String(args[0]);
      return { results: [...this.files.values()].filter((item) => item.job_id === jobId) as T[] };
    }
    if (q.startsWith("select * from artifacts where job_id = ?")) {
      const jobId = String(args[0]);
      return { results: [...this.artifacts.values()].filter((item) => item.job_id === jobId) as T[] };
    }
    if (q.startsWith("select * from jobs order by created_at desc limit 100")) {
      return { results: [...this.jobs.values()] as T[] };
    }
    if (q.startsWith("select provider, updated_at from api_keys order by provider asc")) {
      return {
        results: [...this.apiKeys.entries()].map(([provider, row]) => ({ provider, updated_at: row.updated_at } as T)),
      };
    }
    if (q.startsWith("select storage_path from artifacts where created_at < ?")) {
      const cutoff = args[0];
      return {
        results: [...this.artifacts.values()]
          .filter((item) => this.olderThan(item.created_at, cutoff))
          .map((item) => ({ storage_path: item.storage_path } as T)),
      };
    }
    if (q.startsWith("select storage_path from job_files where updated_at < ?")) {
      const cutoff = args[0];
      return {
        results: [...this.files.values()]
          .filter((item) => this.olderThan(item.updated_at, cutoff))
          .map((item) => ({ storage_path: item.storage_path } as T)),
      };
    }
    return { results: [] };
  }

  run(sql: string, args: unknown[]): void {
    const q = this.normalize(sql);
    if (q.startsWith("insert into app_settings")) {
      this.settings.set(String(args[0]), String(args[1]));
      return;
    }
    if (q.startsWith("insert into api_keys")) {
      this.apiKeys.set(String(args[0]), { encrypted_key: String(args[1]), updated_at: String(args[2]) });
      return;
    }
    if (q.startsWith("delete from api_keys where provider = ?")) {
      this.apiKeys.delete(String(args[0]));
      return;
    }
    if (q.startsWith("insert into jobs")) {
      this.jobs.set(String(args[0]), {
        id: String(args[0]),
        status: "queued",
        provider: String(args[1]),
        model: String(args[2]),
        source_language: String(args[3]),
        target_language: args[4] == null ? null : String(args[4]),
        translation_enabled: Number(args[5]),
        options_json: String(args[6]),
        created_at: String(args[7]),
        updated_at: String(args[8]),
        warning_json: null,
        error_json: null,
        result_json: null,
      });
      return;
    }
    if (q.startsWith("update jobs set status = 'running'")) {
      const updatedAt = String(args[0]);
      const jobId = String(args[1]);
      const job = this.jobs.get(jobId);
      if (job) {
        job.status = "running";
        job.updated_at = updatedAt;
      }
      return;
    }
    if (q.startsWith("update jobs set status = ?, error_json = ?, result_json = ?, updated_at = ? where id = ?")) {
      const job = this.jobs.get(String(args[4]));
      if (job) {
        job.status = String(args[0]);
        job.error_json = args[1] == null ? null : String(args[1]);
        job.result_json = String(args[2]);
        job.updated_at = String(args[3]);
      }
      return;
    }
    if (q.startsWith("update jobs set status = 'cancelled'")) {
      const job = this.jobs.get(String(args[1]));
      if (job) {
        job.status = "cancelled";
        job.updated_at = String(args[0]);
      }
      return;
    }
    if (q.startsWith("insert into job_files")) {
      this.files.set(String(args[0]), {
        id: String(args[0]),
        job_id: String(args[1]),
        input_name: String(args[2]),
        input_source: "upload",
        size_bytes: Number(args[3]),
        storage_path: String(args[4]),
        status: "queued",
        detected_language: null,
        warning_json: null,
        error_json: null,
        created_at: String(args[5]),
        updated_at: String(args[6]),
      });
      return;
    }
    if (q.startsWith("update job_files set status = 'running'")) {
      const row = this.files.get(String(args[1]));
      if (row) {
        row.status = "running";
        row.updated_at = String(args[0]);
      }
      return;
    }
    if (q.startsWith("update job_files set status = 'completed'")) {
      const row = this.files.get(String(args[2]));
      if (row) {
        row.status = "completed";
        row.detected_language = args[0] == null ? null : String(args[0]);
        row.updated_at = String(args[1]);
        if (this.cancelAfterFirstCompletion) {
          const job = this.jobs.get(String(row.job_id));
          if (job) {
            job.status = "cancelled";
          }
          this.cancelAfterFirstCompletion = false;
        }
      }
      return;
    }
    if (q.startsWith("update job_files set status = 'failed'")) {
      const row = this.files.get(String(args[2]));
      if (row) {
        row.status = "failed";
        row.error_json = String(args[0]);
        row.updated_at = String(args[1]);
      }
      return;
    }
    if (q.startsWith("update job_files set status = 'cancelled'")) {
      const jobId = String(args[1]);
      for (const row of this.files.values()) {
        if (row.job_id === jobId && (row.status === "queued" || row.status === "running")) {
          row.status = "cancelled";
          row.updated_at = String(args[0]);
        }
      }
      return;
    }
    if (q.startsWith("insert into artifacts")) {
      this.artifacts.set(String(args[0]), {
        id: String(args[0]),
        job_id: String(args[1]),
        file_id: args[2] == null ? null : String(args[2]),
        format: String(args[3]),
        variant: args[4] == null ? null : String(args[4]),
        name: String(args[5]),
        mime_type: String(args[6]),
        kind: String(args[7]),
        storage_path: String(args[8]),
        size_bytes: Number(args[9]),
        created_at: String(args[10]),
      });
      return;
    }
    if (q.startsWith("delete from artifacts where created_at < ?")) {
      const cutoff = args[0];
      for (const [id, artifact] of this.artifacts.entries()) {
        if (this.olderThan(artifact.created_at, cutoff)) {
          this.artifacts.delete(id);
        }
      }
      return;
    }
    if (q.startsWith("delete from job_files where updated_at < ?")) {
      const cutoff = args[0];
      for (const [id, file] of this.files.entries()) {
        if (this.olderThan(file.updated_at, cutoff)) {
          this.files.delete(id);
        }
      }
      return;
    }
    if (q.startsWith("delete from jobs where updated_at < ?")) {
      const cutoff = args[0];
      for (const [id, job] of this.jobs.entries()) {
        if (this.olderThan(job.updated_at, cutoff)) {
          this.jobs.delete(id);
        }
      }
      return;
    }
  }
}

class FakeR2Object {
  constructor(private readonly bytes: Uint8Array, readonly httpMetadata: { contentType?: string } = {}) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength) as ArrayBuffer;
  }
}

class FakeR2Bucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: { contentType?: string } }>();
  deleted: string[] = [];

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    let bytes: Uint8Array;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      bytes = new Uint8Array();
    }
    this.objects.set(key, { bytes, metadata: { contentType: options?.httpMetadata?.contentType } });
  }

  async get(key: string): Promise<FakeR2Object | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    return new FakeR2Object(found.bytes, found.metadata);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

class FakeQueue {
  sent: unknown[] = [];

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }
}

function createEnv() {
  return {
    DB: new FakeD1(),
    STORAGE: new FakeR2Bucket(),
    JOB_QUEUE: new FakeQueue(),
    APP_MODE: "cloudflare",
    SYNC_SIZE_THRESHOLD_MB: "20",
    RETENTION_DAYS: "7",
    TRANSLATION_FALLBACK_ORDER: "native,openai,deepgram",
    TM_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  };
}

describe("cloudflare worker fixes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("PUT /api/settings/app returns json without redirect", async () => {
    const env = createEnv();
    const response = await app.request(
      "http://worker.local/api/settings/app",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sync_size_threshold_mb: 42,
          retention_days: 10,
          translation_fallback_order: ["openai", "deepgram"],
        }),
      },
      env as never,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.sync_size_threshold_mb).toBe(42);
    expect(payload.retention_days).toBe(10);
  });

  it("renders settings page with provider API key controls", async () => {
    const env = createEnv();
    const response = await app.request("http://worker.local/settings", { method: "GET" }, env as never);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Provider API keys are encrypted at rest");
    expect(html).toContain('data-provider="openai"');
    expect(html).toContain('data-provider="elevenlabs-scribe"');
    expect(html).toContain('data-provider="deepgram"');
    expect(html).toContain('class="save-key"');
    expect(html).toContain('class="delete-key"');
    expect(html).toContain("/api/settings/keys");
  });

  it("translation fallback continues to deepgram when openai fails", async () => {
    const env = createEnv();
    env.DB.settings.set("translation_fallback_order", "openai,deepgram");
    env.DB.apiKeys.set("openai", { encrypted_key: await encryptSecret(env.TM_ENCRYPTION_KEY, "openai-key"), updated_at: new Date().toISOString() });
    env.DB.apiKeys.set("deepgram", {
      encrypted_key: await encryptSecret(env.TM_ENCRYPTION_KEY, "deepgram-key"),
      updated_at: new Date().toISOString(),
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "upstream failure" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ translated_text: "bonjour" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock as never);

    const translated = await applyTranslation(
      env as never,
      "openai",
      { provider: "openai", model: "gpt-4o-mini-transcribe", segments: [{ id: 1, start: 0, end: 1, text: "hello" }] },
      "fr",
      "en",
    );
    expect(translated.segments[0].translated_text).toBe("bonjour");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid output formats", async () => {
    expect(() => parseRequestedFormats("txt,json,srt")).not.toThrow();
    expect(() => parseRequestedFormats("txt,not-real")).toThrow("unsupported output format");

    const env = createEnv();
    const form = new FormData();
    form.set("provider", "openai");
    form.set("model", "gpt-4o-mini-transcribe");
    form.set("formats", "txt,not-real");
    form.set("files", new File([new Uint8Array([1, 2, 3])], "sample.wav", { type: "audio/wav" }));
    const response = await app.request("http://worker.local/api/jobs", { method: "POST", body: form }, env as never);
    expect(response.status).toBe(400);
  });

  it("renders jobs/new with provider-model mapping and advanced controls", async () => {
    const env = createEnv();
    const response = await app.request("http://worker.local/jobs/new", { method: "GET" }, env as never);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="provider-select"');
    expect(html).toContain('id="model-select"');
    expect(html).toContain('name="formats" value="srt"');
    expect(html).toContain('name="timestamp_level"');
    expect(html).toContain('id="translation-enabled"');
    expect(html).toContain('id="diarization-enabled"');
    expect(html).toContain('id="verbose-output"');
    expect(html).toContain('id="copy-job-response"');
    expect(html).toContain('id="open-created-job"');
    expect(html).toContain('id="download-created-bundle"');
    expect(html).toContain('"openai":["gpt-4o-mini-transcribe","whisper-1"]');
  });

  it("renders jobs page with output copy and download controls", async () => {
    const env = createEnv();
    const response = await app.request("http://worker.local/jobs", { method: "GET" }, env as never);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="jobs-table-body"');
    expect(html).toContain('id="job-output"');
    expect(html).toContain('id="copy-job-output"');
    expect(html).toContain('id="job-downloads"');
    expect(html).toContain("/api/jobs/");
    expect(html).toContain("Download Bundle (.zip)");
  });

  it("stores advanced job options when using checkbox-style form fields", async () => {
    const env = createEnv();
    const form = new FormData();
    form.set("provider", "openai");
    form.set("model", "whisper-1");
    form.set("source_language", "en");
    form.set("translation_enabled", "true");
    form.set("target_language", "fr");
    form.set("diarization_enabled", "true");
    form.set("speaker_count", "2");
    form.set("timestamp_level", "word");
    form.set("verbose_output", "true");
    form.set("sync_preferred", "false");
    form.append("formats", "txt");
    form.append("formats", "json");
    form.set("files", new File([new Uint8Array([1, 2, 3])], "sample.wav", { type: "audio/wav" }));

    const response = await app.request("http://worker.local/api/jobs", { method: "POST", body: form }, env as never);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string };
    const job = env.DB.jobs.get(payload.id);
    expect(job).toBeTruthy();
    expect(job?.translation_enabled).toBe(1);
    const options = JSON.parse(String(job?.options_json)) as Record<string, unknown>;
    expect(options.formats).toEqual(["txt", "json"]);
    expect(options.diarization_enabled).toBe(true);
    expect(options.speaker_count).toBe(2);
    expect(options.timestamp_level).toBe("word");
    expect(options.verbose_output).toBe(true);
    expect(options.sync_preferred).toBe(false);
  });

  it("rejects model values that are incompatible with provider", async () => {
    const env = createEnv();
    const form = new FormData();
    form.set("provider", "deepgram");
    form.set("model", "whisper-1");
    form.append("formats", "txt");
    form.set("files", new File([new Uint8Array([1, 2, 3])], "sample.wav", { type: "audio/wav" }));
    const response = await app.request("http://worker.local/api/jobs", { method: "POST", body: form }, env as never);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(String(payload.error || "")).toContain("unsupported model");
  });

  it("stops processing additional files after cancellation is observed", async () => {
    const env = createEnv();
    const now = new Date().toISOString();
    env.DB.jobs.set("job-1", {
      id: "job-1",
      status: "queued",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      source_language: "auto",
      target_language: null,
      translation_enabled: 0,
      options_json: JSON.stringify({ formats: ["txt"] }),
      created_at: now,
      updated_at: now,
      warning_json: null,
      error_json: null,
      result_json: null,
    });
    env.DB.files.set("file-1", {
      id: "file-1",
      job_id: "job-1",
      input_name: "one.wav",
      input_source: "upload",
      size_bytes: 10,
      storage_path: "uploads/job-1/file-1/one.wav",
      status: "queued",
      detected_language: null,
      warning_json: null,
      error_json: null,
      created_at: now,
      updated_at: now,
    });
    env.DB.files.set("file-2", {
      id: "file-2",
      job_id: "job-1",
      input_name: "two.wav",
      input_source: "upload",
      size_bytes: 10,
      storage_path: "uploads/job-1/file-2/two.wav",
      status: "queued",
      detected_language: null,
      warning_json: null,
      error_json: null,
      created_at: now,
      updated_at: now,
    });
    await env.STORAGE.put("uploads/job-1/file-1/one.wav", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "audio/wav" },
    });
    await env.STORAGE.put("uploads/job-1/file-2/two.wav", new Uint8Array([4, 5, 6]), {
      httpMetadata: { contentType: "audio/wav" },
    });
    env.DB.apiKeys.set("openai", { encrypted_key: await encryptSecret(env.TM_ENCRYPTION_KEY, "openai-key"), updated_at: now });
    env.DB.cancelAfterFirstCompletion = true;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "hello world", language: "en" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as never);

    await processJob(env as never, "job-1");
    expect(env.DB.files.get("file-1")?.status).toBe("completed");
    expect(env.DB.files.get("file-2")?.status).toBe("queued");
    expect(env.DB.jobs.get("job-1")?.status).toBe("cancelled");
    const hasBundle = [...env.DB.artifacts.values()].some((artifact) => artifact.kind === "bundle");
    expect(hasBundle).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cleanup removes both artifact and upload objects", async () => {
    const env = createEnv();
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    env.DB.artifacts.set("art-1", {
      id: "art-1",
      job_id: "job-old",
      file_id: "file-old",
      format: "txt",
      variant: "source",
      name: "old.txt",
      mime_type: "text/plain",
      kind: "source",
      storage_path: "artifacts/job-old/file-old/old.txt",
      size_bytes: 10,
      created_at: old,
    });
    env.DB.files.set("file-old", {
      id: "file-old",
      job_id: "job-old",
      input_name: "old.wav",
      input_source: "upload",
      size_bytes: 10,
      storage_path: "uploads/job-old/file-old/old.wav",
      status: "completed",
      detected_language: "en",
      warning_json: null,
      error_json: null,
      created_at: old,
      updated_at: old,
    });
    env.DB.jobs.set("job-old", {
      id: "job-old",
      status: "completed",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      source_language: "auto",
      target_language: null,
      translation_enabled: 0,
      options_json: "{}",
      created_at: old,
      updated_at: old,
      warning_json: null,
      error_json: null,
      result_json: "{}",
    });
    await env.STORAGE.put("artifacts/job-old/file-old/old.txt", "artifact");
    await env.STORAGE.put("uploads/job-old/file-old/old.wav", "upload");

    await cleanupExpiredData(env as never);
    expect(env.STORAGE.deleted).toContain("artifacts/job-old/file-old/old.txt");
    expect(env.STORAGE.deleted).toContain("uploads/job-old/file-old/old.wav");
  });
});
