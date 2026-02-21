diff --git a/c:\Users\feroziftikhar\transcribe-multilingual\deploy/cloudflare/src/index.ts b/c:\Users\feroziftikhar\transcribe-multilingual\deploy/cloudflare/src/index.ts
new file mode 100644
--- /dev/null
+++ b/c:\Users\feroziftikhar\transcribe-multilingual\deploy/cloudflare/src/index.ts
@@ -0,0 +1,1147 @@
+import JSZip from "jszip";
+import { Hono } from "hono";
+import { cors } from "hono/cors";
+
+type ProviderName = "openai" | "elevenlabs-scribe" | "deepgram";
+type OutputFormat = "srt" | "vtt" | "html" | "txt" | "json";
+type ArtifactKind = "source" | "translated" | "combined" | "bundle";
+
+type Env = {
+  DB: D1Database;
+  STORAGE: R2Bucket;
+  JOB_QUEUE: Queue;
+  APP_MODE: string;
+  SYNC_SIZE_THRESHOLD_MB: string;
+  RETENTION_DAYS: string;
+  TRANSLATION_FALLBACK_ORDER: string;
+  TM_ENCRYPTION_KEY: string;
+};
+
+type TranscriptSegment = {
+  id: number;
+  start: number;
+  end: number;
+  text: string;
+  translated_text?: string | null;
+  speaker?: string | null;
+};
+
+type TranscriptDocument = {
+  provider: ProviderName;
+  model: string;
+  detected_language?: string | null;
+  segments: TranscriptSegment[];
+};
+
+type JobRow = {
+  id: string;
+  status: string;
+  provider: ProviderName;
+  model: string;
+  source_language: string;
+  target_language: string | null;
+  translation_enabled: number;
+  options_json: string | null;
+  warning_json: string | null;
+  error_json: string | null;
+  result_json: string | null;
+  created_at: string;
+  updated_at: string;
+};
+
+type FileRow = {
+  id: string;
+  job_id: string;
+  input_name: string;
+  input_source: string;
+  size_bytes: number;
+  storage_path: string;
+  status: string;
+  detected_language: string | null;
+  duration_sec: number | null;
+  warning_json: string | null;
+  error_json: string | null;
+};
+
+type ArtifactRow = {
+  id: string;
+  job_id: string;
+  file_id: string | null;
+  format: string;
+  variant: string | null;
+  name: string;
+  mime_type: string;
+  kind: ArtifactKind;
+  storage_path: string;
+  size_bytes: number;
+};
+
+const PROVIDERS: Array<{ provider: ProviderName; requires_api_key: boolean; models: Array<Record<string, unknown>> }> = [
+  {
+    provider: "openai",
+    requires_api_key: true,
+    models: [
+      {
+        id: "gpt-4o-mini-transcribe",
+        max_duration_sec: 7200,
+        max_size_mb: 200,
+        supports_diarization: false,
+        supports_speaker_count: false,
+        supports_auto_language: true,
+        supports_translation_native: true,
+        supports_batch: true,
+        supported_target_languages: "*",
+      },
+      {
+        id: "whisper-1",
+        max_duration_sec: 7200,
+        max_size_mb: 200,
+        supports_diarization: false,
+        supports_speaker_count: false,
+        supports_auto_language: true,
+        supports_translation_native: true,
+        supports_batch: true,
+        supported_target_languages: "*",
+      },
+    ],
+  },
+  {
+    provider: "elevenlabs-scribe",
+    requires_api_key: true,
+    models: [
+      {
+        id: "scribe_v1",
+        max_duration_sec: 7200,
+        max_size_mb: 400,
+        supports_diarization: true,
+        supports_speaker_count: true,
+        supports_auto_language: true,
+        supports_translation_native: false,
+        supports_batch: true,
+        supported_target_languages: "*",
+      },
+      {
+        id: "scribe_v2",
+        max_duration_sec: 10800,
+        max_size_mb: 500,
+        supports_diarization: true,
+        supports_speaker_count: true,
+        supports_auto_language: true,
+        supports_translation_native: false,
+        supports_batch: true,
+        supported_target_languages: "*",
+      },
+    ],
+  },
+  {
+    provider: "deepgram",
+    requires_api_key: true,
+    models: [
+      {
+        id: "nova-3",
+        max_duration_sec: 10800,
+        max_size_mb: 500,
+        supports_diarization: true,
+        supports_speaker_count: false,
+        supports_auto_language: true,
+        supports_translation_native: true,
+        supports_batch: true,
+        supported_target_languages: "*",
+      },
+    ],
+  },
+];
+
+const app = new Hono<{ Bindings: Env }>();
+app.use("/api/*", cors());
+
+const encoder = new TextEncoder();
+const decoder = new TextDecoder();
+
+function nowIso(): string {
+  return new Date().toISOString();
+}
+
+function uid(): string {
+  return crypto.randomUUID().replace(/-/g, "");
+}
+
+function parseJson<T>(value: string | null, fallback: T): T {
+  if (!value) {
+    return fallback;
+  }
+  try {
+    return JSON.parse(value) as T;
+  } catch {
+    return fallback;
+  }
+}
+
+function safePrefix(inputName: string): string {
+  const stem = inputName.replace(/\.[^/.]+$/, "").toLowerCase().trim();
+  return stem.replace(/[^a-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "file";
+}
+
+function toSrtTimestamp(seconds: number): string {
+  const whole = Math.floor(seconds);
+  const hours = Math.floor(whole / 3600);
+  const minutes = Math.floor((whole % 3600) / 60);
+  const secs = whole % 60;
+  const millis = Math.floor((seconds - whole) * 1000);
+  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")},${millis.toString().padStart(3, "0")}`;
+}
+
+function toVttTimestamp(seconds: number): string {
+  const whole = Math.floor(seconds);
+  const hours = Math.floor(whole / 3600);
+  const minutes = Math.floor((whole % 3600) / 60);
+  const secs = whole % 60;
+  const millis = Math.floor((seconds - whole) * 1000);
+  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
+}
+
+function formatArtifact(document: TranscriptDocument, format: OutputFormat, variant: "source" | "translated" | "combined"): string {
+  if (format === "json") {
+    return JSON.stringify(document, null, 2);
+  }
+  if (format === "html") {
+    const rows = document.segments
+      .map(
+        (segment) =>
+          `<tr><td>${segment.id}</td><td>${segment.start.toFixed(2)}</td><td>${segment.end.toFixed(2)}</td><td>${escapeHtml(segment.text)}</td><td>${escapeHtml(segment.translated_text ?? "")}</td></tr>`,
+      )
+      .join("");
+    return `<!doctype html><html><head><meta charset="utf-8"><title>Transcript</title></head><body><table><thead><tr><th>#</th><th>Start</th><th>End</th><th>Source</th><th>Translated</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
+  }
+  if (format === "txt") {
+    return `${document.segments
+      .map((segment) => (variant === "translated" ? segment.translated_text || segment.text : segment.text))
+      .join("\n")}\n`;
+  }
+  if (format === "srt") {
+    return `${document.segments
+      .map((segment, idx) => {
+        const text = variant === "translated" ? segment.translated_text || segment.text : segment.text;
+        return `${idx + 1}\n${toSrtTimestamp(segment.start)} --> ${toSrtTimestamp(segment.end)}\n${text}`;
+      })
+      .join("\n\n")}\n`;
+  }
+  return `WEBVTT\n\n${document.segments
+    .map((segment) => {
+      const text = variant === "translated" ? segment.translated_text || segment.text : segment.text;
+      return `${toVttTimestamp(segment.start)} --> ${toVttTimestamp(segment.end)}\n${text}`;
+    })
+    .join("\n\n")}\n`;
+}
+
+function escapeHtml(value: string): string {
+  return value
+    .replaceAll("&", "&amp;")
+    .replaceAll("<", "&lt;")
+    .replaceAll(">", "&gt;")
+    .replaceAll('"', "&quot;")
+    .replaceAll("'", "&#039;");
+}
+
+async function importAesKey(secret: string): Promise<CryptoKey> {
+  let bytes: Uint8Array;
+  try {
+    bytes = Uint8Array.from(atob(secret), (char) => char.charCodeAt(0));
+  } catch {
+    bytes = encoder.encode(secret);
+  }
+  if (bytes.length < 32) {
+    const padded = new Uint8Array(32);
+    padded.set(bytes.slice(0, 32));
+    bytes = padded;
+  }
+  if (bytes.length > 32) {
+    bytes = bytes.slice(0, 32);
+  }
+  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
+}
+
+async function encryptSecret(secret: string, plaintext: string): Promise<string> {
+  const key = await importAesKey(secret);
+  const iv = crypto.getRandomValues(new Uint8Array(12));
+  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
+  const ivB64 = btoa(String.fromCharCode(...iv));
+  const payloadB64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
+  return `${ivB64}.${payloadB64}`;
+}
+
+async function decryptSecret(secret: string, ciphertext: string): Promise<string> {
+  const [ivB64, payloadB64] = ciphertext.split(".");
+  const iv = Uint8Array.from(atob(ivB64), (char) => char.charCodeAt(0));
+  const payload = Uint8Array.from(atob(payloadB64), (char) => char.charCodeAt(0));
+  const key = await importAesKey(secret);
+  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
+  return decoder.decode(decrypted);
+}
+
+async function getSetting(env: Env, key: string): Promise<string | null> {
+  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
+  return row?.value ?? null;
+}
+
+async function setSetting(env: Env, key: string, value: string): Promise<void> {
+  await env.DB.prepare(
+    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
+  )
+    .bind(key, value, nowIso())
+    .run();
+}
+
+async function getProviderKey(env: Env, provider: ProviderName): Promise<string | null> {
+  const row = await env.DB.prepare("SELECT encrypted_key FROM api_keys WHERE provider = ?").bind(provider).first<{ encrypted_key: string }>();
+  if (!row) {
+    return null;
+  }
+  return decryptSecret(env.TM_ENCRYPTION_KEY, row.encrypted_key);
+}
+
+async function listJobFiles(env: Env, jobId: string): Promise<FileRow[]> {
+  const result = await env.DB.prepare("SELECT * FROM job_files WHERE job_id = ? ORDER BY created_at ASC").bind(jobId).all<FileRow>();
+  return result.results || [];
+}
+
+async function listJobArtifacts(env: Env, jobId: string): Promise<ArtifactRow[]> {
+  const result = await env.DB.prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at ASC").bind(jobId).all<ArtifactRow>();
+  return result.results || [];
+}
+
+async function getJob(env: Env, jobId: string): Promise<JobRow | null> {
+  const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
+  return row ?? null;
+}
+
+async function buildJobResponse(env: Env, jobId: string): Promise<Record<string, unknown> | null> {
+  const job = await getJob(env, jobId);
+  if (!job) {
+    return null;
+  }
+  const files = await listJobFiles(env, jobId);
+  const artifacts = await listJobArtifacts(env, jobId);
+  const byFile = new Map<string, ArtifactRow[]>();
+  const topLevel: ArtifactRow[] = [];
+  for (const artifact of artifacts) {
+    if (artifact.file_id) {
+      const arr = byFile.get(artifact.file_id) || [];
+      arr.push(artifact);
+      byFile.set(artifact.file_id, arr);
+    } else {
+      topLevel.push(artifact);
+    }
+  }
+
+  return {
+    id: job.id,
+    status: job.status,
+    provider: job.provider,
+    model: job.model,
+    source_language: job.source_language,
+    target_language: job.target_language,
+    created_at: job.created_at,
+    updated_at: job.updated_at,
+    error_code: parseJson<Record<string, string>>(job.error_json, {}).code || null,
+    error_message: parseJson<Record<string, string>>(job.error_json, {}).message || null,
+    translation_warning_code: parseJson<Record<string, string>>(job.warning_json, {}).code || null,
+    translation_warning_message: parseJson<Record<string, string>>(job.warning_json, {}).message || null,
+    result: parseJson<Record<string, unknown> | null>(job.result_json, null),
+    files: files.map((file) => {
+      const warning = parseJson<Record<string, string>>(file.warning_json, {});
+      const error = parseJson<Record<string, string>>(file.error_json, {});
+      return {
+        id: file.id,
+        input_name: file.input_name,
+        input_source: file.input_source,
+        status: file.status,
+        detected_language: file.detected_language,
+        duration_sec: file.duration_sec,
+        error_code: error.code || null,
+        error_message: error.message || null,
+        translation_warning_code: warning.code || null,
+        translation_warning_message: warning.message || null,
+        artifacts: (byFile.get(file.id) || []).map((artifact) => ({
+          id: artifact.id,
+          file_id: artifact.file_id,
+          name: artifact.name,
+          mime_type: artifact.mime_type,
+          kind: artifact.kind,
+          format: artifact.format,
+          variant: artifact.variant,
+          size_bytes: artifact.size_bytes,
+        })),
+      };
+    }),
+    artifacts: topLevel.map((artifact) => ({
+      id: artifact.id,
+      file_id: artifact.file_id,
+      name: artifact.name,
+      mime_type: artifact.mime_type,
+      kind: artifact.kind,
+      format: artifact.format,
+      variant: artifact.variant,
+      size_bytes: artifact.size_bytes,
+    })),
+  };
+}
+
+async function transcribeOpenAI(apiKey: string, model: string, fileName: string, blob: Blob, sourceLanguage: string): Promise<TranscriptDocument> {
+  const form = new FormData();
+  form.set("file", blob, fileName);
+  form.set("model", model);
+  form.set("response_format", "verbose_json");
+  if (sourceLanguage !== "auto") {
+    form.set("language", sourceLanguage);
+  }
+  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
+    method: "POST",
+    headers: { Authorization: `Bearer ${apiKey}` },
+    body: form,
+  });
+  const payload = (await response.json()) as Record<string, unknown>;
+  if (!response.ok) {
+    throw new Error(`openai transcription failed: ${JSON.stringify(payload)}`);
+  }
+  const segmentsRaw = (payload.segments as Array<Record<string, unknown>> | undefined) || [];
+  const segments: TranscriptSegment[] =
+    segmentsRaw.length > 0
+      ? segmentsRaw.map((segment, idx) => ({
+          id: Number(segment.id ?? idx + 1),
+          start: Number(segment.start ?? 0),
+          end: Number(segment.end ?? 0),
+          text: String(segment.text ?? ""),
+        }))
+      : [{ id: 1, start: 0, end: 0, text: String(payload.text ?? "") }];
+  return { provider: "openai", model, detected_language: (payload.language as string | undefined) || null, segments };
+}
+
+async function transcribeElevenLabs(
+  apiKey: string,
+  model: string,
+  fileName: string,
+  blob: Blob,
+  sourceLanguage: string,
+  diarizationEnabled: boolean,
+  speakerCount: number | null,
+): Promise<TranscriptDocument> {
+  const form = new FormData();
+  form.set("file", blob, fileName);
+  form.set("model_id", model);
+  if (sourceLanguage !== "auto") {
+    form.set("language_code", sourceLanguage);
+  }
+  if (diarizationEnabled) {
+    form.set("diarize", "true");
+  }
+  if (speakerCount !== null) {
+    form.set("num_speakers", String(speakerCount));
+  }
+  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
+    method: "POST",
+    headers: { "xi-api-key": apiKey },
+    body: form,
+  });
+  const payload = (await response.json()) as Record<string, unknown>;
+  if (!response.ok) {
+    throw new Error(`elevenlabs transcription failed: ${JSON.stringify(payload)}`);
+  }
+  const segmentsRaw = (payload.segments as Array<Record<string, unknown>> | undefined) || [];
+  const segments: TranscriptSegment[] =
+    segmentsRaw.length > 0
+      ? segmentsRaw.map((segment, idx) => ({
+          id: idx + 1,
+          start: Number(segment.start ?? 0),
+          end: Number(segment.end ?? 0),
+          text: String(segment.text ?? ""),
+          speaker: segment.speaker != null ? String(segment.speaker) : null,
+        }))
+      : [{ id: 1, start: 0, end: 0, text: String(payload.text ?? "") }];
+  return { provider: "elevenlabs-scribe", model, detected_language: (payload.language_code as string | undefined) || null, segments };
+}
+
+async function transcribeDeepgram(
+  apiKey: string,
+  model: string,
+  blob: Blob,
+  sourceLanguage: string,
+  diarizationEnabled: boolean,
+): Promise<TranscriptDocument> {
+  let url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&punctuate=true&smart_format=true&diarize=${
+    diarizationEnabled ? "true" : "false"
+  }`;
+  if (sourceLanguage !== "auto") {
+    url += `&language=${encodeURIComponent(sourceLanguage)}`;
+  }
+  const response = await fetch(url, {
+    method: "POST",
+    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/octet-stream" },
+    body: await blob.arrayBuffer(),
+  });
+  const payload = (await response.json()) as Record<string, unknown>;
+  if (!response.ok) {
+    throw new Error(`deepgram transcription failed: ${JSON.stringify(payload)}`);
+  }
+  const channels = (((payload.results as Record<string, unknown>)?.channels as Array<Record<string, unknown>>) || []);
+  const alternative = ((channels[0]?.alternatives as Array<Record<string, unknown>>) || [])[0] || {};
+  const words = (alternative.words as Array<Record<string, unknown>> | undefined) || [];
+  const segments: TranscriptSegment[] = [];
+  if (words.length > 0) {
+    let chunk: Array<Record<string, unknown>> = [];
+    let idx = 1;
+    for (const word of words) {
+      chunk.push(word);
+      const token = String(word.punctuated_word || word.word || "");
+      if (/[.!?]$/.test(token)) {
+        segments.push({
+          id: idx,
+          start: Number(chunk[0].start || 0),
+          end: Number(chunk[chunk.length - 1].end || 0),
+          text: chunk.map((item) => String(item.punctuated_word || item.word || "")).join(" "),
+          speaker: chunk[0].speaker != null ? `spk-${String(chunk[0].speaker)}` : null,
+        });
+        idx += 1;
+        chunk = [];
+      }
+    }
+    if (chunk.length > 0) {
+      segments.push({
+        id: segments.length + 1,
+        start: Number(chunk[0].start || 0),
+        end: Number(chunk[chunk.length - 1].end || 0),
+        text: chunk.map((item) => String(item.punctuated_word || item.word || "")).join(" "),
+        speaker: chunk[0].speaker != null ? `spk-${String(chunk[0].speaker)}` : null,
+      });
+    }
+  } else {
+    segments.push({ id: 1, start: 0, end: 0, text: String(alternative.transcript || "") });
+  }
+  return {
+    provider: "deepgram",
+    model,
+    detected_language: String((payload.results as Record<string, unknown>)?.detected_language || "") || null,
+    segments,
+  };
+}
+
+async function translateViaOpenAI(apiKey: string, text: string, targetLanguage: string, sourceLanguage: string | null): Promise<string> {
+  const sourceHint = sourceLanguage ? ` from ${sourceLanguage}` : "";
+  const response = await fetch("https://api.openai.com/v1/chat/completions", {
+    method: "POST",
+    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
+    body: JSON.stringify({
+      model: "gpt-4o-mini",
+      temperature: 0,
+      messages: [
+        { role: "system", content: "You are a translation engine. Return only translated text." },
+        { role: "user", content: `Translate this text${sourceHint} to ${targetLanguage}: ${text}` },
+      ],
+    }),
+  });
+  const payload = (await response.json()) as Record<string, unknown>;
+  if (!response.ok) {
+    throw new Error(`openai translation failed: ${JSON.stringify(payload)}`);
+  }
+  const choices = (payload.choices as Array<Record<string, unknown>> | undefined) || [];
+  const message = (choices[0]?.message as Record<string, unknown> | undefined) || {};
+  return String(message.content || "").trim();
+}
+
+async function translateViaDeepgram(apiKey: string, text: string, targetLanguage: string, sourceLanguage: string | null): Promise<string> {
+  const response = await fetch("https://api.deepgram.com/v1/translate", {
+    method: "POST",
+    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
+    body: JSON.stringify({ text, target_language: targetLanguage, source_language: sourceLanguage }),
+  });
+  const payload = (await response.json()) as Record<string, unknown>;
+  if (!response.ok) {
+    throw new Error(`deepgram translation failed: ${JSON.stringify(payload)}`);
+  }
+  return String(payload.translated_text || "").trim();
+}
+
+async function applyTranslationFallback(
+  env: Env,
+  job: JobRow,
+  document: TranscriptDocument,
+  order: string[],
+): Promise<{ document: TranscriptDocument; warning: { code: string; message: string } | null }> {
+  for (const backend of order) {
+    try {
+      if (backend === "native") {
+        if (job.provider === "openai") {
+          const key = await getProviderKey(env, "openai");
+          if (!key) {
+            continue;
+          }
+          const translatedSegments: TranscriptSegment[] = [];
+          for (const segment of document.segments) {
+            translatedSegments.push({
+              ...segment,
+              translated_text: await translateViaOpenAI(key, segment.text, job.target_language || "", document.detected_language || null),
+            });
+          }
+          return { document: { ...document, segments: translatedSegments }, warning: null };
+        }
+        if (job.provider === "deepgram") {
+          const key = await getProviderKey(env, "deepgram");
+          if (!key) {
+            continue;
+          }
+          const translatedSegments: TranscriptSegment[] = [];
+          for (const segment of document.segments) {
+            translatedSegments.push({
+              ...segment,
+              translated_text: await translateViaDeepgram(key, segment.text, job.target_language || "", document.detected_language || null),
+            });
+          }
+          return { document: { ...document, segments: translatedSegments }, warning: null };
+        }
+        continue;
+      }
+      if (backend === "openai") {
+        const key = await getProviderKey(env, "openai");
+        if (!key) {
+          continue;
+        }
+        const translatedSegments: TranscriptSegment[] = [];
+        for (const segment of document.segments) {
+          translatedSegments.push({
+            ...segment,
+            translated_text: await translateViaOpenAI(key, segment.text, job.target_language || "", document.detected_language || null),
+          });
+        }
+        return { document: { ...document, segments: translatedSegments }, warning: null };
+      }
+      if (backend === "deepgram") {
+        const key = await getProviderKey(env, "deepgram");
+        if (!key) {
+          continue;
+        }
+        const translatedSegments: TranscriptSegment[] = [];
+        for (const segment of document.segments) {
+          translatedSegments.push({
+            ...segment,
+            translated_text: await translateViaDeepgram(key, segment.text, job.target_language || "", document.detected_language || null),
+          });
+        }
+        return { document: { ...document, segments: translatedSegments }, warning: null };
+      }
+    } catch {
+      continue;
+    }
+  }
+  return {
+    document,
+    warning: { code: "translation_failed", message: "Translation failed for all backends; returning source transcript only." },
+  };
+}
+
+async function processJob(env: Env, jobId: string): Promise<void> {
+  const job = await getJob(env, jobId);
+  if (!job || job.status === "cancelled" || job.status === "completed" || job.status === "failed") {
+    return;
+  }
+
+  await env.DB.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").bind("running", nowIso(), jobId).run();
+  const options = parseJson<Record<string, unknown>>(job.options_json, {});
+  const formats = (options.formats as OutputFormat[] | undefined) || ["json", "txt"];
+  const diarizationEnabled = Boolean(options.diarization_enabled || false);
+  const speakerCount = Number(options.speaker_count || 0) || null;
+  const orderSetting = (await getSetting(env, "translation_fallback_order")) || env.TRANSLATION_FALLBACK_ORDER;
+  const fallbackOrder = orderSetting
+    .split(",")
+    .map((item) => item.trim())
+    .filter(Boolean);
+
+  const files = await listJobFiles(env, jobId);
+  let processedFiles = 0;
+  let failedFiles = 0;
+
+  for (const file of files) {
+    const latestJob = await getJob(env, jobId);
+    if (!latestJob || latestJob.status === "cancelled") {
+      break;
+    }
+    await env.DB.prepare("UPDATE job_files SET status = ?, updated_at = ? WHERE id = ?").bind("running", nowIso(), file.id).run();
+    try {
+      const object = await env.STORAGE.get(file.storage_path);
+      if (!object) {
+        throw new Error(`missing upload object: ${file.storage_path}`);
+      }
+      const blob = await object.blob();
+      const apiKey = await getProviderKey(env, job.provider);
+      if (!apiKey) {
+        throw new Error(`missing API key for provider ${job.provider}`);
+      }
+      let document: TranscriptDocument;
+      if (job.provider === "openai") {
+        document = await transcribeOpenAI(apiKey, job.model, file.input_name, blob, job.source_language);
+      } else if (job.provider === "elevenlabs-scribe") {
+        document = await transcribeElevenLabs(apiKey, job.model, file.input_name, blob, job.source_language, diarizationEnabled, speakerCount);
+      } else {
+        document = await transcribeDeepgram(apiKey, job.model, blob, job.source_language, diarizationEnabled);
+      }
+
+      let warning: { code: string; message: string } | null = null;
+      if (job.translation_enabled && job.target_language) {
+        const translated = await applyTranslationFallback(env, job, document, fallbackOrder);
+        document = translated.document;
+        warning = translated.warning;
+      }
+
+      const prefix = safePrefix(file.input_name);
+      const translatedExists = document.segments.some((segment) => Boolean(segment.translated_text));
+      for (const format of formats) {
+        const variants: Array<"source" | "translated" | "combined"> =
+          format === "srt" || format === "vtt" || format === "txt" ? ["source", ...(translatedExists ? ["translated"] : [])] : ["combined"];
+        for (const variant of variants) {
+          const data = formatArtifact(document, format, variant);
+          const name =
+            format === "json"
+              ? `${prefix}__transcript.json`
+              : format === "html"
+                ? `${prefix}__combined.html`
+                : `${prefix}__${variant}.${format}`;
+          const storagePath = `artifacts/${jobId}/${file.id}/${name}`;
+          const bytes = encoder.encode(data);
+          await env.STORAGE.put(storagePath, bytes, {
+            httpMetadata: {
+              contentType:
+                format === "json" ? "application/json" : format === "html" ? "text/html" : format === "vtt" ? "text/vtt" : "text/plain",
+            },
+          });
+          await env.DB.prepare(
+            "INSERT INTO artifacts (id, job_id, file_id, format, variant, name, mime_type, kind, storage_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
+          )
+            .bind(
+              uid(),
+              jobId,
+              file.id,
+              format,
+              format === "json" || format === "html" ? null : variant,
+              name,
+              format === "json" ? "application/json" : format === "html" ? "text/html" : format === "vtt" ? "text/vtt" : "text/plain",
+              format === "json" || format === "html" ? "combined" : variant,
+              storagePath,
+              bytes.byteLength,
+              nowIso(),
+            )
+            .run();
+        }
+      }
+
+      await env.DB.prepare(
+        "UPDATE job_files SET status = ?, detected_language = ?, warning_json = ?, error_json = NULL, updated_at = ? WHERE id = ?",
+      )
+        .bind("completed", document.detected_language || null, warning ? JSON.stringify(warning) : null, nowIso(), file.id)
+        .run();
+      processedFiles += 1;
+    } catch (error) {
+      failedFiles += 1;
+      await env.DB.prepare("UPDATE job_files SET status = ?, error_json = ?, updated_at = ? WHERE id = ?")
+        .bind("failed", JSON.stringify({ code: "file_processing_failed", message: String(error) }), nowIso(), file.id)
+        .run();
+    }
+  }
+
+  const artifacts = await listJobArtifacts(env, jobId);
+  const zip = new JSZip();
+  zip.file(
+    "job_manifest.json",
+    JSON.stringify(
+      {
+        job_id: jobId,
+        generated_at: nowIso(),
+        processed_files: processedFiles,
+        failed_files: failedFiles,
+        artifacts: artifacts.map((artifact) => artifact.name),
+      },
+      null,
+      2,
+    ),
+  );
+  for (const artifact of artifacts) {
+    if (artifact.kind === "bundle") {
+      continue;
+    }
+    const object = await env.STORAGE.get(artifact.storage_path);
+    if (!object) {
+      continue;
+    }
+    zip.file(artifact.name, await object.arrayBuffer());
+  }
+  const zipBuffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
+  const bundlePath = `bundles/${jobId}.zip`;
+  await env.STORAGE.put(bundlePath, zipBuffer, { httpMetadata: { contentType: "application/zip" } });
+  await env.DB.prepare(
+    "INSERT INTO artifacts (id, job_id, file_id, format, variant, name, mime_type, kind, storage_path, size_bytes, created_at) VALUES (?, ?, NULL, 'zip', NULL, ?, 'application/zip', 'bundle', ?, ?, ?)",
+  )
+    .bind(uid(), jobId, `${jobId}.zip`, bundlePath, zipBuffer.byteLength, nowIso())
+    .run();
+
+  if (processedFiles === 0 && failedFiles > 0) {
+    await env.DB.prepare("UPDATE jobs SET status = ?, error_json = ?, result_json = ?, updated_at = ? WHERE id = ?")
+      .bind(
+        "failed",
+        JSON.stringify({ code: "job_failed", message: "All files failed to process." }),
+        JSON.stringify({ processed_files: processedFiles, failed_files: failedFiles }),
+        nowIso(),
+        jobId,
+      )
+      .run();
+  } else {
+    await env.DB.prepare("UPDATE jobs SET status = ?, result_json = ?, updated_at = ? WHERE id = ?")
+      .bind("completed", JSON.stringify({ processed_files: processedFiles, failed_files: failedFiles }), nowIso(), jobId)
+      .run();
+  }
+}
+
+async function cleanupExpired(env: Env): Promise<void> {
+  const retentionDaysSetting = (await getSetting(env, "retention_days")) || env.RETENTION_DAYS || "7";
+  const retentionDays = Number(retentionDaysSetting) || 7;
+  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
+  const oldArtifacts = await env.DB.prepare("SELECT storage_path FROM artifacts WHERE created_at < ?").bind(cutoff).all<{ storage_path: string }>();
+  for (const artifact of oldArtifacts.results || []) {
+    await env.STORAGE.delete(artifact.storage_path);
+  }
+  await env.DB.prepare("DELETE FROM artifacts WHERE created_at < ?").bind(cutoff).run();
+  await env.DB.prepare("DELETE FROM job_files WHERE updated_at < ?").bind(cutoff).run();
+  await env.DB.prepare("DELETE FROM jobs WHERE updated_at < ?").bind(cutoff).run();
+}
+
+app.get("/api/capabilities", (c) => c.json({ providers: PROVIDERS }));
+
+app.get("/api/settings/keys", async (c) => {
+  const rows = await c.env.DB.prepare("SELECT provider, updated_at FROM api_keys ORDER BY provider ASC").all<{ provider: string; updated_at: string }>();
+  const configured = new Map((rows.results || []).map((row) => [row.provider, row.updated_at]));
+  return c.json(
+    PROVIDERS.map((provider) => ({
+      provider: provider.provider,
+      configured: configured.has(provider.provider),
+      updated_at: configured.get(provider.provider) || null,
+    })),
+  );
+});
+
+app.put("/api/settings/keys/:provider", async (c) => {
+  const provider = c.req.param("provider") as ProviderName;
+  const body = await c.req.json<{ provider: ProviderName; key: string }>();
+  if (provider !== body.provider) {
+    return c.json({ error: "provider path/body mismatch" }, 400);
+  }
+  if (!PROVIDERS.find((item) => item.provider === provider)) {
+    return c.json({ error: "unsupported provider" }, 400);
+  }
+  const encrypted = await encryptSecret(c.env.TM_ENCRYPTION_KEY, body.key);
+  await c.env.DB.prepare(
+    "INSERT INTO api_keys (provider, encrypted_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET encrypted_key = excluded.encrypted_key, updated_at = excluded.updated_at",
+  )
+    .bind(provider, encrypted, nowIso())
+    .run();
+  return c.json({ provider, configured: true });
+});
+
+app.delete("/api/settings/keys/:provider", async (c) => {
+  const provider = c.req.param("provider");
+  await c.env.DB.prepare("DELETE FROM api_keys WHERE provider = ?").bind(provider).run();
+  return c.json({ provider, configured: false });
+});
+
+app.get("/api/settings/app", async (c) => {
+  const syncSizeThresholdMb = Number((await getSetting(c.env, "sync_size_threshold_mb")) || c.env.SYNC_SIZE_THRESHOLD_MB || "20");
+  const retentionDays = Number((await getSetting(c.env, "retention_days")) || c.env.RETENTION_DAYS || "7");
+  const fallbackOrderRaw = (await getSetting(c.env, "translation_fallback_order")) || c.env.TRANSLATION_FALLBACK_ORDER;
+  const allowlist = ((await getSetting(c.env, "local_folder_allowlist")) || "")
+    .split(",")
+    .map((item) => item.trim())
+    .filter(Boolean);
+  return c.json({
+    app_mode: "cloudflare",
+    sync_size_threshold_mb: syncSizeThresholdMb,
+    retention_days: retentionDays,
+    translation_fallback_order: fallbackOrderRaw.split(",").map((item) => item.trim()).filter(Boolean),
+    local_folder_allowlist: allowlist,
+  });
+});
+
+app.put("/api/settings/app", async (c) => {
+  const body = await c.req.json<Record<string, unknown>>();
+  if (body.sync_size_threshold_mb != null) {
+    await setSetting(c.env, "sync_size_threshold_mb", String(body.sync_size_threshold_mb));
+  }
+  if (body.retention_days != null) {
+    await setSetting(c.env, "retention_days", String(body.retention_days));
+  }
+  if (body.translation_fallback_order != null) {
+    await setSetting(c.env, "translation_fallback_order", (body.translation_fallback_order as string[]).join(","));
+  }
+  if (body.local_folder_allowlist != null) {
+    await setSetting(c.env, "local_folder_allowlist", (body.local_folder_allowlist as string[]).join(","));
+  }
+  return c.redirect("/api/settings/app", 307);
+});
+
+app.get("/api/jobs", async (c) => {
+  const rows = await c.env.DB.prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 100").all<{ id: string }>();
+  const jobs: Record<string, unknown>[] = [];
+  for (const row of rows.results || []) {
+    const job = await buildJobResponse(c.env, row.id);
+    if (job) {
+      jobs.push(job);
+    }
+  }
+  return c.json(jobs);
+});
+
+app.post("/api/jobs", async (c) => {
+  const form = await c.req.formData();
+  const provider = String(form.get("provider") || "") as ProviderName;
+  const model = String(form.get("model") || "");
+  const sourceLanguage = String(form.get("source_language") || "auto");
+  const targetLanguage = form.get("target_language") ? String(form.get("target_language")) : null;
+  const formats = String(form.get("formats") || "json,txt")
+    .split(",")
+    .map((item) => item.trim())
+    .filter(Boolean) as OutputFormat[];
+  const diarizationEnabled = String(form.get("diarization_enabled") || "false") === "true";
+  const speakerCountRaw = String(form.get("speaker_count") || "");
+  const speakerCount = speakerCountRaw ? Number(speakerCountRaw) : null;
+  const translationEnabled = String(form.get("translation_enabled") || "true") !== "false";
+  const syncPreferred = String(form.get("sync_preferred") || "true") !== "false";
+  const batchLabel = form.get("batch_label") ? String(form.get("batch_label")) : null;
+
+  if (!PROVIDERS.find((item) => item.provider === provider)) {
+    return c.json({ error: "unsupported provider" }, 400);
+  }
+  const files = form.getAll("files").filter((item): item is File => item instanceof File);
+  if (files.length === 0) {
+    return c.json({ error: "at least one file is required" }, 400);
+  }
+
+  const jobId = uid();
+  const timestamp = nowIso();
+  await c.env.DB.prepare(
+    "INSERT INTO jobs (id, status, provider, model, source_language, target_language, translation_enabled, options_json, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
+  )
+    .bind(
+      jobId,
+      provider,
+      model,
+      sourceLanguage,
+      targetLanguage,
+      translationEnabled ? 1 : 0,
+      JSON.stringify({
+        formats,
+        diarization_enabled: diarizationEnabled,
+        speaker_count: speakerCount,
+        sync_preferred: syncPreferred,
+        batch_label: batchLabel,
+      }),
+      timestamp,
+      timestamp,
+    )
+    .run();
+
+  for (const file of files) {
+    const fileId = uid();
+    const storagePath = `uploads/${jobId}/${fileId}/${file.name}`;
+    await c.env.STORAGE.put(storagePath, file.stream(), {
+      httpMetadata: { contentType: file.type || "application/octet-stream" },
+    });
+    await c.env.DB.prepare(
+      "INSERT INTO job_files (id, job_id, input_name, input_source, size_bytes, storage_path, status, created_at, updated_at) VALUES (?, ?, ?, 'upload', ?, ?, 'queued', ?, ?)",
+    )
+      .bind(fileId, jobId, file.name, file.size, storagePath, timestamp, timestamp)
+      .run();
+  }
+
+  await c.env.JOB_QUEUE.send({ jobId });
+  const response = await buildJobResponse(c.env, jobId);
+  return c.json(response);
+});
+
+app.post("/api/jobs/from-folder", () =>
+  new Response(JSON.stringify({ error: "folder ingestion is local-only and disabled in cloud mode" }), {
+    status: 400,
+    headers: { "content-type": "application/json" },
+  }),
+);
+
+app.get("/api/jobs/:jobId", async (c) => {
+  const job = await buildJobResponse(c.env, c.req.param("jobId"));
+  if (!job) {
+    return c.json({ error: "job not found" }, 404);
+  }
+  return c.json(job);
+});
+
+app.get("/api/jobs/:jobId/artifacts", async (c) => {
+  const artifacts = await listJobArtifacts(c.env, c.req.param("jobId"));
+  return c.json(
+    artifacts.map((artifact) => ({
+      id: artifact.id,
+      file_id: artifact.file_id,
+      name: artifact.name,
+      mime_type: artifact.mime_type,
+      kind: artifact.kind,
+      format: artifact.format,
+      variant: artifact.variant,
+      size_bytes: artifact.size_bytes,
+    })),
+  );
+});
+
+app.get("/api/jobs/:jobId/artifacts/:artifactId", async (c) => {
+  const artifact = await c.env.DB.prepare("SELECT * FROM artifacts WHERE id = ? AND job_id = ?")
+    .bind(c.req.param("artifactId"), c.req.param("jobId"))
+    .first<ArtifactRow>();
+  if (!artifact) {
+    return c.json({ error: "artifact not found" }, 404);
+  }
+  const object = await c.env.STORAGE.get(artifact.storage_path);
+  if (!object) {
+    return c.json({ error: "artifact object missing" }, 404);
+  }
+  return new Response(object.body, {
+    headers: {
+      "content-type": artifact.mime_type,
+      "content-disposition": `attachment; filename="${artifact.name}"`,
+    },
+  });
+});
+
+app.get("/api/jobs/:jobId/bundle.zip", async (c) => {
+  const artifact = await c.env.DB.prepare("SELECT * FROM artifacts WHERE job_id = ? AND kind = 'bundle' ORDER BY created_at DESC LIMIT 1")
+    .bind(c.req.param("jobId"))
+    .first<ArtifactRow>();
+  if (!artifact) {
+    return c.json({ error: "bundle not found" }, 404);
+  }
+  const object = await c.env.STORAGE.get(artifact.storage_path);
+  if (!object) {
+    return c.json({ error: "bundle object missing" }, 404);
+  }
+  return new Response(object.body, {
+    headers: {
+      "content-type": "application/zip",
+      "content-disposition": `attachment; filename="${artifact.name}"`,
+    },
+  });
+});
+
+app.post("/api/jobs/:jobId/cancel", async (c) => {
+  const jobId = c.req.param("jobId");
+  await c.env.DB.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(nowIso(), jobId).run();
+  await c.env.DB.prepare("UPDATE job_files SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'running')")
+    .bind(nowIso(), jobId)
+    .run();
+  const job = await buildJobResponse(c.env, jobId);
+  if (!job) {
+    return c.json({ error: "job not found" }, 404);
+  }
+  return c.json(job);
+});
+
+function renderPage(title: string, body: string): string {
+  return `<!doctype html>
+<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
+<body style="font-family:Segoe UI,Tahoma,sans-serif;margin:24px;max-width:1100px;">
+<nav style="margin-bottom:16px;display:flex;gap:12px;">
+  <a href="/jobs">Jobs</a>
+  <a href="/jobs/new">New Job</a>
+  <a href="/settings">Settings</a>
+</nav>
+${body}
+</body></html>`;
+}
+
+app.get("/", (c) => c.redirect("/jobs"));
+
+app.get("/settings", () => {
+  const html = renderPage(
+    "Settings",
+    `<h2>Settings</h2><p>Use API endpoints to manage keys and app settings in cloud mode.</p><pre>GET /api/settings/app
+PUT /api/settings/app
+GET /api/settings/keys
+PUT /api/settings/keys/{provider}</pre>`,
+  );
+  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
+});
+
+app.get("/jobs", () => {
+  const html = renderPage(
+    "Jobs",
+    `<h2>Jobs</h2>
+<p><a href="/jobs/new">Create new job</a></p>
+<pre id="jobs">Loading...</pre>
+<script>
+fetch('/api/jobs').then(r => r.json()).then(data => {
+  document.getElementById('jobs').textContent = JSON.stringify(data, null, 2);
+});
+</script>`,
+  );
+  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
+});
+
+app.get("/jobs/new", () => {
+  const html = renderPage(
+    "New Job",
+    `<h2>Create Job</h2>
+<form id="job-form">
+<label>Provider <select name="provider"><option value="openai">openai</option><option value="elevenlabs-scribe">elevenlabs-scribe</option><option value="deepgram">deepgram</option></select></label><br/><br/>
+<label>Model <input name="model" value="gpt-4o-mini-transcribe"/></label><br/><br/>
+<label>Source language <input name="source_language" value="auto"/></label><br/><br/>
+<label>Target language <input name="target_language" placeholder="optional"/></label><br/><br/>
+<label>Formats <input name="formats" value="srt,vtt,html,txt,json"/></label><br/><br/>
+<label>Files <input name="files" type="file" multiple/></label><br/><br/>
+<button type="submit">Submit</button>
+</form>
+<pre id="result"></pre>
+<script>
+document.getElementById('job-form').addEventListener('submit', async (event) => {
+  event.preventDefault();
+  const formData = new FormData(event.target);
+  const response = await fetch('/api/jobs', { method: 'POST', body: formData });
+  document.getElementById('result').textContent = await response.text();
+});
+</script>`,
+  );
+  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
+});
+
+app.get("/jobs/:jobId", (c) => {
+  const jobId = c.req.param("jobId");
+  const html = renderPage(
+    `Job ${jobId}`,
+    `<h2>Job ${jobId}</h2>
+<pre id="job">Loading...</pre>
+<script>
+const jobId = ${JSON.stringify(jobId)};
+function poll() {
+  fetch('/api/jobs/' + jobId).then(r => r.json()).then(data => {
+    document.getElementById('job').textContent = JSON.stringify(data, null, 2);
+    if (!['completed','failed','cancelled'].includes(data.status)) {
+      setTimeout(poll, 3000);
+    }
+  });
+}
+poll();
+</script>`,
+  );
+  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
+});
+
+export default {
+  fetch: app.fetch,
+  async queue(batch: MessageBatch<{ jobId: string }>, env: Env): Promise<void> {
+    for (const message of batch.messages) {
+      await processJob(env, message.body.jobId);
+      message.ack();
+    }
+  },
+  async scheduled(_: ScheduledEvent, env: Env): Promise<void> {
+    await cleanupExpired(env);
+  },
+};
