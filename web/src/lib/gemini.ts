/**
 * Gemini calls for transcription and AI tools.
 *
 * - Asks the API which models each key can use, so retired models
 *   (for example gemini-2.5-flash-lite) are skipped automatically.
 * - Remembers the model that worked, so later requests go straight to it.
 * - Keeps model "thinking" minimal, which makes transcription much faster.
 * - Spreads requests over all configured keys and fails over on quota errors.
 */
import { env } from "cloudflare:workers";
import { transcriptionQualityIssue } from "./transcription-quality";
import { cleanShayari, formatShayari, isEmptyShayari, type ShayariSections } from "./shayari";

const DEFAULT_API = "https://generativelanguage.googleapis.com/v1beta";

export const MODES = {
  smart: "Smart clean transcript",
  detailed: "Detailed subtitles + speakers",
  verbatim: "Exact verbatim transcript",
  shayari: "Shayari transcribe (Urdu/Hindi in Bangla + English letters)",
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
  shayari?: ShayariSections;
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

interface GenerateOptions {
  schema?: unknown;
  json?: boolean;
  mediaResolutionLow?: boolean;
  fastThinking?: boolean;
  /** Caps runaway output (a model repeating lines until its limit can take minutes). */
  maxOutputTokens?: number;
}

export class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class UserFacingError extends Error {}
export class TranscriptionQualityError extends UserFacingError {}

// Per-isolate caches. Isolates are short-lived, so these are only a speed-up.
const modelListCache = new Map<string, { at: number; models: string[] }>();
const workingModel = new Map<string, string>();
const badModels = new Map<string, Set<string>>();
const noThinkingModels = new Set<string>();
const keyCooldownUntil = new Map<string, number>();
let keyCursor = 0;

export function apiKeys(): string[] {
  const raw = [env.GEMINI_API_KEYS, env.GEMINI_API_KEY].filter(Boolean).join(",");
  return [...new Set(raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean))];
}

function keyId(key: string): string {
  return key.slice(-8);
}

