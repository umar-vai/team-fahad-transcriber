/**
 * Real names for transcripts of Google Drive links.
 *
 * Drive links used to be saved with a placeholder title ("google_drive_media", "Linked media"),
 * which made History hard to search. These helpers find the file's real name in Drive and
 * fix the title, both when a transcript is saved and for older rows when History is opened.
 */
import { env } from "cloudflare:workers";
import { googleAccessToken, serviceAccount } from "./google";

/** Titles that are placeholders, not the file's name. */
const PLACEHOLDERS = new Set(["google_drive_media", "linked media", "untitled", "media", "video", "audio", "download", "uc"]);

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  const t = String(title || "").trim().toLowerCase();
  return !t || PLACEHOLDERS.has(t) || /^google_drive_media(_\d+)?$/.test(t);
}

/** The file id of a Google Drive file link, or null when the link is not a Drive file. */
export function driveFileId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!/(^|\.)(drive|docs)\.google\.com$|^drive\.usercontent\.google\.com$/.test(url.hostname)) return null;
  if (/\/folders?\//.test(url.pathname)) return null;
  const inPath = url.pathname.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/);
  if (inPath) return inPath[1];
  const id = url.searchParams.get("id");
  return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{2,5}$/, "").trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

async function nameFromApi(id: string, headers: Record<string, string>, key?: string): Promise<string | null> {
  const params = new URLSearchParams({ fields: "name", supportsAllDrives: "true" });
  if (key) params.set("key", key);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${params}`, { headers });
  if (!response.ok) return null;
  const data: any = await response.json().catch(() => null);
  return typeof data?.name === "string" && data.name.trim() ? data.name.trim() : null;
}

async function nameFromPage(id: string): Promise<string | null> {
  const response = await fetch(`https://drive.google.com/file/d/${encodeURIComponent(id)}/view`, {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.8" },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const og = html.match(/<meta property="og:title" content="([^"]+)"/);
  const title = og?.[1] || html.match(/<title>([^<]+)<\/title>/)?.[1] || "";
  const name = decodeHtml(title).replace(/\s*-\s*Google Drive\s*$/i, "").trim();
  return name && !/^(Google Drive|Sign-in|Sign in)/i.test(name) ? name : null;
}

/** The file's name in Drive without its extension, or null when Drive does not tell us. */
export async function driveFileName(id: string): Promise<string | null> {
  const attempts: (() => Promise<string | null>)[] = [];
  if (serviceAccount()) attempts.push(async () => nameFromApi(id, { authorization: `Bearer ${await googleAccessToken()}` }));
  if (env.GOOGLE_DRIVE_API_KEY) attempts.push(() => nameFromApi(id, {}, env.GOOGLE_DRIVE_API_KEY));
  attempts.push(() => nameFromPage(id));
  for (const attempt of attempts) {
    try {
      const name = await attempt();
      if (name) return stripExtension(name).slice(0, 200) || null;
    } catch (error) {
      console.warn("Drive name lookup failed", error);
    }
  }
  return null;
}

/** A better title for a transcript: the Drive file name when the title is a placeholder and the source is a Drive file. */
export async function betterTitle(title: string, sourceRef: string | null | undefined): Promise<string | null> {
  if (!isPlaceholderTitle(title)) return null;
  const id = driveFileId(sourceRef);
  return id ? driveFileName(id) : null;
}

/**
 * Fixes placeholder titles of Drive transcripts in a list of rows (in place) and saves the new
 * titles. Looks up at most `limit` rows per call so a page load stays fast; the rest are fixed
 * the next time. Rows whose name cannot be found keep their title.
 */
export async function fixDriveTitles<T extends { id: string; title: string; source_ref?: string | null }>(rows: T[], limit = 12): Promise<void> {
  const todo = rows.filter((row) => isPlaceholderTitle(row.title) && driveFileId(row.source_ref)).slice(0, limit);
  if (!todo.length) return;
  const names = await Promise.all(todo.map((row) => driveFileName(driveFileId(row.source_ref)!).catch(() => null)));
  const updates: D1PreparedStatement[] = [];
  todo.forEach((row, i) => {
    const name = names[i];
    if (!name) return;
    row.title = name;
    updates.push(env.DB.prepare("UPDATE transcriptions SET title = ? WHERE id = ?").bind(name, row.id));
  });
  if (updates.length) await env.DB.batch(updates);
}
