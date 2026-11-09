/**
 * Gemini calls for transcription and AI tools.
 *
 * - Asks the API which models each key can use, so retired models
 *   (for example gemini-2.5-flash-lite) are skipped automatically.
 * - Remembers the model that worked, so later requests go straight to it.
 * - Keeps model "thinking" minimal, which makes transcription much faster.
 * - Spreads requests over all configured keys and fails over on quota errors.
 * - Gives each request a time limit; if Google is slow, moves on to the next model.
 */
import { env } from "cloudflare:workers";

const DEFAULT_API = "https://generativelanguage.googleapis.com/v1beta";

export const MODES = {
  smart: "Smart clean transcript",
  detailed: "Detailed subtitles + speakers",
  verbatim: "Exact verbatim transcript",
} as const;
export type Mode = keyof typeof MODES;

export const LANGUAGES: Record<string, string[]> = {
  "Auto detect / mixed language": [],
  "Bangla (Bangladesh)": ["bn-BD"],
  "English (US)": ["en-US"],
  "English (UK)": ["en-GB"],
  Arabic: ["ar-EG"],
  Hindi: ["hi-IN"],
};

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

export interface TranscribeResult {
  transcript: string;
  segments: Segment[];
  model: string;
}

export type AudioInput =
  | { kind: "inline"; mimeType: string; data: ArrayBuffer }
  | { kind: "youtube"; url: string; startSeconds?: number; endSeconds?: number };

const PREFERRED_MODELS = [
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
];
const SKIP_WORDS = ["image", "tts", "live", "audio", "embedding", "transcribe", "thinking-exp"];

export class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class UserFacingError extends Error {}

// Per-isolate caches. Isolates are short-lived, so these are only a speed-up.
const modelListCache = new Map<string, { at: number; models: string[] }>();
const workingModel = new Map<string, string>();
const badModels = new Map<string, Set<string>>();
const noThinkingModels = new Set<string>();
const keyCooldownUntil = new Map<string, number>();
// Models that recently timed out are tried last for a while.
const slowModelUntil = new Map<string, number>();
const SLOW_MODEL_PENALTY_MS = 10 * 60_000;
let keyCursor = 0;

export function apiKeys(): string[] {
  const raw = [env.GEMINI_API_KEYS, env.GEMINI_API_KEY].filter(Boolean).join(",");
  return [...new Set(raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean))];
}

function keyId(key: string): string {
  return key.slice(-8);
}

