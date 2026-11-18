/**
 * Reads a byte range of a Google Drive file. Used to cut MP3 and WAV files into pieces
 * without downloading the whole file at once and without any container.
 *
 * Ways to reach the file, in order:
 *  1. the connected Drive account's token (private files of the Auto page)
 *  2. the team service account
 *  3. a Drive API key (file shared as "Anyone with the link")
 *  4. Drive's public download address
 */
import { env } from "cloudflare:workers";
import { googleAccessToken, serviceAccount } from "./google";

export interface DriveBytes {
  bytes: Uint8Array;
  /** Whole file size when the server told us. */
  total: number | null;
}

interface Source {
  label: string;
  url: string;
  headers: Record<string, string>;
}

async function sources(fileId: string, token?: string): Promise<Source[]> {
  const id = encodeURIComponent(fileId);
  const api = `https://www.googleapis.com/drive/v3/files/${id}`;
  const params = { alt: "media", supportsAllDrives: "true", acknowledgeAbuse: "true" };
  const list: Source[] = [];
  if (token) list.push({ label: "Drive account", url: `${api}?${new URLSearchParams(params)}`, headers: { authorization: `Bearer ${token}` } });
  else if (serviceAccount()) {
    try {
      list.push({ label: "service account", url: `${api}?${new URLSearchParams(params)}`, headers: { authorization: `Bearer ${await googleAccessToken()}` } });
    } catch (error) {
      console.warn("Service account token failed:", error);
    }
  }
  if (env.GOOGLE_DRIVE_API_KEY) {
    list.push({ label: "API key", url: `${api}?${new URLSearchParams({ ...params, key: env.GOOGLE_DRIVE_API_KEY })}`, headers: {} });
  }
  list.push({ label: "public link", url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, headers: {} });
  return list;
}

async function readUpTo(response: Response, skip: number, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  const reader = response.body!.getReader();
  let seen = 0;
  let filled = 0;
  while (filled < length) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    if (seen < skip) {
      const drop = Math.min(skip - seen, chunk.length);
      seen += drop;
      chunk = chunk.subarray(drop);
    }
    const take = Math.min(chunk.length, length - filled);
    out.set(chunk.subarray(0, take), filled);
    filled += take;
    seen += take;
  }
  await reader.cancel().catch(() => undefined);
  return out.subarray(0, filled);
}

/** Bytes [start, end) of a Drive file. Throws an Error with a plain message on failure. */
export async function driveRange(fileId: string, start: number, end: number, token?: string): Promise<DriveBytes> {
  const problems: string[] = [];
  for (const source of await sources(fileId, token)) {
    try {
      const response = await fetch(source.url, { headers: { ...source.headers, range: `bytes=${start}-${end - 1}` } });
      if (response.status === 416) return { bytes: new Uint8Array(0), total: null };
      if (!response.ok) {
        problems.push(`${source.label}: HTTP ${response.status}`);
        continue;
      }
      if ((response.headers.get("content-type") || "").includes("text/html")) {
        problems.push(`${source.label}: Drive sent a web page instead of the file`);
        continue;
      }
      const range = response.headers.get("content-range")?.match(/\/(\d+)$/);
      if (response.status === 206) {
        return { bytes: new Uint8Array(await response.arrayBuffer()), total: range ? Number(range[1]) : null };
      }
      // The server ignored Range and sends the whole file: read only what is needed, then stop.
      const length = Number(response.headers.get("content-length")) || null;
      return { bytes: await readUpTo(response, start, end - start), total: length };
    } catch (error) {
      problems.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `Could not read this file from Google Drive. Check that it is shared with the app or as "Anyone with the link". (${problems.join("; ").slice(0, 300)})`,
  );
}
