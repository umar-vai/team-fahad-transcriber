/**
 * Lists the video and audio files inside a public Google Drive folder (and its subfolders).
 *
 * Order of methods:
 *  1. Drive API with the team service account (GOOGLE_SERVICE_ACCOUNT_JSON), no file limit
 *  2. Drive API with an API key (GOOGLE_DRIVE_API_KEY), no file limit
 *  3. Drive's public "embedded folder view" page, which needs no key
 */
import { env } from "cloudflare:workers";
import { googleApi, serviceAccount } from "./google";
import { HttpError } from "./http";

export interface DriveFile {
  id: string;
  name: string;
  /** Name with its subfolder, e.g. "Week 2 / Class 5.mp4". */
  path: string;
  mimeType?: string;
  size?: number;
}

export interface DriveFolder {
  id: string;
  name: string;
  files: DriveFile[];
  method: "service-account" | "api-key" | "public-page";
}

const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|3gp|mpg|mpeg|ts|mts|m2ts|mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|amr)$/i;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_FILES = 300;
const MAX_DEPTH = 4;

export function driveFolderId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)drive\.google\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/folders\/([\w-]{10,})/);
  if (match) return match[1];
  if (/\/(open|embeddedfolderview|folderview)$/.test(url.pathname)) return url.searchParams.get("id");
  return null;
}

export function driveFileUrl(id: string): string {
  return `https://drive.google.com/file/d/${id}/view`;
}

export function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

export function isMedia(name: string, mimeType?: string): boolean {
  if (mimeType && /^(video|audio)\//.test(mimeType)) return true;
  return MEDIA_EXT.test(name);
}

function naturalSort(files: DriveFile[]): DriveFile[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return files.sort((a, b) => collator.compare(a.path, b.path));
}

// ---------- Drive API ----------

/** Overridable for local tests only. */
function driveBase(): string {
  return env.DRIVE_API_BASE || "https://www.googleapis.com/drive/v3";
}

type ApiGet = (path: string, params: Record<string, string>) => Promise<any>;

function apiWithServiceAccount(): ApiGet {
  return (path, params) => googleApi(`${driveBase()}/${path}?${new URLSearchParams(params)}`);
}

function apiWithKey(key: string): ApiGet {
  return async (path, params) => {
    const response = await fetch(`${driveBase()}/${path}?${new URLSearchParams({ ...params, key })}`);
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(payload?.error?.message || `Drive API error ${response.status}`));
      (error as any).status = response.status;
      throw error;
    }
    return payload;
  };
}

async function listWithApi(folderId: string, get: ApiGet): Promise<{ name: string; files: DriveFile[] }> {
  const shared = { supportsAllDrives: "true" };
  const root = await get(`files/${folderId}`, { ...shared, fields: "id,name,mimeType" });
  if (root.mimeType !== FOLDER_MIME) throw new HttpError(400, "This Drive link is a file, not a folder. Paste the folder link.");
  const files: DriveFile[] = [];
  const walk = async (id: string, prefix: string, depth: number) => {
    let pageToken = "";
    do {
      const page = await get("files", {
        ...shared,
        includeItemsFromAllDrives: "true",
        q: `'${id}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,size,shortcutDetails)",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of page.files || []) {
        const name = String(item.name || "");
        let fileId = String(item.id);
        let mimeType = String(item.mimeType || "");
        if (mimeType === "application/vnd.google-apps.shortcut" && item.shortcutDetails) {
          fileId = String(item.shortcutDetails.targetId);
          mimeType = String(item.shortcutDetails.targetMimeType || "");
        }
        if (mimeType === FOLDER_MIME) {
          if (depth < MAX_DEPTH) await walk(fileId, `${prefix}${name} / `, depth + 1);
        } else if (isMedia(name, mimeType) && files.length < MAX_FILES) {
          files.push({ id: fileId, name, path: prefix + name, mimeType, size: item.size ? Number(item.size) : undefined });
        }
      }
      pageToken = page.nextPageToken || "";
    } while (pageToken && files.length < MAX_FILES);
  };
  await walk(folderId, "", 0);
  return { name: String(root.name || "Drive folder"), files };
}

// ---------- Public page (no key) ----------

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
}

/** Parse Drive's embedded folder view page into folders and files. */
export function parseEmbeddedFolderView(html: string): { name: string; entries: { id: string; name: string; folder: boolean }[] } {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const name = decodeHtml(titleMatch ? titleMatch[1] : "").replace(/\s+-\s+Google Drive$/i, "") || "Drive folder";
  const entries: { id: string; name: string; folder: boolean }[] = [];
  const blocks = html.split(/<div class="flip-entry"/).slice(1);
  for (const block of blocks) {
    const id = block.match(/id="entry-([\w-]+)"/)?.[1];
    const title = block.match(/<div class="flip-entry-title">([^<]*)<\/div>/)?.[1];
    const href = block.match(/<a href="([^"]+)"/)?.[1] || "";
    if (!id || title === undefined) continue;
    entries.push({ id, name: decodeHtml(title), folder: /\/folders\//.test(href) });
  }
  return { name, entries };
}

async function listWithPublicPage(folderId: string): Promise<{ name: string; files: DriveFile[] }> {
  const files: DriveFile[] = [];
  let rootName = "Drive folder";
  const walk = async (id: string, prefix: string, depth: number) => {
    const response = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, {
      headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.8" },
    });
    if (!response.ok) {
      if (depth === 0) {
        throw new HttpError(400, "Could not open this Drive folder. Make sure it is shared as \"Anyone with the link\".");
      }
      return;
    }
    const page = parseEmbeddedFolderView(await response.text());
    if (depth === 0) rootName = page.name;
    for (const entry of page.entries) {
      if (entry.folder) {
        if (depth < MAX_DEPTH) await walk(entry.id, `${prefix}${entry.name} / `, depth + 1);
      } else if (isMedia(entry.name) && files.length < MAX_FILES) {
        files.push({ id: entry.id, name: entry.name, path: prefix + entry.name });
      }
    }
  };
  await walk(folderId, "", 0);
  return { name: rootName, files };
}

export async function listDriveFolder(folderId: string): Promise<DriveFolder> {
  const attempts: { method: DriveFolder["method"]; run: () => Promise<{ name: string; files: DriveFile[] }> }[] = [];
  if (serviceAccount()) attempts.push({ method: "service-account", run: () => listWithApi(folderId, apiWithServiceAccount()) });
  if (env.GOOGLE_DRIVE_API_KEY) attempts.push({ method: "api-key", run: () => listWithApi(folderId, apiWithKey(env.GOOGLE_DRIVE_API_KEY!)) });
  attempts.push({ method: "public-page", run: () => listWithPublicPage(folderId) });

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      return { id: folderId, name: result.name, files: naturalSort(result.files), method: attempt.method };
    } catch (error) {
      if (error instanceof HttpError && error.message.includes("not a folder")) throw error;
      console.warn(`Drive listing with ${attempt.method} failed:`, error);
      lastError = error;
    }
  }
  if (lastError instanceof HttpError) throw lastError;
  throw new HttpError(400, "Could not read this Drive folder. Make sure it is shared as \"Anyone with the link\".");
}
