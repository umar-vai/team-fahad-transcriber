import type { APIRoute } from "astro";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { mediaFetch, youtubeId, youtubeInfo } from "../../../lib/media";

function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "Please paste a valid link.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http and https links are supported.");
  if (/(^|\.)drive\.google\.com$/.test(url.hostname) && /\/folders?\//.test(url.pathname)) {
    throw new HttpError(400, "This is a Google Drive folder link. Please paste the share link of a single video or audio file.");
  }
  return url.toString();
}

/** Start preparing a link. YouTube goes straight to Gemini; everything else uses the media container. */
export const POST: APIRoute = handler(async (context) => {
  requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  const url = validateUrl(String(body.url || ""));
  const ytId = youtubeId(url);
  if (ytId && !body.forceDownload) {
    const info = await youtubeInfo(ytId);
    return json({ kind: "youtube", url: `https://www.youtube.com/watch?v=${ytId}`, ...info });
  }
  const job = crypto.randomUUID();
  const response = await mediaFetch(job, "/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    const detail: any = await response.json().catch(() => ({}));
    const message = typeof detail?.error === "string" && detail.error.length < 240
      ? detail.error
      : "The media helper could not start. Please try again.";
    throw new HttpError(response.status === 503 ? 503 : 502, message);
  }
  return json({ kind: "job", job });
});