async function geminiFetch(key: string, path: string, body?: unknown): Promise<any> {
  const base = env.GEMINI_API_BASE || DEFAULT_API; // Overridable for local tests only.
  const response = await fetch(`${base}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
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
    const payload = await geminiFetch(key, "models?pageSize=1000");
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
  return [...new Set(candidates)];
}

function thinkingConfig(model: string): Record<string, unknown> | undefined {
  if (noThinkingModels.has(model)) return undefined;
  if (model.includes("2.5")) return { thinkingBudget: 0 };
  return { thinkingLevel: "MINIMAL" };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      if (options.maxOutputTokens) generationConfig.maxOutputTokens = options.maxOutputTokens;
      try {
        const payload = await geminiFetch(key, `models/${model}:generateContent`, {
          contents: [{ role: "user", parts }],
          generationConfig,
        });
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
        const message = error.message.toLowerCase();
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
  throw new UserFacingError(
    "No Gemini model could handle this request with the configured API key. " +
      "Check that the key is valid and has quota in Google AI Studio, or add a backup key." +
      (failures.length ? ` Tried: ${failures.slice(0, 6).join("; ")}.` : ""),
  );
}

/** Try every configured key, starting from a rotating position to spread load. */
async function generate(
  parts: unknown[],
  options: GenerateOptions = {},
) {
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

/**
 * Shayari parts. The website asks for "pron" (Bangla + English letters) from the audio, then
 * translates that text with shayariMeaning(): writing all three sections in one audio call is
 * about three times slower. "all" is one call (used by live voice).
 */
export const SHAYARI_PARTS = ["all", "pron"] as const;
export type ShayariPart = (typeof SHAYARI_PARTS)[number];

const SHAYARI_FIELDS: Record<ShayariPart, ("bangla" | "english" | "meaning")[]> = {
  all: ["bangla", "english", "meaning"],
  pron: ["bangla", "english"],
};

function shayariSchema(part: ShayariPart) {
  const fields = SHAYARI_FIELDS[part];
  return {
    type: "OBJECT",
    properties: Object.fromEntries(fields.map((f) => [f, { type: "STRING" }])),
    required: fields,
  };
}

const SHAYARI_FIELD_RULES = {
  bangla: `"bangla": the recited Urdu/Hindi words written phonetically in Bengali letters (বাংলা লিপি),
  so a Bangla reader pronounces it exactly like the reciter. This is transliteration, NOT translation:
  keep every Urdu/Hindi word, only change the letters. Example: "দিল-এ-নাদাঁ তুঝে হুয়া ক্যা হ্যায়".
  Show Urdu sounds as closely as Bengali allows (ز/ذ/ظ/ض as জ, ف as ফ, خ as খ, غ as গ, ق as ক, ع silent or as the vowel heard),
  use ঁ for nasal sounds and keep the long vowels that are heard.`,
  english: `"english": the recited words written in simple, common Roman (English) letters, the way
  Urdu poetry is usually written on social media, without diacritic marks. Example: "dil-e-naadaan tujhe hua kya hai".`,
  meaning: `"meaning": a natural Bangla translation of the meaning of what is recited, line by line
  (one Bangla line for each recited line). Example: "হে অবুঝ মন, তোমার কী হয়েছে".`,
};

function buildShayariPrompt(vocabulary: string[], strictRetry: boolean, part: ShayariPart): string {
  const vocab = vocabulary.length
    ? `\nUse these names only when they match the audio: ${vocabulary.slice(0, 100).join(", ")}`
    : "";
  const fields = SHAYARI_FIELDS[part];
  const task = "Listen carefully and write down exactly what is recited, keeping the original Urdu/Hindi words and pronunciation.\nDo NOT write Urdu (Nastaliq) or Devanagari script.";
  const fieldWord = fields.length === 1 ? "one field" : `${fields.length} fields`;
  return `This audio contains Urdu or Hindi poetry (shayari, sher, ghazal, nazm) recited or sung.
${task}
Return JSON with ${fieldWord}:

${fields.map((f) => SHAYARI_FIELD_RULES[f]).join("\n")}

Line rules${fields.length > 1 ? " (all fields must have the same line structure)" : ""}:
- Put each misra (line of poetry) on its own line.
- Leave one empty line between two shers / stanzas.
- If the reciter repeats a line for effect, write it only once, unless the repetition is part of the poem.
- If there is spoken introduction or commentary in Urdu/Hindi, include it the same way as its own lines.
- Skip music, applause and audience reactions such as "wah wah", "kya baat hai", "mukarrar".
The AUDIO is the only source of truth. Never add verses from memory that are not audible, never complete
a famous poem beyond what is recited, and never invent text for silence or music.
If there is no speech, return ${fields.length === 1 ? "the field as an empty string" : "every field as an empty string"}.${strictRetry ? "\nSTRICT SECOND PASS: listen again from the beginning and follow the rules exactly." : ""}${vocab}`;
}

function buildPrompt(mode: Mode, codes: string[], vocabulary: string[], strictRetry = false): string {
  const vocab = vocabulary.length
    ? `\nUse these names only when they match the audio: ${vocabulary.slice(0, 100).join(", ")}`
    : "";
  const lang = languageHint(codes);
  const languageRule = codes.includes("bn-BD")
    ? "This recording is primarily in Bangla (Bangladesh). Write spoken Bangla in বাংলা লিপি (Bengali script). Never translate Bangla into English or render Bengali sounds in Arabic, Urdu or Hindi script. Preserve short English words only when actually spoken in English."
    : "For every utterance, identify the language actually spoken in the AUDIO. Write Bangla speech in Bengali script, English speech in English, and so on. Never translate or romanize Bangla speech.";
  const audioRule = "The AUDIO is the only source of truth. Never continue from imagination, background silence, music, or a previous chunk. Never insert examples, lectures, interviews, conversations or transcript instructions that are not audible. For silence or unintelligible audio, output no invented text.";
  const retryRule = strictRetry
    ? "STRICT SECOND PASS: The earlier recognition was unreliable. Listen to this audio clip independently from the beginning. Do not rely on the previous transcript. Be especially careful to preserve Bengali speech in Bengali script. If no words are clearly audible, return the no-speech response."
    : "";
  if (mode === "detailed") {
    return `Transcribe all audible speech from this audio in its original language(s).
Language guidance: ${lang}.
${languageRule}
${audioRule}
${retryRule}
Return JSON with "transcript" (complete transcription) and "segments"
(array with "start_seconds", "end_seconds", "text", and "speaker").
Times are in seconds from the start of this audio clip.
Use short subtitle segments of at most about 7 seconds. Label speakers as Speaker 1, Speaker 2, etc
only when discernible. Do not translate, summarize, invent or omit speech.
If there is no speech, return an empty transcript and no segments.${vocab}`;
  }
  if (mode === "smart") {
    return `Transcribe the complete audio in its original language(s).
Language guidance: ${lang}.
${languageRule}
${audioRule}
${retryRule}
Preserve facts, names, numbers and meaning.
Remove filler words, stutters and false starts; use clear punctuation and paragraphs.
Do not summarize, translate, invent words or omit complete ideas.
If there is no speech, return exactly: [no speech]
Return only the transcript.${vocab}`;
  }
  return `Transcribe the complete audio VERBATIM in its original language(s).
Language guidance: ${lang}.
${languageRule}
${audioRule}
${retryRule}
Preserve fillers, repetitions, false starts,
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

export async function transcribe(
  input: AudioInput,
  mode: Mode,
  languageCodes: string[],
  vocabulary: string[],
  clipDuration?: number,
  strictRetry = false,
): Promise<TranscribeResult> {
  if (mode === "shayari") return transcribeShayari(input, vocabulary, "all", strictRetry);
  const prompt = buildPrompt(mode, languageCodes, vocabulary, strictRetry);
  const parts = [{ text: prompt }, ...audioParts(input)];
  const mediaResolutionLow = input.kind === "youtube";
  const transcriptionOptions = { mediaResolutionLow, fastThinking: !strictRetry };
  const enforceLanguage = async (transcript: string): Promise<TranscribeResult | null> => {
    const issue = transcriptionQualityIssue(transcript, languageCodes);
    if (!issue) return null;
    if (!strictRetry) {
      // Re-listen to the same AUDIO with a stricter prompt, not to the
      // model-generated words. Never persist the questionable first result.
      return transcribe(input, mode, languageCodes, vocabulary, clipDuration, true);
    }
    throw new TranscriptionQualityError(
      "This audio part produced an unreliable transcript after a second pass (unexpected language or unrelated text). " +
      "It was not added to your transcript. Retry this item; if the speaker actually changed languages, select Auto detect / mixed language.",
    );
  };

  if (mode !== "detailed") {
    const { text, model } = await generate(parts, transcriptionOptions);
    const transcript = /^\[no speech\]$/i.test(text.trim()) ? "" : text.trim();
    const recovered = await enforceLanguage(transcript);
    if (recovered) return recovered;
    return { transcript, segments: [], model };
  }

  const { text, model } = await generate(parts, { ...transcriptionOptions, schema: SEGMENT_SCHEMA });
  let payload: any;
  try {
    payload = JSON.parse(stripFences(text));
  } catch {
    // The model ignored JSON mode; keep the text and estimate timings later.
    const fallbackTranscript = stripFences(text);
    const recovered = await enforceLanguage(fallbackTranscript);
    if (recovered) return recovered;
    return { transcript: fallbackTranscript, segments: [], model };
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
  const recovered = await enforceLanguage(transcript);
  if (recovered) return recovered;
  return { transcript, segments, model };
}

/** Shayari mode ignores the language setting: the audio is Urdu/Hindi poetry by definition. */
export async function transcribeShayari(
  input: AudioInput,
  vocabulary: string[],
  part: ShayariPart = "all",
  strictRetry = false,
): Promise<TranscribeResult> {
  const parts = [{ text: buildShayariPrompt(vocabulary, strictRetry, part) }, ...audioParts(input)];
  const { text, model } = await generate(parts, {
    schema: shayariSchema(part),
    mediaResolutionLow: input.kind === "youtube",
    fastThinking: !strictRetry,
    maxOutputTokens: SHAYARI_MAX_TOKENS,
  });
  let payload: any;
  try {
    payload = JSON.parse(stripFences(text));
  } catch {
    if (!strictRetry) return transcribeShayari(input, vocabulary, part, true);
    throw new UserFacingError("The shayari result could not be read. Please retry this item.");
  }
  const shayari = cleanShayari(payload);
  const transcript = formatShayari(shayari);
  // Only the prompt-echo check applies here: the output is meant to be Bangla/Roman letters for Urdu speech.
  if (transcriptionQualityIssue(transcript, [])) {
    if (!strictRetry) return transcribeShayari(input, vocabulary, part, true);
    throw new TranscriptionQualityError("This audio part produced an unreliable shayari result. Please retry this item.");
  }
  return { transcript, segments: [], model, shayari: isEmptyShayari(shayari) ? undefined : shayari };
}

// A 5 minute piece of poetry needs far less; this only stops runaway repetition.
const SHAYARI_MAX_TOKENS = 8192;

/** Bangla meaning of shayari, translated from its romanized (and Bengali-letter) text. Text only, so it is fast. */
export async function shayariMeaning(english: string, bangla: string): Promise<string> {
  const prompt = `Below is Urdu/Hindi poetry (shayari) written in Roman letters, and the same lines written in Bengali letters.
Translate its MEANING into natural, simple Bangla (বাংলা).
Write exactly one Bangla line for each poetry line, in the same order, and keep the empty lines between shers.
Do not add explanations, headings or extra lines. Return JSON with one field "meaning".

ROMAN LETTERS:
${english}

BENGALI LETTERS:
${bangla}`;
  const { text } = await generate([{ text: prompt }], {
    schema: { type: "OBJECT", properties: { meaning: { type: "STRING" } }, required: ["meaning"] },
    fastThinking: true,
    maxOutputTokens: SHAYARI_MAX_TOKENS,
  });
  try {
    return cleanShayari({ meaning: JSON.parse(stripFences(text)).meaning }).meaning;
  } catch {
    throw new UserFacingError("The Bangla meaning could not be read. Please try again.");
  }
}

export async function aiText(prompt: string): Promise<string> {
  const { text } = await generate([{ text: prompt }], { fastThinking: false });
  return text;
}
