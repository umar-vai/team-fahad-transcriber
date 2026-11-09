/** Talks to the media container Worker through the service binding. */
import { env } from "cloudflare:workers";
import { HttpError } from "./http";

const JOB_ID = /^[A-Za-z0-9-]{16,64}$/;

export function checkJobId(job: string | null): string {
  if (!job || !JOB_ID.test(job)) throw new HttpError(400, "Invalid job id.");
  return job;
}

export function mediaFetch(job: string, path: string, init?: RequestInit): Promise<Response> {
  if (!env.MEDIA) throw new HttpError(503, "The media helper is not configured.");
  return env.MEDIA.fetch(`https://media/job/${job}${path}`, init);
}

export function youtubeId(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
    if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
      return match ? match[1] : null;
    }
  } catch {}
  return null;
}

/** Best-effort title and length of a public YouTube video. */
export async function youtubeInfo(id: string): Promise<{ title: string; duration: number | null }> {
  let title = "YouTube video";
  let duration: number | null = null;
  try {
    const page = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      headers: { "accept-language": "en-US,en;q=0.8", "user-agent": "Mozilla/5.0" },
    });
    const html = await page.text();
    const seconds = html.match(/"lengthSeconds":"(\d+)"/);
    if (seconds) duration = Number(seconds[1]);
    const name = html.match(/<meta name="title" content="([^"]*)"/) || html.match(/<title>([^<]*)<\/title>/);
    if (name) title = name[1].replace(/ - YouTube$/, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  } catch {}
  return { title, duration };
}