async function geminiFetch(key: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  const base = env.GEMINI_API_BASE || DEFAULT_API; // Overridable for local tests only.
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${base}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error: any) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new GeminiError(504, `Google did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw error;
  }
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { message: text.slice(0, 300) } };
  }
  if (!response.ok) {
    throw new GeminiError(response.status, String(payload?.error?.message || response.statusText || "Gemini error"));
  }
  return payload;
}

async function listModels(key: string): Promise<string[]> {
  const cached = modelListCache.get(keyId(key));
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.models;
  try {
    const payload = await geminiFetch(key, "models?pageSize=1000", undefined, 8_000);
    const models = (payload.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m: any) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
    modelListCache.set(keyId(key), { at: Date.now(), models });
    return models;
  } catch (error) {
    if (error instanceof GeminiError && [400, 401, 403].includes(error.status)) throw error;
    return [];
  }
}

async function candidateModels(key: string): Promise<string[]> {
  const preferred = [env.GEMINI_MODEL, ...PREFERRED_MODELS].filter(Boolean) as string[];
  const available = await listModels(key);
  let candidates: string[];
  if (available.length) {
    const listed = preferred.filter((m) => available.includes(m));
    const extra = available
      .filter((m) => m.includes("flash") && !listed.includes(m) && !SKIP_WORDS.some((w) => m.includes(w)))
      .sort()
      .reverse();
    candidates = [...listed, ...extra];
  } else {
    candidates = preferred;
  }
  const bad = badModels.get(keyId(key)) || new Set();
  candidates = candidates.filter((m) => !bad.has(m));
  if (!candidates.length) candidates = preferred;
  const working = workingModel.get(keyId(key));
  if (working && !bad.has(working)) candidates = [working, ...candidates.filter((m) => m !== working)];
  const now = Date.now();
  const isSlow = (m: string) => (slowModelUntil.get(m) || 0) > now;
  candidates = [...candidates.filter((m) => !isSlow(m)), ...candidates.filter(isSlow)];
  return [...new Set(candidates)];
}

function thinkingConfig(model: string): Record<string, unknown> | undefined {
  if (noThinkingModels.has(model)) return undefined;
  if (model.includes("2.5")) return { thinkingBudget: 0 };
  return { thinkingLevel: "MINIMAL" };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GenerateOptions {
  schema?: unknown;
  json?: boolean;
  mediaResolutionLow?: boolean;
  fastThinking?: boolean;
  /** Time limit for one model call before moving on to the next model. */
  timeoutMs?: number;
}

/** Run one generateContent request, trying models until one works for this key. */
async function generateWithKey(
  key: string,
  parts: unknown[],
  options: GenerateOptions,
): Promise<{ text: string; model: string }> {
  const failures: string[] = [];
  let rateLimited: GeminiError | null = null;

  for (const model of await candidateModels(key)) {
    let useThinking = options.fastThinking !== false;
    let useSchema = Boolean(options.schema);
    for (let attempt = 0; attempt < 5; attempt++) {
      const generationConfig: Record<string, unknown> = {};
      if (options.json || options.schema) generationConfig.responseMimeType = "application/json";
      if (useSchema) generationConfig.responseSchema = options.schema;
      const thinking = useThinking ? thinkingConfig(model) : undefined;
      if (thinking) generationConfig.thinkingConfig = thinking;
      if (options.mediaResolutionLow) generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
      const started = Date.now();
      try {
        const payload = await geminiFetch(key, `models/${model}:generateContent`, {
          contents: [{ role: "user", parts }],
          generationConfig,
        }, options.timeoutMs);
        console.log(JSON.stringify({ gemini: model, ms: Date.now() - started, ok: true }));
        const text = (payload.candidates?.[0]?.content?.parts || [])
          .filter((p: any) => !p.thought)
          .map((p: any) => p.text || "")
          .join("")
          .trim();
        if (!text) {
          const reason = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || "empty result";
          failures.push(`${model}: ${reason}`);
          break;
        }
        workingModel.set(keyId(key), model);
        return { text, model };
      } catch (error) {
        if (!(error instanceof GeminiError)) throw error;
        console.log(JSON.stringify({ gemini: model, ms: Date.now() - started, ok: false, status: error.status }));
        const message = error.message.toLowerCase();
        if (error.status === 504) {
          // Google is slow on this model right now: try the next one instead of waiting.
          slowModelUntil.set(model, Date.now() + SLOW_MODEL_PENALTY_MS);
          failures.push(`${model}: too slow`);
          break;
        }
        if (error.status === 401 || error.status === 403 || (error.status === 400 && message.includes("api key"))) {
          throw error; // A bad key fails the same way for every model.
        }
        if (error.status === 400 && useThinking && message.includes("think")) {
          useThinking = false;
          noThinkingModels.add(model);
          continue;
        }
        if (error.status === 400 && useSchema) {
          useSchema = false;
          continue;
        }
        if ((error.status === 500 || error.status === 503) && attempt === 0) {
          await sleep(1500);
          continue;
        }
        if (error.status === 429) {
          rateLimited = error;
          failures.push(`${model}: quota or rate limit`);
          break;
        }
        const retired =
          error.status === 404 ||
          message.includes("no longer available") ||
          (error.status === 400 && (message.includes("model") || message.includes("not supported")));
        if (retired) {
          if (!badModels.has(keyId(key))) badModels.set(keyId(key), new Set());
          badModels.get(keyId(key))!.add(model);
          failures.push(`${model}: not available for this key`);
          break;
        }
        if (error.status >= 500) {
          failures.push(`${model}: Google server busy`);
          break;
        }
        // Problems with the media itself (too long, unreadable) are not model problems.
        throw new UserFacingError(error.message);
      }
    }
  }
  if (rateLimited) throw rateLimited;
  if (failures.length && failures.every((f) => f.endsWith("too slow"))) {
    throw new UserFacingError("Google is answering slowly right now. Please try again in a moment.");
  }
  throw new UserFacingError(
    "No Gemini model could handle this request with the configured API key. " +
      "Check that the key is valid and has quota in Google AI Studio, or add a backup key." +
      (failures.length ? ` Tried: ${failures.slice(0, 6).join("; ")}.` : ""),
  );
}

/** Try every configured key, starting from a rotating position to spread load. */
async function generate(parts: unknown[], options: GenerateOptions = {}) {
  const keys = apiKeys();
  if (!keys.length) throw new UserFacingError("No Gemini API key is configured on the server (GEMINI_API_KEYS).");
  const start = keyCursor++ % keys.length;
  const ordered = [...keys.slice(start), ...keys.slice(0, start)];
  const now = Date.now();
  const ready = ordered.filter((k) => (keyCooldownUntil.get(keyId(k)) || 0) <= now);
  let lastRateLimit: GeminiError | null = null;
  for (const key of ready.length ? ready : ordered) {
    try {
      return await generateWithKey(key, parts, options);
    } catch (error) {
      if (error instanceof GeminiError && error.status === 429) {
        lastRateLimit = error;
        const daily = /per day|daily|rpd/i.test(error.message);
        keyCooldownUntil.set(keyId(key), Date.now() + (daily ? 12 * 3600_000 : 60_000));
        continue;
      }
      if (error instanceof GeminiError) throw new UserFacingError(error.message);
      throw error;
    }
  }
  throw new UserFacingError(
    "All configured Gemini API keys have reached their rate limit. Please try again in a minute or add another key." +
      (lastRateLimit ? ` (${lastRateLimit.message.slice(0, 200)})` : ""),
  );
}

function languageHint(codes: string[]): string {
  return codes.length ? codes.join(", ") : "auto-detect spoken languages and preserve code-switching";
}

const SEGMENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: { type: "STRING" },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          speaker: { type: "STRING" },
          start_seconds: { type: "NUMBER" },
          end_seconds: { type: "NUMBER" },
          text: { type: "STRING" },
        },
        required: ["start_seconds", "end_seconds", "text"],
      },
    },
  },
  required: ["transcript", "segments"],
};

function buildPrompt(mode: Mode, codes: string[], vocabulary: string[]): string {
  const vocab = vocabulary.length
    ? `\nUse these names only when they match the audio: ${vocabulary.slice(0, 100).join(", ")}`
    : "";
  const lang = languageHint(codes);
  if (mode === "detailed") {
    return `Transcribe all audible speech from this audio in its original language(s).
Language guidance: ${lang}.
Return JSON with "transcript" (complete transcription) and "segments"
(array with "start_seconds", "end_seconds", "text", and "speaker").
Times are in seconds from the start of this audio clip.
Use short subtitle segments of at most about 7 seconds. Label speakers as Speaker 1, Speaker 2, etc
only when discernible. Do not translate, summarize, invent or omit speech.
If there is no speech, return an empty transcript and no segments.${vocab}`;
  }
  if (mode === "smart") {
    return `Transcribe the complete audio in its original language(s).
Language guidance: ${lang}. Preserve facts, names, numbers and meaning.
Remove filler words, stutters and false starts; use clear punctuation and paragraphs.
Do not summarize, translate, invent words or omit complete ideas.
If there is no speech, return exactly: [no speech]
Return only the transcript.${vocab}`;
  }
  return `Transcribe the complete audio VERBATIM in its original language(s).
Language guidance: ${lang}. Preserve fillers, repetitions, false starts,
names, numbers, and the exact wording as spoken. Do not clean up, summarize,
translate or invent content. If there is no speech, return exactly: [no speech]
Return only the transcript.${vocab}`;
}

function audioParts(input: AudioInput): unknown[] {
  if (input.kind === "inline") {
    const data = Buffer.from(input.data).toString("base64");
    return [{ inlineData: { mimeType: input.mimeType, data } }];
  }
  const part: Record<string, unknown> = { fileData: { fileUri: input.url, mimeType: "video/*" } };
  if (input.startSeconds !== undefined || input.endSeconds !== undefined) {
    const meta: Record<string, string> = {};
    if (input.startSeconds !== undefined) meta.startOffset = `${Math.floor(input.startSeconds)}s`;
    if (input.endSeconds !== undefined) meta.endOffset = `${Math.ceil(input.endSeconds)}s`;
    part.videoMetadata = meta;
  }
  return [part];
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

/**
 * How long to wait for one model before trying the next.
 * A healthy answer for a short clip takes 3 to 15 seconds; longer audio gets more time.
 */
function transcribeTimeout(input: AudioInput, clipDuration?: number): number {
  let seconds = clipDuration;
  if (!seconds && input.kind === "inline" && input.mimeType.includes("wav")) {
    seconds = input.data.byteLength / 32_000; // 16 kHz mono 16-bit, as the browser sends it.
  }
  if (!seconds) return 100_000;
  return Math.min(100_000, Math.round(20_000 + seconds * 250));
}

export async function transcribe(
  input: AudioInput,
  mode: Mode,
  languageCodes: string[],
  vocabulary: string[],
  clipDuration?: number,
): Promise<TranscribeResult> {
  const prompt = buildPrompt(mode, languageCodes, vocabulary);
  const parts = [{ text: prompt }, ...audioParts(input)];
  const mediaResolutionLow = input.kind === "youtube";
  const timeoutMs = transcribeTimeout(input, clipDuration);

  if (mode !== "detailed") {
    const { text, model } = await generate(parts, { mediaResolutionLow, timeoutMs });
    const transcript = /^\[no speech\]$/i.test(text.trim()) ? "" : text.trim();
    return { transcript, segments: [], model };
  }

  const { text, model } = await generate(parts, { schema: SEGMENT_SCHEMA, mediaResolutionLow, timeoutMs });
  let payload: any;
  try {
    payload = JSON.parse(stripFences(text));
  } catch {
    // The model ignored JSON mode; keep the text and estimate timings later.
    return { transcript: stripFences(text), segments: [], model };
  }
  const clipStart = input.kind === "youtube" ? input.startSeconds || 0 : 0;
  let segments: Segment[] = [];
  for (const item of Array.isArray(payload?.segments) ? payload.segments : []) {
    const start = Math.max(0, Number(item?.start_seconds) || 0);
    const end = Math.max(start, Number(item?.end_seconds) || start);
    const value = String(item?.text || "").trim();
    if (!value) continue;
    segments.push({ start, end, text: value, speaker: String(item?.speaker || "").trim() || null });
  }
  // YouTube clips sometimes come back with times measured from the video start.
  if (clipStart > 0 && segments.length && Math.min(...segments.map((s) => s.start)) >= clipStart - 5) {
    segments = segments.map((s) => ({ ...s, start: s.start - clipStart, end: s.end - clipStart }));
  }
  if (clipDuration) {
    segments = segments
      .map((s) => ({ ...s, start: Math.min(Math.max(0, s.start), clipDuration), end: Math.min(Math.max(0, s.end), clipDuration) }))
      .filter((s) => s.end > s.start);
  }
  let transcript = String(payload?.transcript || "").trim();
  if (!transcript && segments.length) transcript = segments.map((s) => s.text).join("\n");
  return { transcript, segments, model };
}

export async function aiText(prompt: string): Promise<string> {
  const { text } = await generate([{ text: prompt }], { fastThinking: false, timeoutMs: 90_000 });
  return text;
}
