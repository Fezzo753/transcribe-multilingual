import JSZip from "jszip";
import { Hono } from "hono";
import { cors } from "hono/cors";

type ProviderName = "openai" | "elevenlabs-scribe" | "deepgram";
type OutputFormat = "srt" | "vtt" | "html" | "txt" | "json";
type TimestampLevel = "segment" | "word";

type Env = {
  DB: D1Database;
  STORAGE: R2Bucket;
  JOB_QUEUE: Queue;
  APP_MODE: string;
  SYNC_SIZE_THRESHOLD_MB: string;
  RETENTION_DAYS: string;
  TRANSLATION_FALLBACK_ORDER: string;
  TM_ENCRYPTION_KEY: string;
};

type TranscriptSegment = { id: number; start: number; end: number; text: string; translated_text?: string | null };
type TranscriptDocument = {
  provider: ProviderName;
  model: string;
  detected_language?: string | null;
  segments: TranscriptSegment[];
  metadata?: Record<string, unknown>;
};

const PROVIDERS = [
  {
    provider: "openai",
    requires_api_key: true,
    models: ["gpt-4o-mini-transcribe", "whisper-1"],
  },
  {
    provider: "elevenlabs-scribe",
    requires_api_key: true,
    models: ["scribe_v1", "scribe_v2"],
  },
  {
    provider: "deepgram",
    requires_api_key: true,
    models: ["nova-3"],
  },
];

const VALID_FORMATS: OutputFormat[] = ["srt", "vtt", "html", "txt", "json"];

export const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", cors());

const enc = new TextEncoder();
const dec = new TextDecoder();

function nowIso(): string {
  return new Date().toISOString();
}

function uid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function safePrefix(name: string): string {
  const stem = name.replace(/\.[^/.]+$/, "").toLowerCase();
  return stem.replace(/[^a-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "file";
}

function safeUploadName(name: string): string {
  const trimmed = name.trim();
  const basename = trimmed.split(/[\\/]/).pop() || "";
  return basename || "upload.bin";
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function isSupportedProvider(value: string): value is ProviderName {
  return PROVIDERS.some((provider) => provider.provider === value);
}

function providerConfig(provider: ProviderName): (typeof PROVIDERS)[number] {
  const config = PROVIDERS.find((item) => item.provider === provider);
  if (!config) {
    throw new Error(`unsupported provider '${provider}'`);
  }
  return config;
}

function isSupportedModel(provider: ProviderName, model: string): boolean {
  return providerConfig(provider).models.includes(model);
}

export function parseRequestedFormats(raw: string): OutputFormat[] {
  const parsed = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0) {
    throw new Error("at least one output format is required");
  }
  for (const item of parsed) {
    if (!VALID_FORMATS.includes(item as OutputFormat)) {
      throw new Error(`unsupported output format '${item}'`);
    }
  }
  return parsed as OutputFormat[];
}

function parseRequestedFormatsFromForm(form: FormData): OutputFormat[] {
  const entries = form
    .getAll("formats")
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("at least one output format is required");
  }
  return parseRequestedFormats(entries.join(","));
}

function parseTimestampLevel(raw: string): TimestampLevel {
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "segment" && normalized !== "word") {
    throw new Error("timestamp_level must be 'segment' or 'word'");
  }
  return normalized as TimestampLevel;
}

function parseBooleanFlag(value: FormDataEntryValue | null, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(key, value, nowIso())
    .run();
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    bytes = enc.encode(secret);
  }
  if (bytes.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(bytes.slice(0, 32));
    bytes = padded;
  }
  if (bytes.length > 32) bytes = bytes.slice(0, 32);
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const key = await importAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}

async function decryptSecret(secret: string, value: string): Promise<string> {
  const [ivB64, payloadB64] = value.split(".");
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const payload = Uint8Array.from(atob(payloadB64), (c) => c.charCodeAt(0));
  const key = await importAesKey(secret);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
  return dec.decode(decrypted);
}

async function getProviderKey(env: Env, provider: ProviderName): Promise<string | null> {
  const row = await env.DB.prepare("SELECT encrypted_key FROM api_keys WHERE provider = ?").bind(provider).first<{ encrypted_key: string }>();
  if (!row) return null;
  return decryptSecret(env.TM_ENCRYPTION_KEY, row.encrypted_key);
}

