import type { APIRoute } from "astro";
import { LANGUAGES, MODES, SHAYARI_PARTS, transcribe, transcribeShayari, type AudioInput, type Mode, type ShayariPart } from "../../lib/gemini";
import { handler, HttpError, json, requireUser } from "../../lib/http";
import { checkJobId, mediaFetch, youtubeId } from "../../lib/media";

const MAX_INLINE_BYTES = 14 * 1024 * 1024; // Base64 must stay under Gemini's 20 MB request limit.

function readOptions(source: { get(name: string): string | null }) {
  const mode = (source.get("mode") || "smart") as Mode;
  if (!(mode in MODES)) throw new HttpError(400, "Unknown transcription mode.");
  const language = source.get("language") || "Auto detect / mixed language";
  const codes = LANGUAGES[language];
  if (!codes) throw new HttpError(400, "Unknown language.");
  const vocabulary = (source.get("vocab") || "")
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 100);
  const shayariPart = (source.get("shayariPart") || "all") as ShayariPart;
  if (!SHAYARI_PARTS.includes(shayariPart)) throw new HttpError(400, "Unknown shayari part.");
  return { mode, codes, vocabulary, shayariPart };
}

/** Shayari parts go to their own call; every other mode uses the normal transcription. */
function run(input: AudioInput, options: ReturnType<typeof readOptions>, clipDuration?: number) {
  if (options.mode === "shayari") return transcribeShayari(input, options.vocabulary, options.shayariPart);
  return transcribe(input, options.mode, options.codes, options.vocabulary, clipDuration);
}

/**
 * Transcribe one short piece of audio (about 5 minutes or less).
 * The browser splits long media and calls this for every piece in parallel.
 *
 * Body options:
 *  - raw audio bytes (Content-Type audio/*), settings in the query string
 *  - JSON {source:"job", job, part, duration} to read a part prepared by the media container
 *  - JSON {source:"youtube", url, start, end} for a public YouTube video clip
 */
export const POST: APIRoute = handler(async (context) => {
  requireUser(context);
  const { request, url } = context;
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body: any = await request.json().catch(() => ({}));
    const options = readOptions({ get: (name) => (body[name] == null ? null : String(body[name])) });
    if (body.source === "youtube") {
      if (!youtubeId(String(body.url || ""))) throw new HttpError(400, "Not a YouTube link.");
      const start = body.start == null ? undefined : Number(body.start);
      const end = body.end == null ? undefined : Number(body.end);
      const result = await run(
        { kind: "youtube", url: String(body.url), startSeconds: start, endSeconds: end },
        options,
        start !== undefined && end !== undefined ? end - start : undefined,
      );
      return json(result);
    }
    if (body.source === "job") {
      const job = checkJobId(String(body.job || ""));
      const part = Number(body.part);
      if (!Number.isInteger(part) || part < 0) throw new HttpError(400, "Invalid part.");
      const audio = await mediaFetch(job, `/part/${part}`);
      if (!audio.ok) throw new HttpError(404, "This audio part is no longer available. Please start again.");
      const data = await audio.arrayBuffer();
      const result = await run({ kind: "inline", mimeType: "audio/mpeg", data }, options, Number(body.duration) || undefined);
      return json(result);
    }
    throw new HttpError(400, "Unknown audio source.");
  }

  const options = readOptions(url.searchParams);
  const mimeType = contentType.split(";")[0].trim() || "audio/wav";
  if (!/^audio\/[\w.+-]+$/.test(mimeType)) throw new HttpError(415, "Send audio data.");
  const data = await request.arrayBuffer();
  if (!data.byteLength) throw new HttpError(400, "Empty audio.");
  if (data.byteLength > MAX_INLINE_BYTES) throw new HttpError(413, "This audio piece is too large. Use pieces of 5 minutes or less.");
  const result = await run({ kind: "inline", mimeType, data }, options, Number(url.searchParams.get("duration")) || undefined);
  return json(result);
});
