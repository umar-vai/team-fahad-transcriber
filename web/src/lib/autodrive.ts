/**
 * Nightly automatic transcription of a Google Drive account's "Computers" folders.
 *
 * Every computer (for example one customer care PC) syncs its screen recordings into
 * Drive under Computers. This module:
 *   - finds the computer folders and the new media files inside them,
 *   - queues one job per computer per night (a job becomes one BatchRunner batch),
 *   - keeps at most MAX_CONCURRENT jobs running and retries failed videos,
 *   - never queues the same Drive file twice.
 *
 * Cron (see wrangler.jsonc, times are UTC):
 *   50 17 * * *    23:50 in Bangladesh: look for the day's files and queue the jobs
 *   every 30 minutes: start queued jobs, retry failed videos (cron expression: slash 30 in the minute field)
 *
 * The Drive account signs in once (Connect Drive on the Auto page) and the app keeps
 * an offline refresh token with read-only access.
 */
import { env } from "cloudflare:workers";
import { HttpError } from "./http";
import { isMedia } from "./drive";
import type { BatchConfig, BatchMode } from "../batch/runner";

/** Bangladesh has no daylight saving time: always UTC+6. */
export const DAY_OFFSET_MS = 6 * 3600_000;
export const NIGHTLY_CRON = "50 17 * * *";
const DAY_MS = 86_400_000;
const MAX_CONCURRENT = 3;
const MAX_ATTEMPTS = 3;
const MAX_FILES_PER_COMPUTER = 400;
const MAX_DEPTH = 6;
const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// ---------- Dates ----------