function tsSrt(seconds: number): string {
  const full = Math.floor(seconds);
  const h = Math.floor(full / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((full % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = (full % 60).toString().padStart(2, "0");
  const ms = Math.floor((seconds - full) * 1000)
    .toString()
    .padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

function tsVtt(seconds: number): string {
  return tsSrt(seconds).replace(",", ".");
}

function render(document: TranscriptDocument, format: OutputFormat, variant: "source" | "translated" | "combined"): string {
  if (format === "json") return `${JSON.stringify(document, null, 2)}\n`;
  if (format === "html") {
    const rows = document.segments
      .map(
        (segment) =>
          `<tr><td>${segment.id}</td><td>${segment.start.toFixed(2)}</td><td>${segment.end.toFixed(2)}</td><td>${escapeHtml(
            segment.text,
          )}</td><td>${escapeHtml(segment.translated_text ?? "")}</td></tr>`,
      )
      .join("");
    return `<!doctype html><html><body><table>${rows}</table></body></html>`;
  }
  if (format === "txt") {
    return `${document.segments.map((s) => (variant === "translated" ? s.translated_text || s.text : s.text)).join("\n")}\n`;
  }
  if (format === "srt") {
    return `${document.segments
      .map((s, idx) => `${idx + 1}\n${tsSrt(s.start)} --> ${tsSrt(s.end)}\n${variant === "translated" ? s.translated_text || s.text : s.text}`)
      .join("\n\n")}\n`;
  }
  if (format === "vtt") {
    return `WEBVTT\n\n${document.segments
      .map((s) => `${tsVtt(s.start)} --> ${tsVtt(s.end)}\n${variant === "translated" ? s.translated_text || s.text : s.text}`)
      .join("\n\n")}\n`;
  }
  throw new Error(`unsupported output format '${format}'`);
}

async function transcribeOpenAI(
  apiKey: string,
  model: string,
  file: File,
  sourceLanguage: string,
  timestampLevel: TimestampLevel,
  verboseOutput: boolean,
): Promise<TranscriptDocument> {
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("model", model);
  form.set("response_format", "verbose_json");
  if (sourceLanguage !== "auto") form.set("language", sourceLanguage);
  form.set("timestamp_granularities[]", timestampLevel);
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`openai transcription failed: ${JSON.stringify(payload)}`);
  const segmentsRaw = (payload.segments as Array<Record<string, unknown>> | undefined) || [];
  const segments = segmentsRaw.length
    ? segmentsRaw.map((s, idx) => ({
        id: Number(s.id ?? idx + 1),
        start: Number(s.start ?? 0),
        end: Number(s.end ?? 0),
        text: String(s.text ?? ""),
      }))
    : [{ id: 1, start: 0, end: 0, text: String(payload.text ?? "") }];
  const metadata = verboseOutput ? { raw_response: payload } : undefined;
  return { provider: "openai", model, detected_language: (payload.language as string | undefined) || null, segments, metadata };
}

async function transcribeDeepgram(
  apiKey: string,
  model: string,
  file: File,
  sourceLanguage: string,
  diarizationEnabled: boolean,
  timestampLevel: TimestampLevel,
  verboseOutput: boolean,
): Promise<TranscriptDocument> {
  let url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&punctuate=true&smart_format=true&diarize=${
    diarizationEnabled ? "true" : "false"
  }`;
  if (sourceLanguage !== "auto") url += `&language=${encodeURIComponent(sourceLanguage)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/octet-stream" },
    body: await file.arrayBuffer(),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`deepgram transcription failed: ${JSON.stringify(payload)}`);
  const channel = ((((payload.results as Record<string, unknown>)?.channels as Array<Record<string, unknown>>) || [])[0] || {}) as Record<
    string,
    unknown
  >;
  const alt = (((channel.alternatives as Array<Record<string, unknown>>) || [])[0] || {}) as Record<string, unknown>;
  const words = ((alt.words as Array<Record<string, unknown>> | undefined) || []).filter((item) => item.word || item.punctuated_word);
  const transcript = String(alt.transcript || "");
  let segments: TranscriptSegment[] = [];
  if (timestampLevel === "word" && words.length > 0) {
    segments = words.map((word, idx) => ({
      id: idx + 1,
      start: Number(word.start || 0),
      end: Number(word.end || 0),
      text: String(word.punctuated_word || word.word || ""),
      translated_text: null,
    }));
  }
  if (segments.length === 0) {
    segments = [{ id: 1, start: 0, end: 0, text: transcript }];
  }
  const metadata = verboseOutput ? { raw_response: payload } : undefined;
  return {
    provider: "deepgram",
    model,
    detected_language: String((payload.results as Record<string, unknown>)?.detected_language || "") || null,
    segments,
    metadata,
  };
}

async function transcribeElevenlabs(
  apiKey: string,
  model: string,
  file: File,
  sourceLanguage: string,
  diarizationEnabled: boolean,
  speakerCount: number | null,
  timestampLevel: TimestampLevel,
  verboseOutput: boolean,
): Promise<TranscriptDocument> {
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("model_id", model);
  if (sourceLanguage !== "auto") form.set("language_code", sourceLanguage);
  if (diarizationEnabled) {
    form.set("diarize", "true");
  }
  if (speakerCount !== null) {
    form.set("num_speakers", String(speakerCount));
  }
  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`elevenlabs transcription failed: ${JSON.stringify(payload)}`);
  const words = ((payload.words as Array<Record<string, unknown>> | undefined) || []).filter((item) => item.word || item.punctuated_word);
  const segments =
    timestampLevel === "word" && words.length > 0
      ? words.map((word, idx) => ({
          id: idx + 1,
          start: Number(word.start || 0),
          end: Number(word.end || 0),
          text: String(word.punctuated_word || word.word || ""),
        }))
      : [{ id: 1, start: 0, end: 0, text: String(payload.text || "") }];
  const metadata = verboseOutput ? { raw_response: payload } : undefined;
  return {
    provider: "elevenlabs-scribe",
    model,
    detected_language: String(payload.language_code || "") || null,
    segments,
    metadata,
  };
}

async function transcribe(
  env: Env,
  provider: ProviderName,
  model: string,
  file: File,
  sourceLanguage: string,
  diarizationEnabled: boolean,
  speakerCount: number | null,
  timestampLevel: TimestampLevel,
  verboseOutput: boolean,
): Promise<TranscriptDocument> {
  const key = await getProviderKey(env, provider);
  if (!key) throw new Error(`missing API key for ${provider}`);
  if (provider === "openai") return transcribeOpenAI(key, model, file, sourceLanguage, timestampLevel, verboseOutput);
  if (provider === "deepgram") return transcribeDeepgram(key, model, file, sourceLanguage, diarizationEnabled, timestampLevel, verboseOutput);
  return transcribeElevenlabs(key, model, file, sourceLanguage, diarizationEnabled, speakerCount, timestampLevel, verboseOutput);
}

export async function applyTranslation(
  env: Env,
  provider: ProviderName,
  document: TranscriptDocument,
  target: string,
  source: string | null,
): Promise<TranscriptDocument> {
  const order = ((await getSetting(env, "translation_fallback_order")) || env.TRANSLATION_FALLBACK_ORDER)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const backend of order) {
    try {
      let key: string | null = null;
      if (backend === "native") key = await getProviderKey(env, provider);
      if (backend === "openai") key = await getProviderKey(env, "openai");
      if (backend === "deepgram") key = await getProviderKey(env, "deepgram");
      if (!key) continue;
      const translated: TranscriptSegment[] = [];
      for (const segment of document.segments) {
        if (backend === "openai" || (backend === "native" && provider === "openai")) {
          const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              temperature: 0,
              messages: [
                { role: "system", content: "You are a translation engine. Return only translated text." },
                { role: "user", content: `Translate this text${source ? ` from ${source}` : ""} to ${target}: ${segment.text}` },
              ],
            }),
          });
          const payload = (await response.json()) as Record<string, unknown>;
          if (!response.ok) {
            throw new Error(`openai translation failed: ${JSON.stringify(payload)}`);
          }
          const choices = (payload.choices as Array<Record<string, unknown>> | undefined) || [];
          const message = (choices[0]?.message as Record<string, unknown> | undefined) || {};
          const translatedText = String(message.content || "").trim();
          if (!translatedText) {
            throw new Error("openai translation returned empty text");
          }
          translated.push({ ...segment, translated_text: translatedText });
          continue;
        }
        if (backend === "deepgram" || (backend === "native" && provider === "deepgram")) {
          const response = await fetch("https://api.deepgram.com/v1/translate", {
            method: "POST",
            headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ text: segment.text, target_language: target, source_language: source }),
          });
          const payload = (await response.json()) as Record<string, unknown>;
          if (!response.ok) {
            throw new Error(`deepgram translation failed: ${JSON.stringify(payload)}`);
          }
          const translatedText = String(payload.translated_text || "").trim();
          if (!translatedText) {
            throw new Error("deepgram translation returned empty text");
          }
          translated.push({ ...segment, translated_text: translatedText });
          continue;
        }
        translated.push({ ...segment, translated_text: segment.text });
      }
      return { ...document, segments: translated };
    } catch {
      continue;
    }
  }
  return document;
}

