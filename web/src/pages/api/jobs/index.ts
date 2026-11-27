import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { LANGUAGES, MODES, type Mode } from "../../../lib/gemini";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { youtubeId, youtubeInfo } from "../../../lib/media";

/** Clip length for YouTube links, same as the browser's audio pieces. */
const CLIP_SECONDS = 300;

/**
 * Start transcribing a link on the server (LinkJob Durable Object).
 * The browser only polls /api/jobs/:id, so leaving the page does not stop the job;
 * the finished transcript is saved to History.
 */
export const POST: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  let url: URL;
  try {
    url = new URL(String(body.url || "").trim());
  } catch {
    throw new HttpError(400, "Please paste a valid link.");
  }
  if (/(^|\.)drive\.google\.com$/.test(url.hostname) && /\/folders?\//.test(url.pathname)) {
    throw new HttpError(400, "This is a Google Drive folder link. Use the Drive folder tab to transcribe every file in it.");
  }
  const ytId = youtubeId(url.toString());
  if (!ytId) {
    throw new HttpError(
      400,
      "Only YouTube links can be transcribed from a link right now. For Facebook or other sites, download the video and upload the file instead.",
    );
  }
  const mode = String(body.mode || "smart") as Mode;
  if (!(mode in MODES)) throw new HttpError(400, "Unknown transcription mode.");
  const language = String(body.language || "Auto detect / mixed language");
  if (!LANGUAGES[language]) throw new HttpError(400, "Unknown language.");
  const vocab = String(body.vocab || "")
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 100);

  const info = await youtubeInfo(ytId);
  const ranges: { start?: number; end?: number }[] = [];
  if (info.duration && info.duration > CLIP_SECONDS * 1.5) {
    for (let start = 0; start < info.duration; start += CLIP_SECONDS) ranges.push({ start, end: Math.min(info.duration, start + CLIP_SECONDS) });
  } else ranges.push({});

  const id = crypto.randomUUID();
  await env.LINK_JOB.getByName(id).start({
    id,
    userId: user.id,
    url: `https://www.youtube.com/watch?v=${ytId}`,
    title: info.title,
    duration: info.duration,
    mode,
    language,
    vocab,
    ranges,
    createdAt: Date.now(),
  });
  return json({ id, title: info.title, total: ranges.length });
});