/** The Bangladesh calendar day (YYYY-MM-DD) of a timestamp. */
export function dayOf(ms: number): string {
  return new Date(ms + DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC timestamp of 00:00 Bangladesh time on that day. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - DAY_OFFSET_MS;
}

// ---------- Connection and tokens ----------

export interface DriveConnection {
  user_id: string;
  google_email: string;
  refresh_token: string;
  app_url: string;
  mode: BatchMode;
  language: string;
  enabled: number;
  /** 1 = also write to Notion (off by default; Sheets is always used). */
  notion_enabled: number;
  connected_at: number;
}

export async function getConnection(): Promise<DriveConnection | null> {
  return env.DB.prepare("SELECT * FROM drive_connection WHERE id = 1").first<DriveConnection>();
}

export async function saveConnection(info: { userId: string; email: string; refreshToken: string; appUrl: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO drive_connection (id, user_id, google_email, refresh_token, app_url, connected_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, google_email = excluded.google_email,
       refresh_token = excluded.refresh_token, app_url = excluded.app_url, enabled = 1, connected_at = excluded.connected_at`,
  )
    .bind(info.userId, info.email, info.refreshToken, info.appUrl, Date.now())
    .run();
}

let cachedToken: { token: string; until: number; refresh: string } | null = null;

/** Short-lived Drive access token from the stored refresh token. */
export async function driveAccessToken(connection?: DriveConnection | null): Promise<string> {
  const conn = connection ?? (await getConnection());
  if (!conn) throw new Error("Google Drive is not connected yet. Open the Auto page and press Connect Drive.");
  if (cachedToken && cachedToken.refresh === conn.refresh_token && cachedToken.until > Date.now()) return cachedToken.token;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: String(env.GOOGLE_CLIENT_ID),
      client_secret: String(env.GOOGLE_CLIENT_SECRET),
      refresh_token: conn.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const reason = payload.error_description || payload.error || response.status;
    throw new Error(`Google Drive access was refused (${reason}). Press Connect Drive on the Auto page again.`);
  }
  cachedToken = { token: payload.access_token, refresh: conn.refresh_token, until: Date.now() + (Number(payload.expires_in) || 3600) * 1000 - 120_000 };
  return cachedToken.token;
}

// ---------- Drive listing ----------

async function driveGet(token: string, path: string, params: Record<string, string>): Promise<any> {
  const base = env.DRIVE_API_BASE || "https://www.googleapis.com/drive/v3";
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${base}/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
    const payload: any = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
      continue;
    }
    throw new Error(String(payload?.error?.message || `Drive API error ${response.status}`));
  }
}

export interface ComputerFolder {
  id: string;
  name: string;
}

/**
 * The folders under Drive's "Computers" section. Drive's API has no "Computers" listing, so these are
 * the folders owned by the account that have no parent. DRIVE_COMPUTER_FOLDER_IDS (comma separated
 * ids) can be set as a fallback or to add folders by hand.
 */
export async function discoverComputers(token: string): Promise<ComputerFolder[]> {
  const found = new Map<string, ComputerFolder>();
  let pageToken = "";
  for (let page = 0; page < 30; page++) {
    const result = await driveGet(token, "files", {
      q: `mimeType = '${FOLDER_MIME}' and 'me' in owners and trashed = false`,
      fields: "nextPageToken,files(id,name,parents)",
      pageSize: "1000",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const file of result.files || []) {
      if (!file.parents?.length) found.set(String(file.id), { id: String(file.id), name: String(file.name || "Computer") });
    }
    pageToken = result.nextPageToken || "";
    if (!pageToken) break;
  }
  for (const id of String(env.DRIVE_COMPUTER_FOLDER_IDS || "").split(/[\s,]+/).filter(Boolean)) {
    if (found.has(id)) continue;
    const meta = await driveGet(token, `files/${id}`, { fields: "id,name,mimeType" }).catch(() => null);
    if (meta?.mimeType === FOLDER_MIME) found.set(id, { id, name: String(meta.name || "Computer") });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface FoundFile {
  id: string;
  name: string;
  /** Name with its subfolders, e.g. "2026-11-17 / call 3.mp4". */
  path: string;
  /** Bangladesh day the file was last modified. */
  day: string;
}

/** Media files in a computer folder (and its subfolders) modified since the given time. */
export async function listNewFiles(token: string, folderId: string, sinceMs: number): Promise<FoundFile[]> {
  const files: FoundFile[] = [];
  const since = new Date(sinceMs).toISOString();
  const walk = async (id: string, prefix: string, depth: number) => {
    let pageToken = "";
    do {
      const page = await driveGet(token, "files", {
        q: `'${id}' in parents and trashed = false and (mimeType = '${FOLDER_MIME}' or modifiedTime > '${since}')`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime)",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of page.files || []) {
        const name = String(item.name || "");
        if (item.mimeType === FOLDER_MIME) {
          if (depth < MAX_DEPTH) await walk(String(item.id), `${prefix}${name} / `, depth + 1);
        } else if (isMedia(name, item.mimeType) && files.length < MAX_FILES_PER_COMPUTER) {
          const modified = Date.parse(item.modifiedTime) || Date.now();
          files.push({ id: String(item.id), name, path: prefix + name, day: dayOf(modified) });
        }
      }
      pageToken = page.nextPageToken || "";
    } while (pageToken && files.length < MAX_FILES_PER_COMPUTER);
  };
  await walk(folderId, "", 0);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return files.sort((a, b) => a.day.localeCompare(b.day) || collator.compare(a.path, b.path));
}

// ---------- Queueing the nightly jobs ----------

export interface QueueResult {
  day: string;
  computers: { name: string; newFiles: number }[];
}

async function filterUnseen(files: FoundFile[]): Promise<FoundFile[]> {
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i += 80) {
    const chunk = files.slice(i, i + 80);
    const rows = await env.DB.prepare(`SELECT file_id FROM drive_files WHERE file_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk.map((f) => f.id))
      .all<{ file_id: string }>();
    for (const row of rows.results) seen.add(row.file_id);
  }
  return files.filter((f) => !seen.has(f.id));
}

/**
 * Find the new files of every computer and queue one job each. Looks back to the start of yesterday, so
 * a file that finished syncing after 23:50 is picked up the next night. Safe to run more than once.
 */
export async function queueNight(now = Date.now()): Promise<QueueResult> {
  const connection = await getConnection();
  if (!connection) throw new HttpError(400, "Google Drive is not connected yet.");
  if (!connection.enabled) return { day: dayOf(now), computers: [] };
  const token = await driveAccessToken(connection);
  const today = dayOf(now);
  const since = dayStart(today) - DAY_MS;
  const result: QueueResult = { day: today, computers: [] };

  for (const computer of await discoverComputers(token)) {
    await env.DB.prepare(
      `INSERT INTO drive_computers (folder_id, name, created_at) VALUES (?, ?, ?)
       ON CONFLICT(folder_id) DO UPDATE SET name = excluded.name`,
    )
      .bind(computer.id, computer.name, now)
      .run();
    let fresh: FoundFile[];
    try {
      fresh = await filterUnseen(await listNewFiles(token, computer.id, since));
    } catch (error) {
      // One unreadable computer must not stop the others.
      console.error(`Listing ${computer.name} failed:`, error);
      result.computers.push({ name: computer.name, newFiles: -1 });
      continue;
    }
    result.computers.push({ name: computer.name, newFiles: fresh.length });
    if (!fresh.length) continue;
    const jobId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO drive_jobs (id, computer_id, computer_name, day, status, files_json, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      ).bind(jobId, computer.id, computer.name.slice(0, 200), today, JSON.stringify(fresh), now),
      ...fresh.map((f) =>
        env.DB.prepare(`INSERT OR IGNORE INTO drive_files (file_id, computer_id, name, file_day, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(f.id, computer.id, f.path.slice(0, 300), f.day, jobId, now),
      ),
    ]);
  }
  return result;
}

// ---------- Running the queue ----------

export interface JobRow {
  id: string;
  computer_id: string;
  computer_name: string;
  day: string;
  status: "queued" | "running" | "done";
  files_json: string;
  attempts: number;
  batch_id: string | null;
  created_at: number;
}

async function startJob(connection: DriveConnection, job: JobRow): Promise<void> {
  const files: FoundFile[] = JSON.parse(job.files_json);
  const batchId = crypto.randomUUID();
  const config: BatchConfig = {
    id: batchId,
    userId: connection.user_id,
    folderId: job.computer_id,
    folderName: job.computer_name,
    folderUrl: `https://drive.google.com/drive/folders/${job.computer_id}`,
    mode: connection.mode,
    language: connection.language,
    vocab: [],
    appUrl: connection.app_url,
    createdAt: Date.now(),
    total: files.length,
    computerId: job.computer_id,
    authDrive: true,
    notion: Boolean(connection.notion_enabled),
  };
  await env.DB.prepare(
    `INSERT INTO batches (id, user_id, folder_id, folder_name, folder_url, mode, language, total, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  )
    .bind(batchId, config.userId, config.folderId, `${job.computer_name} · ${job.day}`.slice(0, 300), config.folderUrl, config.mode, config.language, config.total, config.createdAt)
    .run();
  await env.BATCH_RUNNER.getByName(batchId).start(config, files.map((f) => ({ id: f.id, path: f.path, name: f.name, date: f.day })));
  await env.DB.prepare("UPDATE drive_jobs SET status = 'running', batch_id = ? WHERE id = ?").bind(batchId, job.id).run();
}

/** Start queued jobs while a slot is free, and retry the failed videos of finished jobs. */
export async function pumpJobs(): Promise<{ started: number; retried: number; finished: number }> {
  const summary = { started: 0, retried: 0, finished: 0 };
  const connection = await getConnection();
  if (!connection?.enabled) return summary;

  const running = await env.DB.prepare(
    `SELECT j.*, b.status AS batch_status, b.failed_count AS failed_count
       FROM drive_jobs j LEFT JOIN batches b ON b.id = j.batch_id WHERE j.status = 'running'`,
  ).all<JobRow & { batch_status: string | null; failed_count: number | null }>();
  let active = 0;
  for (const job of running.results) {
    if (job.batch_status === "running") {
      active++;
      continue;
    }
    const failed = Number(job.failed_count || 0);
    if (job.batch_id && failed > 0 && job.attempts < MAX_ATTEMPTS) {
      const ok = await env.BATCH_RUNNER.getByName(job.batch_id).resume(connection.user_id).catch(() => false);
      if (ok) {
        await env.DB.prepare("UPDATE drive_jobs SET attempts = attempts + 1 WHERE id = ?").bind(job.id).run();
        summary.retried++;
        active++;
        continue;
      }
    }
    await env.DB.prepare("UPDATE drive_jobs SET status = 'done' WHERE id = ?").bind(job.id).run();
    summary.finished++;
  }

  if (active < MAX_CONCURRENT) {
    const queued = await env.DB.prepare("SELECT * FROM drive_jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?")
      .bind(MAX_CONCURRENT - active)
      .all<JobRow>();
    for (const job of queued.results) {
      try {
        await startJob(connection, job);
        summary.started++;
      } catch (error) {
        console.error(`Could not start the job for ${job.computer_name}:`, error);
      }
    }
  }
  return summary;
}

/** What the cron does at 23:50, and what the "Run now" button does. */
export async function nightlyRun(now = Date.now()): Promise<QueueResult & { pump: Awaited<ReturnType<typeof pumpJobs>> }> {
  const queued = await queueNight(now);
  return { ...queued, pump: await pumpJobs() };
}