export async function processJob(env: Env, jobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<Record<string, unknown>>();
  if (!job || ["completed", "failed", "cancelled"].includes(String(job.status))) return;
  await env.DB.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").bind(nowIso(), jobId).run();
  const filesRes = await env.DB.prepare("SELECT * FROM job_files WHERE job_id = ? ORDER BY created_at ASC").bind(jobId).all<Record<string, unknown>>();
  const options = parseJson<Record<string, unknown>>(String(job.options_json || "{}"), {});
  let formats: OutputFormat[];
  try {
    const rawFormats =
      Array.isArray(options.formats) && options.formats.length > 0
        ? options.formats.map((item) => String(item)).join(",")
        : "json,txt";
    formats = parseRequestedFormats(rawFormats);
  } catch {
    formats = ["json", "txt"];
  }
  const diarizationEnabled = Boolean(options.diarization_enabled ?? false);
  const speakerCountRaw = options.speaker_count;
  const parsedSpeakerCount =
    speakerCountRaw == null || speakerCountRaw === "" ? null : Number(speakerCountRaw);
  const speakerCount = typeof parsedSpeakerCount === "number" && Number.isFinite(parsedSpeakerCount) ? parsedSpeakerCount : null;
  const timestampLevel = options.timestamp_level === "word" ? "word" : "segment";
  const verboseOutput = Boolean(options.verbose_output ?? false);
  let processed = 0;
  let failed = 0;
  let cancelled = false;

  for (const row of filesRes.results || []) {
    const current = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    if (!current || current.status === "cancelled") {
      cancelled = true;
      break;
    }
    const fileId = String(row.id);
    await env.DB.prepare("UPDATE job_files SET status = 'running', updated_at = ? WHERE id = ?").bind(nowIso(), fileId).run();
    try {
      const object = await env.STORAGE.get(String(row.storage_path));
      if (!object) throw new Error("missing upload blob");
      const file = new File([await object.arrayBuffer()], String(row.input_name), { type: object.httpMetadata?.contentType });
      let document = await transcribe(
        env,
        String(job.provider) as ProviderName,
        String(job.model),
        file,
        String(job.source_language),
        diarizationEnabled,
        speakerCount,
        timestampLevel,
        verboseOutput,
      );
      if (Number(job.translation_enabled) && job.target_language) {
        document = await applyTranslation(env, String(job.provider) as ProviderName, document, String(job.target_language), document.detected_language || null);
      }
      const translatedExists = document.segments.some((s) => Boolean(s.translated_text));
      const prefix = safePrefix(String(row.input_name));
      for (const format of formats) {
        const variants = format === "srt" || format === "vtt" || format === "txt" ? ["source", ...(translatedExists ? ["translated"] : [])] : ["combined"];
        for (const variant of variants) {
          const name = format === "json" ? `${prefix}__transcript.json` : format === "html" ? `${prefix}__combined.html` : `${prefix}__${variant}.${format}`;
          const body = render(document, format, variant as "source" | "translated" | "combined");
          const path = `artifacts/${jobId}/${fileId}/${name}`;
          await env.STORAGE.put(path, body, {
            httpMetadata: { contentType: format === "json" ? "application/json" : format === "html" ? "text/html" : format === "vtt" ? "text/vtt" : "text/plain" },
          });
          await env.DB.prepare(
            "INSERT INTO artifacts (id, job_id, file_id, format, variant, name, mime_type, kind, storage_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
            .bind(
              uid(),
              jobId,
              fileId,
              format,
              format === "json" || format === "html" ? null : variant,
              name,
              format === "json" ? "application/json" : format === "html" ? "text/html" : format === "vtt" ? "text/vtt" : "text/plain",
              format === "json" || format === "html" ? "combined" : variant,
              path,
              enc.encode(body).byteLength,
              nowIso(),
            )
            .run();
        }
      }
      await env.DB.prepare("UPDATE job_files SET status = 'completed', detected_language = ?, updated_at = ? WHERE id = ?")
        .bind(document.detected_language || null, nowIso(), fileId)
        .run();
      processed += 1;
    } catch (error) {
      failed += 1;
      await env.DB.prepare("UPDATE job_files SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify({ code: "file_processing_failed", message: String(error) }), nowIso(), fileId)
        .run();
    }
  }

  if (cancelled) {
    return;
  }

  const artifactsRes = await env.DB.prepare("SELECT * FROM artifacts WHERE job_id = ?").bind(jobId).all<Record<string, unknown>>();
  const zip = new JSZip();
  zip.file(
    "job_manifest.json",
    JSON.stringify({ job_id: jobId, generated_at: nowIso(), processed_files: processed, failed_files: failed }, null, 2),
  );
  for (const artifact of artifactsRes.results || []) {
    const object = await env.STORAGE.get(String(artifact.storage_path));
    if (object) zip.file(String(artifact.name), await object.arrayBuffer());
  }
  const zipBuffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const bundlePath = `bundles/${jobId}.zip`;
  await env.STORAGE.put(bundlePath, zipBuffer, { httpMetadata: { contentType: "application/zip" } });
  await env.DB.prepare(
    "INSERT INTO artifacts (id, job_id, file_id, format, variant, name, mime_type, kind, storage_path, size_bytes, created_at) VALUES (?, ?, NULL, 'zip', NULL, ?, 'application/zip', 'bundle', ?, ?, ?)",
  )
    .bind(uid(), jobId, `${jobId}.zip`, bundlePath, zipBuffer.byteLength, nowIso())
    .run();

  const status = processed === 0 && failed > 0 ? "failed" : "completed";
  const errorJson = status === "failed" ? JSON.stringify({ code: "job_failed", message: "All files failed to process." }) : null;
  await env.DB.prepare("UPDATE jobs SET status = ?, error_json = ?, result_json = ?, updated_at = ? WHERE id = ?")
    .bind(status, errorJson, JSON.stringify({ processed_files: processed, failed_files: failed }), nowIso(), jobId)
    .run();
}

app.get("/api/capabilities", (c) => c.json({ providers: PROVIDERS }));

app.get("/api/settings/keys", async (c) => {
  const rows = await c.env.DB.prepare("SELECT provider, updated_at FROM api_keys ORDER BY provider ASC").all<{ provider: string; updated_at: string }>();
  const map = new Map((rows.results || []).map((row) => [row.provider, row.updated_at]));
  return c.json(
    PROVIDERS.map((p) => ({ provider: p.provider, configured: map.has(p.provider), updated_at: map.get(p.provider) || null })),
  );
});

app.put("/api/settings/keys/:provider", async (c) => {
  const provider = c.req.param("provider");
  const body = await c.req.json<{ provider: string; key: string }>();
  if (provider !== body.provider) return c.json({ error: "provider path/body mismatch" }, 400);
  if (!isSupportedProvider(provider)) return c.json({ error: `unsupported provider '${provider}'` }, 400);
  const encrypted = await encryptSecret(c.env.TM_ENCRYPTION_KEY, body.key);
  await c.env.DB.prepare(
    "INSERT INTO api_keys (provider, encrypted_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET encrypted_key = excluded.encrypted_key, updated_at = excluded.updated_at",
  )
    .bind(provider, encrypted, nowIso())
    .run();
  return c.json({ provider, configured: true });
});

app.delete("/api/settings/keys/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isSupportedProvider(provider)) return c.json({ error: `unsupported provider '${provider}'` }, 400);
  await c.env.DB.prepare("DELETE FROM api_keys WHERE provider = ?").bind(provider).run();
  return c.json({ provider, configured: false });
});

app.get("/api/settings/app", async (c) => {
  const syncSize = Number((await getSetting(c.env, "sync_size_threshold_mb")) || c.env.SYNC_SIZE_THRESHOLD_MB || "20");
  const retention = Number((await getSetting(c.env, "retention_days")) || c.env.RETENTION_DAYS || "7");
  const fallback = ((await getSetting(c.env, "translation_fallback_order")) || c.env.TRANSLATION_FALLBACK_ORDER)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return c.json({
    app_mode: "cloudflare",
    sync_size_threshold_mb: syncSize,
    retention_days: retention,
    translation_fallback_order: fallback,
    local_folder_allowlist: [],
  });
});

app.put("/api/settings/app", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (body.sync_size_threshold_mb != null) await setSetting(c.env, "sync_size_threshold_mb", String(body.sync_size_threshold_mb));
  if (body.retention_days != null) await setSetting(c.env, "retention_days", String(body.retention_days));
  if (body.translation_fallback_order != null) await setSetting(c.env, "translation_fallback_order", (body.translation_fallback_order as string[]).join(","));
  const syncSize = Number((await getSetting(c.env, "sync_size_threshold_mb")) || c.env.SYNC_SIZE_THRESHOLD_MB || "20");
  const retention = Number((await getSetting(c.env, "retention_days")) || c.env.RETENTION_DAYS || "7");
  const fallback = ((await getSetting(c.env, "translation_fallback_order")) || c.env.TRANSLATION_FALLBACK_ORDER)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return c.json({
    app_mode: "cloudflare",
    sync_size_threshold_mb: syncSize,
    retention_days: retention,
    translation_fallback_order: fallback,
    local_folder_allowlist: [],
  });
});

