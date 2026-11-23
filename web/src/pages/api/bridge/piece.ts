import type { APIRoute } from "astro";
import { LANGUAGES, transcribe, type Mode } from "../../../lib/gemini";
import { handler, HttpError, json } from "../../../lib/http";
import { authDevice, bridgeSettings } from "../../../lib/bridge";
import { inferBanglaLanguage } from "../../../lib/transcription-quality";

const MAX_BYTES = 14 * 1024 * 1024; // Base64 must stay under Gemini's 20 MB request limit.

/**
 * One piece of audio (about 5 minutes) from a PC. The audio is sent straight to Gemini and never stored.
 * Query: duration (seconds), language (optional: the language the first piece decided, for Auto detect).
 */
export const POST: APIRoute = handler(async (context) => {
  const device = await authDevice(context.request);
  const { request, url } = context;
  const mimeType = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^audio\/[\w.+-]+$/.test(mimeType)) throw new HttpError(415, "Send audio data.");
  const data = await request.arrayBuffer();
  if (!data.byteLength) throw new HttpError(400, "Empty audio.");
  if (data.byteLength > MAX_BYTES) throw new HttpError(413, "This audio piece is too large. Use pieces of 5 minutes or less.");

  const settings = await bridgeSettings();
  const asked = url.searchParams.get("language") || "";
  const language = LANGUAGES[asked] ? asked : settings.language;
  const duration = Number(url.searchParams.get("duration")) || undefined;
  const result = await transcribe({ kind: "inline", mimeType, data }, settings.mode as Mode, LANGUAGES[language] || [], [], duration);
  return json({
    transcript: result.transcript,
    segments: result.segments,
    // Auto detect: the PC passes this back with the next pieces, as the website does.
    detectedLanguage: inferBanglaLanguage(result.transcript),
    device: device.name,
  });
});
