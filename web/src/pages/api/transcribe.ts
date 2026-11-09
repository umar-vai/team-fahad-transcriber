import type { APIRoute } from "astro";
import { LANGUAGES, MODES, transcribe, type Mode } from "../../lib/gemini";
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
  return { mode, codes, vocabulary };
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
      const result = await transcribe(
        { kind: "youtube", url: String(body.url), startSeconds: start, endSeconds: end },
        options.mode, options.codes, options.vocabulary,
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
      const result = await transcribe(
        { kind: "inline", mimeType: "audio/mpeg", data },
        options.mode, options.codes, options.vocabulary, Number(body.duration) || undefined,
      );
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
  const result = await transcribe(
    { kind: "inline", mimeType, data },
    options.mode, options.codes, options.vocabulary, Number(url.searchParams.get("duration")) || undefined,
  );
  return json(result);
});