app.post("/api/jobs", async (c) => {
  const form = await c.req.formData();
  const provider = String(form.get("provider") || "") as ProviderName;
  const model = String(form.get("model") || "");
  const sourceLanguage = String(form.get("source_language") || "auto");
  const translationEnabled = parseBooleanFlag(form.get("translation_enabled"), false);
  const diarizationEnabled = parseBooleanFlag(form.get("diarization_enabled"), false);
  const syncPreferred = parseBooleanFlag(form.get("sync_preferred"), true);
  const verboseOutput = parseBooleanFlag(form.get("verbose_output"), false);
  const targetLanguageRaw = form.get("target_language") ? String(form.get("target_language")).trim() : "";
  const targetLanguage = translationEnabled && targetLanguageRaw ? targetLanguageRaw : null;
  let timestampLevel: TimestampLevel;
  try {
    timestampLevel = parseTimestampLevel(String(form.get("timestamp_level") || "segment"));
  } catch (error) {
    return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
  }
  const speakerCountRaw = String(form.get("speaker_count") || "").trim();
  const speakerCount = speakerCountRaw ? Number(speakerCountRaw) : null;
  const batchLabel = form.get("batch_label") ? String(form.get("batch_label")) : null;
  let formats: OutputFormat[];
  try {
    formats = parseRequestedFormatsFromForm(form);
  } catch (error) {
    return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
  }
  const files = form.getAll("files").filter((item): item is File => item instanceof File);
  if (!files.length) return c.json({ error: "at least one file is required" }, 400);
  if (!isSupportedProvider(provider)) return c.json({ error: "unsupported provider" }, 400);
  if (!model) return c.json({ error: "model is required" }, 400);
  if (!isSupportedModel(provider, model)) {
    return c.json({ error: `unsupported model '${model}' for provider '${provider}'` }, 400);
  }
  if (translationEnabled && !targetLanguage) {
    return c.json({ error: "target_language is required when translation_enabled is true" }, 400);
  }
  if (speakerCount !== null && (!Number.isFinite(speakerCount) || !Number.isInteger(speakerCount) || speakerCount < 1)) {
    return c.json({ error: "speaker_count must be a positive integer" }, 400);
  }
  const effectiveSpeakerCount = diarizationEnabled ? speakerCount : null;

  const jobId = uid();
  const time = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO jobs (id, status, provider, model, source_language, target_language, translation_enabled, options_json, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      jobId,
      provider,
      model,
      sourceLanguage,
      targetLanguage,
      translationEnabled ? 1 : 0,
      JSON.stringify({
        formats,
        diarization_enabled: diarizationEnabled,
        speaker_count: effectiveSpeakerCount,
        sync_preferred: syncPreferred,
        timestamp_level: timestampLevel,
        verbose_output: verboseOutput,
        batch_label: batchLabel,
      }),
      time,
      time,
    )
    .run();

  for (const file of files) {
    const fileId = uid();
    const storagePath = `uploads/${jobId}/${fileId}/${file.name}`;
    await c.env.STORAGE.put(storagePath, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    await c.env.DB.prepare(
      "INSERT INTO job_files (id, job_id, input_name, input_source, size_bytes, storage_path, status, created_at, updated_at) VALUES (?, ?, ?, 'upload', ?, ?, 'queued', ?, ?)",
    )
      .bind(fileId, jobId, file.name, file.size, storagePath, time, time)
      .run();
  }

  await c.env.JOB_QUEUE.send({ jobId });
  return c.json({ id: jobId, status: "queued" });
});

app.post("/api/jobs/from-folder", () => new Response(JSON.stringify({ error: "folder ingestion is local-only" }), { status: 400 }));

app.get("/api/jobs", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").all<Record<string, unknown>>();
  return c.json(
    (rows.results || []).map((job) => ({
      ...job,
      warning_json: parseJson(job.warning_json as string | null, null),
      error_json: parseJson(job.error_json as string | null, null),
      result_json: parseJson(job.result_json as string | null, null),
      options_json: parseJson(job.options_json as string | null, null),
    })),
  );
});

app.get("/api/jobs/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<Record<string, unknown>>();
  if (!job) return c.json({ error: "job not found" }, 404);
  const files = await c.env.DB.prepare("SELECT * FROM job_files WHERE job_id = ? ORDER BY created_at ASC").bind(jobId).all<Record<string, unknown>>();
  const artifacts = await c.env.DB.prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at ASC").bind(jobId).all<Record<string, unknown>>();
  return c.json({
    ...job,
    warning_json: parseJson(job.warning_json as string | null, null),
    error_json: parseJson(job.error_json as string | null, null),
    result_json: parseJson(job.result_json as string | null, null),
    files: files.results || [],
    artifacts: artifacts.results || [],
  });
});

app.get("/api/jobs/:jobId/artifacts", async (c) => {
  const artifacts = await c.env.DB.prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at ASC")
    .bind(c.req.param("jobId"))
    .all<Record<string, unknown>>();
  return c.json(artifacts.results || []);
});

app.get("/api/jobs/:jobId/artifacts/:artifactId", async (c) => {
  const artifact = await c.env.DB.prepare("SELECT * FROM artifacts WHERE id = ? AND job_id = ?")
    .bind(c.req.param("artifactId"), c.req.param("jobId"))
    .first<Record<string, unknown>>();
  if (!artifact) return c.json({ error: "artifact not found" }, 404);
  const object = await c.env.STORAGE.get(String(artifact.storage_path));
  if (!object) return c.json({ error: "artifact object missing" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": String(artifact.mime_type),
      "content-disposition": `attachment; filename="${String(artifact.name)}"`,
    },
  });
});

app.get("/api/jobs/:jobId/bundle.zip", async (c) => {
  const artifact = await c.env.DB.prepare("SELECT * FROM artifacts WHERE job_id = ? AND kind = 'bundle' ORDER BY created_at DESC LIMIT 1")
    .bind(c.req.param("jobId"))
    .first<Record<string, unknown>>();
  if (!artifact) return c.json({ error: "bundle not found" }, 404);
  const object = await c.env.STORAGE.get(String(artifact.storage_path));
  if (!object) return c.json({ error: "bundle object missing" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${String(artifact.name)}"`,
    },
  });
});

app.post("/api/jobs/:jobId/cancel", async (c) => {
  const jobId = c.req.param("jobId");
  await c.env.DB.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(nowIso(), jobId).run();
  await c.env.DB.prepare("UPDATE job_files SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('queued', 'running')")
    .bind(nowIso(), jobId)
    .run();
  return c.json({ id: jobId, status: "cancelled" });
});

function page(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:Segoe UI,Tahoma,sans-serif;margin:24px;"><nav><a href="/jobs">Jobs</a> | <a href="/jobs/new">New Job</a> | <a href="/settings">Settings</a></nav>${content}</body></html>`;
}

app.get("/", (c) => c.redirect("/jobs"));
app.get("/settings", () => {
  const providerRows = PROVIDERS.map(
    (provider) =>
      `<tr data-provider="${provider.provider}"><td><code>${provider.provider}</code></td><td>${provider.models.join(
        ", ",
      )}</td><td class="key-status">loading...</td><td><input class="key-input" type="password" autocomplete="off" placeholder="Paste API key" style="width:100%;"/></td><td><button type="button" class="save-key">Save</button> <button type="button" class="delete-key">Delete</button></td></tr>`,
  ).join("");
  return new Response(
    page(
      "Settings",
      `<h2>Settings</h2>
      <p>Provider API keys are encrypted at rest. Paste a key and click Save to store it for this deployment.</p>
      <div style="overflow:auto;max-width:1100px;">
        <table style="border-collapse:collapse;width:100%;">
          <thead>
            <tr>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Provider</th>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Models</th>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Status</th>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">API Key</th>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Actions</th>
            </tr>
          </thead>
          <tbody>${providerRows}</tbody>
        </table>
      </div>
      <pre id="settings-result" style="margin-top:12px;"></pre>
      <script>
        const rows = Array.from(document.querySelectorAll('tr[data-provider]'));
        const statusBox = document.getElementById('settings-result');

        function setStatus(message, isError) {
          statusBox.textContent = message;
          statusBox.style.color = isError ? '#b91c1c' : '#166534';
        }

        async function refreshKeys() {
          const response = await fetch('/api/settings/keys');
          if (!response.ok) {
            setStatus(await response.text(), true);
            return;
          }
          const payload = await response.json();
          const byProvider = {};
          for (const item of payload) {
            byProvider[item.provider] = item;
          }
          for (const row of rows) {
            const provider = row.getAttribute('data-provider');
            const statusCell = row.querySelector('.key-status');
            const info = byProvider[provider];
            if (info && info.configured) {
              const updated = info.updated_at ? ' (' + info.updated_at + ')' : '';
              statusCell.textContent = 'configured' + updated;
              statusCell.style.color = '#166534';
            } else {
              statusCell.textContent = 'not configured';
              statusCell.style.color = '#b91c1c';
            }
          }
        }

        async function saveKey(row) {
          const provider = row.getAttribute('data-provider');
          const input = row.querySelector('.key-input');
          const key = (input.value || '').trim();
          if (!key) {
            setStatus('API key is required for ' + provider, true);
            return;
          }
          const response = await fetch('/api/settings/keys/' + encodeURIComponent(provider), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider, key }),
          });
          if (!response.ok) {
            setStatus(await response.text(), true);
            return;
          }
          input.value = '';
          setStatus('Saved key for ' + provider, false);
          await refreshKeys();
        }

        async function deleteKey(row) {
          const provider = row.getAttribute('data-provider');
          const response = await fetch('/api/settings/keys/' + encodeURIComponent(provider), { method: 'DELETE' });
          if (!response.ok) {
            setStatus(await response.text(), true);
            return;
          }
          const input = row.querySelector('.key-input');
          input.value = '';
          setStatus('Deleted key for ' + provider, false);
          await refreshKeys();
        }

        for (const row of rows) {
          row.querySelector('.save-key').addEventListener('click', () => saveKey(row));
          row.querySelector('.delete-key').addEventListener('click', () => deleteKey(row));
        }

        refreshKeys();
      </script>`,
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
});
app.get("/jobs", () =>
  new Response(
    page(
      "Jobs",
      `<h2>Jobs</h2>
      <p>Inspect previous jobs, copy output JSON, and download bundles/artifacts.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;align-items:start;">
        <section>
          <div style="margin-bottom:10px;">
            <button type="button" id="refresh-jobs">Refresh Jobs</button>
          </div>
          <div style="overflow:auto;max-height:70vh;border:1px solid #ddd;">
            <table style="border-collapse:collapse;width:100%;">
              <thead>
                <tr>
                  <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Job ID</th>
                  <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Status</th>
                  <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Provider</th>
                  <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px;">Actions</th>
                </tr>
              </thead>
              <tbody id="jobs-table-body">
                <tr><td colspan="4" style="padding:8px;">Loading...</td></tr>
              </tbody>
            </table>
          </div>
        </section>
        <section>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
            <strong>Output</strong>
            <button type="button" id="copy-job-output">Copy Output</button>
          </div>
          <pre id="job-output" style="min-height:220px;border:1px solid #ddd;padding:12px;overflow:auto;">Select a job to view details.</pre>
          <h3 style="margin-top:14px;">Downloads</h3>
          <ul id="job-downloads">
            <li>Select a job to list downloadable artifacts.</li>
          </ul>
        </section>
      </div>
      <script>
        const jobsBody = document.getElementById('jobs-table-body');
        const outputPre = document.getElementById('job-output');
        const downloadsList = document.getElementById('job-downloads');
        const refreshButton = document.getElementById('refresh-jobs');
        const copyButton = document.getElementById('copy-job-output');
        let selectedJobId = null;

        function escapeHtml(value) {
          return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
        }

        function renderJobsTable(rows) {
          if (!rows.length) {
            jobsBody.innerHTML = '<tr><td colspan="4" style="padding:8px;">No jobs found.</td></tr>';
            return;
          }
          jobsBody.innerHTML = rows.map((job) => {
            const isSelected = selectedJobId === job.id;
            const viewLabel = isSelected ? 'Viewing' : 'View Output';
            const bundleLink = '<a href="/api/jobs/' + encodeURIComponent(job.id) + '/bundle.zip">Bundle</a>';
            return '<tr>' +
              '<td style="border-bottom:1px solid #eee;padding:8px;"><code>' + escapeHtml(job.id) + '</code></td>' +
              '<td style="border-bottom:1px solid #eee;padding:8px;">' + escapeHtml(job.status || '') + '</td>' +
              '<td style="border-bottom:1px solid #eee;padding:8px;">' + escapeHtml((job.provider || '') + ' / ' + (job.model || '')) + '</td>' +
              '<td style="border-bottom:1px solid #eee;padding:8px;"><button type="button" class="view-job" data-job-id="' + escapeHtml(job.id) + '">' + viewLabel + '</button> ' + bundleLink + '</td>' +
              '</tr>';
          }).join('');
        }

        function renderDownloads(jobDetail) {
          const links = [];
          const jobId = String(jobDetail.id || '');
          if (jobId) {
            links.push('<li><a href="/api/jobs/' + encodeURIComponent(jobId) + '/bundle.zip">Download Bundle (.zip)</a></li>');
          }
          const allArtifacts = [];
          for (const artifact of (jobDetail.artifacts || [])) {
            allArtifacts.push(artifact);
          }
          for (const file of (jobDetail.files || [])) {
            for (const artifact of (file.artifacts || [])) {
              allArtifacts.push(artifact);
            }
          }
          for (const artifact of allArtifacts) {
            if (!artifact || !artifact.id) continue;
            const href = '/api/jobs/' + encodeURIComponent(jobId) + '/artifacts/' + encodeURIComponent(String(artifact.id));
            const label = artifact.name || artifact.id;
            links.push('<li><a href="' + href + '">' + escapeHtml(label) + '</a></li>');
          }
          downloadsList.innerHTML = links.length ? links.join('') : '<li>No downloadable artifacts available yet.</li>';
        }

        async function viewJob(jobId) {
          selectedJobId = jobId;
          const response = await fetch('/api/jobs/' + encodeURIComponent(jobId));
          if (!response.ok) {
            outputPre.textContent = await response.text();
            downloadsList.innerHTML = '<li>No downloadable artifacts available.</li>';
            return;
          }
          const detail = await response.json();
          outputPre.textContent = JSON.stringify(detail, null, 2);
          renderDownloads(detail);
          await loadJobs();
        }

        async function loadJobs() {
          const response = await fetch('/api/jobs');
          if (!response.ok) {
            jobsBody.innerHTML = '<tr><td colspan="4" style="padding:8px;">' + escapeHtml(await response.text()) + '</td></tr>';
            return;
          }
          const rows = await response.json();
          renderJobsTable(rows);
        }

        jobsBody.addEventListener('click', async (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          if (!target.classList.contains('view-job')) return;
          const jobId = target.getAttribute('data-job-id');
          if (!jobId) return;
          await viewJob(jobId);
        });

        refreshButton.addEventListener('click', loadJobs);
        copyButton.addEventListener('click', async () => {
          const text = outputPre.textContent || '';
          if (!text.trim()) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return;
          }
          const area = document.createElement('textarea');
          area.value = text;
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
        });

        loadJobs();
      </script>`,
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  ));
app.get("/jobs/new", () =>
  {
    const providerOptions = PROVIDERS.map((provider, index) => {
      const selected = index === 0 ? ' selected="selected"' : "";
      return `<option value="${provider.provider}"${selected}>${provider.provider}</option>`;
    }).join("");
    const initialModels = PROVIDERS[0].models;
    const modelOptions = initialModels.map((model, index) => {
      const selected = index === 0 ? ' selected="selected"' : "";
      return `<option value="${model}"${selected}>${model}</option>`;
    }).join("");
    const providerModels = Object.fromEntries(PROVIDERS.map((provider) => [provider.provider, provider.models]));
    const formatCheckboxes = VALID_FORMATS.map((format) => {
      const checked = format === "txt" || format === "json" ? ' checked="checked"' : "";
      return `<label style="margin-right:12px;"><input type="checkbox" name="formats" value="${format}"${checked}/> ${format}</label>`;
    }).join("");
    return new Response(
      page(
        "New Job",
        `<h2>Create Job</h2>
        <form id="job-form">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;max-width:960px;">
            <label>Provider
              <select id="provider-select" name="provider" required>${providerOptions}</select>
            </label>
            <label>Model
              <select id="model-select" name="model" required>${modelOptions}</select>
            </label>
            <label>Source Language
              <input name="source_language" value="auto" placeholder="auto or ISO code"/>
            </label>
            <label>Timestamp Level
              <select name="timestamp_level">
                <option value="segment" selected="selected">segment</option>
                <option value="word">word</option>
              </select>
            </label>
            <label>Speaker Count
              <input id="speaker-count" type="number" name="speaker_count" min="1" step="1" placeholder="optional"/>
            </label>
            <label>Target Language
              <input id="target-language" name="target_language" placeholder="e.g. es, fr, de"/>
            </label>
            <label>Batch Label
              <input name="batch_label" placeholder="optional label"/>
            </label>
          </div>
          <fieldset style="margin-top:14px;">
            <legend>Output Formats</legend>
            ${formatCheckboxes}
          </fieldset>
          <fieldset style="margin-top:14px;">
            <legend>Job Options</legend>
            <label style="margin-right:12px;"><input id="translation-enabled" type="checkbox"/> Translation Enabled</label>
            <label style="margin-right:12px;"><input id="diarization-enabled" type="checkbox" name="diarization_enabled"/> Diarization</label>
            <label style="margin-right:12px;"><input id="verbose-output" type="checkbox" name="verbose_output"/> Verbose Output</label>
            <label style="margin-right:12px;"><input id="sync-preferred" type="checkbox" name="sync_preferred" checked="checked"/> Prefer Sync (if eligible)</label>
          </fieldset>
          <div style="margin-top:14px;">
            <input type="file" name="files" multiple required />
          </div>
          <div style="margin-top:14px;">
            <button type="submit">Submit Job</button>
          </div>
        </form>
        <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button type="button" id="copy-job-response">Copy Output</button>
          <a id="open-created-job" href="#" style="display:none;">Open Job</a>
          <a id="download-created-bundle" href="#" style="display:none;">Download Bundle</a>
        </div>
        <pre id="job-response">No submission yet.</pre>
        <script>
          const providerModels = ${JSON.stringify(providerModels)};
          const form = document.getElementById('job-form');
          const result = document.getElementById('job-response');
          const copyResultButton = document.getElementById('copy-job-response');
          const openJobLink = document.getElementById('open-created-job');
          const bundleLink = document.getElementById('download-created-bundle');
          const providerSelect = document.getElementById('provider-select');
          const modelSelect = document.getElementById('model-select');
          const translationToggle = document.getElementById('translation-enabled');
          const targetLanguage = document.getElementById('target-language');
          const diarizationToggle = document.getElementById('diarization-enabled');
          const speakerCount = document.getElementById('speaker-count');
          const verboseOutput = document.getElementById('verbose-output');
          const syncPreferred = document.getElementById('sync-preferred');

          function refreshModels() {
            const models = providerModels[providerSelect.value] || [];
            const selected = modelSelect.value;
            modelSelect.innerHTML = models.map((model) => '<option value="' + model + '">' + model + '</option>').join('');
            if (models.includes(selected)) {
              modelSelect.value = selected;
            }
          }

          function refreshTranslation() {
            targetLanguage.disabled = !translationToggle.checked;
            if (!translationToggle.checked) {
              targetLanguage.value = '';
            }
          }

          function refreshDiarization() {
            speakerCount.disabled = !diarizationToggle.checked;
            if (!diarizationToggle.checked) {
              speakerCount.value = '';
            }
          }

          providerSelect.addEventListener('change', refreshModels);
          translationToggle.addEventListener('change', refreshTranslation);
          diarizationToggle.addEventListener('change', refreshDiarization);
          refreshModels();
          refreshTranslation();
          refreshDiarization();

          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const body = new FormData(form);
            if (body.getAll('formats').length === 0) {
              result.textContent = JSON.stringify({ error: 'at least one output format is required' }, null, 2);
              return;
            }
            body.set('translation_enabled', translationToggle.checked ? 'true' : 'false');
            body.set('diarization_enabled', diarizationToggle.checked ? 'true' : 'false');
            body.set('verbose_output', verboseOutput.checked ? 'true' : 'false');
            body.set('sync_preferred', syncPreferred.checked ? 'true' : 'false');
            if (!translationToggle.checked) {
              body.delete('target_language');
            }
            const response = await fetch('/api/jobs', { method: 'POST', body });
            const raw = await response.text();
            let parsed = null;
            try {
              parsed = JSON.parse(raw);
            } catch {}
            result.textContent = parsed ? JSON.stringify(parsed, null, 2) : raw;
            if (response.ok && parsed && parsed.id) {
              const id = String(parsed.id);
              openJobLink.href = '/jobs';
              openJobLink.textContent = 'Open Job List';
              openJobLink.style.display = 'inline';
              bundleLink.href = '/api/jobs/' + encodeURIComponent(id) + '/bundle.zip';
              bundleLink.style.display = 'inline';
            } else {
              openJobLink.style.display = 'none';
              bundleLink.style.display = 'none';
            }
          });

          copyResultButton.addEventListener('click', async () => {
            const text = result.textContent || '';
            if (!text.trim()) return;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(text);
              return;
            }
            const area = document.createElement('textarea');
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
          });
        </script>`,
      ),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  });

export async function cleanupExpiredData(env: Env): Promise<void> {
  const days = Number((await getSetting(env, "retention_days")) || env.RETENTION_DAYS || "7");
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const artifactRows = await env.DB.prepare("SELECT storage_path FROM artifacts WHERE created_at < ?").bind(cutoff).all<{ storage_path: string }>();
  const uploadRows = await env.DB.prepare("SELECT storage_path FROM job_files WHERE updated_at < ?").bind(cutoff).all<{ storage_path: string }>();
  const allPaths = new Set<string>();
  for (const item of artifactRows.results || []) {
    allPaths.add(item.storage_path);
  }
  for (const item of uploadRows.results || []) {
    allPaths.add(item.storage_path);
  }
  for (const path of allPaths) {
    await env.STORAGE.delete(path);
  }

  await env.DB.prepare("DELETE FROM artifacts WHERE created_at < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM job_files WHERE updated_at < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM jobs WHERE updated_at < ?").bind(cutoff).run();
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ jobId: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processJob(env, message.body.jobId);
      message.ack();
    }
  },
  async scheduled(_: ScheduledEvent, env: Env): Promise<void> {
    await cleanupExpiredData(env);
  },
};
