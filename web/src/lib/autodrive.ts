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
 *   every 5 minutes: start queued jobs when a slot is free, retry failed videos (slash 5 in the minute field)
 *
 * The Drive account signs in once (Connect Drive on the Auto page) and the app keeps
 * an offline refresh token with read-only access.
 */
import { env } from "cloudflare:workers";
import { HttpError } from "./http";
import { isMedia } from "./drive";
import { refreshSheetDashboardSafe } from "./sheetdash";
import type { BatchConfig, BatchMode } from "../batch/runner";

/** Bangladesh has no daylight saving time: always UTC+6. */
export const DAY_OFFSET_MS = 6 * 3600_000;
export const NIGHTLY_CRON = "50 17 * * *";
const MAX_CONCURRENT = 3;
/** Automatic retry rounds per job (about 5 minutes apart at first, then up to 30 minutes). Press "Retry all failed" for more. */
const MAX_ATTEMPTS = 30;
const RETRY_COOLDOWN_MS = 5 * 60_000;
/** Every media file of a computer is listed (already handled ones are skipped by id), so this is only a safety net. */
const MAX_FILES_PER_COMPUTER = 5000;
/** A job becomes one batch; big backlogs are split so each batch stays small. */
const MAX_FILES_PER_JOB = 60;
const MAX_DEPTH = 10;
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

/** The recording date in a file name such as "2026-11-17 14-56-03.mp4", if it has one. */
export function dayFromName(name: string): string | null {
  const match = name.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : day;
}

/**
 * Every media file in a computer folder and its subfolders.
 *
 * There is deliberately no "modified since" filter: Drive for desktop keeps the file's original time on
 * this computer as its modified time, so a recording uploaded today can look weeks old and a time filter
 * would hide it. Files that were already handled are skipped later by their id.
 */
export async function listNewFiles(token: string, folderId: string): Promise<FoundFile[]> {
  const files: FoundFile[] = [];
  const seenFolders = new Set<string>();
  const walk = async (id: string, prefix: string, depth: number) => {
    if (seenFolders.has(id)) return;
    seenFolders.add(id);
    let pageToken = "";
    do {
      const page = await driveGet(token, "files", {
        q: `'${id}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,shortcutDetails)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of page.files || []) {
        const name = String(item.name || "");
        let fileId = String(item.id);
        let mimeType = String(item.mimeType || "");
        if (mimeType === "application/vnd.google-apps.shortcut" && item.shortcutDetails?.targetId) {
          fileId = String(item.shortcutDetails.targetId);
          mimeType = String(item.shortcutDetails.targetMimeType || "");
        }
        if (mimeType === FOLDER_MIME) {
          if (depth < MAX_DEPTH) await walk(fileId, `${prefix}${name} / `, depth + 1);
        } else if (isMedia(name, mimeType) && files.length < MAX_FILES_PER_COMPUTER) {
          const modified = Date.parse(item.modifiedTime) || Date.parse(item.createdTime) || Date.now();
          files.push({ id: fileId, name, path: prefix + name, day: dayFromName(name) || dayOf(modified) });
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
  computers: { name: string; newFiles: number; totalFiles: number; error?: string }[];
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

/** List a computer's files, trying again if Drive hiccups, so one bad moment does not hide a whole computer. */
async function listWithRetry(token: string, folderId: string): Promise<FoundFile[]> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await listNewFiles(token, folderId);
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw last;
}

/**
 * Find the new files of every computer and queue jobs for them (at most MAX_FILES_PER_JOB files each).
 * Every file Drive holds is considered and the ones already handled are skipped, so nothing is missed
 * and nothing is done twice. Safe to run more than once.
 */
export async function queueNight(now = Date.now()): Promise<QueueResult> {
  const connection = await getConnection();
  if (!connection) throw new HttpError(400, "Google Drive is not connected yet.");
  if (!connection.enabled) return { day: dayOf(now), computers: [] };
  const token = await driveAccessToken(connection);
  const today = dayOf(now);
  const result: QueueResult = { day: today, computers: [] };

  for (const computer of await discoverComputers(token)) {
    await env.DB.prepare(
      `INSERT INTO drive_computers (folder_id, name, created_at) VALUES (?, ?, ?)
       ON CONFLICT(folder_id) DO UPDATE SET name = excluded.name`,
    )
      .bind(computer.id, computer.name, now)
      .run();
    let all: FoundFile[];
    let fresh: FoundFile[];
    try {
      all = await listWithRetry(token, computer.id);
      fresh = await filterUnseen(all);
    } catch (error) {
      // One unreadable computer must not stop the others.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Listing ${computer.name} failed:`, error);
      await env.DB.prepare("UPDATE drive_computers SET last_scan_at = ?, scan_error = ? WHERE folder_id = ?").bind(now, message.slice(0, 300), computer.id).run();
      result.computers.push({ name: computer.name, newFiles: -1, totalFiles: 0, error: message });
      continue;
    }
    await env.DB.prepare("UPDATE drive_computers SET total_files = ?, last_scan_at = ?, scan_error = NULL WHERE folder_id = ?").bind(all.length, now, computer.id).run();
    result.computers.push({ name: computer.name, newFiles: fresh.length, totalFiles: all.length });
    for (let i = 0; i < fresh.length; i += MAX_FILES_PER_JOB) {
      const chunk = fresh.slice(i, i + MAX_FILES_PER_JOB);
      const jobId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO drive_jobs (id, computer_id, computer_name, day, status, files_json, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        ).bind(jobId, computer.id, computer.name.slice(0, 200), today, JSON.stringify(chunk), now + i),
        ...chunk.map((f) =>
          env.DB.prepare(`INSERT OR IGNORE INTO drive_files (file_id, computer_id, name, file_day, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(f.id, computer.id, f.path.slice(0, 300), f.day, jobId, now),
        ),
      ]);
    }
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
  await env.BATCH_RUNNER.getByName(batchId, { locationHint: "enam" }).start(config, files.map((f) => ({ id: f.id, path: f.path, name: f.name, date: f.day })));
  await env.DB.prepare("UPDATE drive_jobs SET status = 'running', batch_id = ? WHERE id = ?").bind(batchId, job.id).run();
}

/**
 * Start queued jobs while a slot is free, then retry the failed videos of finished jobs.
 * A finished job is retried again and again (with a growing pause) until nothing retryable is left,
 * so a busy Gemini or a bad moment never leaves files failed. Broken files are never retried.
 * force: ignore the pause (used by the "Retry all failed" button).
 */
export async function pumpJobs(force = false): Promise<{ started: number; retried: number; finished: number }> {
  const summary = { started: 0, retried: 0, finished: 0 };
  const connection = await getConnection();
  if (!connection?.enabled) return summary;

  const running = await env.DB.prepare(
    `SELECT j.id, b.status AS batch_status FROM drive_jobs j LEFT JOIN batches b ON b.id = j.batch_id WHERE j.status = 'running'`,
  ).all<{ id: string; batch_status: string | null }>();
  let active = 0;
  for (const job of running.results) {
    if (job.batch_status === "running") {
      active++;
      continue;
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
        active++;
      } catch (error) {
        console.error(`Could not start the job for ${job.computer_name}:`, error);
      }
    }
  }

  if (active < MAX_CONCURRENT) {
    const now = Date.now();
    // The pause before the next try grows with every try: 5, 10, 15 ... 30 minutes.
    const candidates = await env.DB.prepare(
      `SELECT j.id, j.batch_id, j.attempts, b.finished_at
         FROM drive_jobs j JOIN batches b ON b.id = j.batch_id
        WHERE j.status = 'done' AND b.status = 'done' AND b.failed_count > 0 AND j.attempts < ?
        ORDER BY j.attempts, b.finished_at LIMIT 40`,
    )
      .bind(MAX_ATTEMPTS)
      .all<{ id: string; batch_id: string; attempts: number; finished_at: number | null }>();
    for (const job of candidates.results) {
      if (active >= MAX_CONCURRENT) break;
      const wait = Math.min(job.attempts + 1, 6) * RETRY_COOLDOWN_MS;
      if (!force && job.finished_at && now - job.finished_at < wait) continue;
      const runner = env.BATCH_RUNNER.getByName(job.batch_id);
      const retryable = await runner.hasRetryable(connection.user_id).catch(() => true);
      if (!retryable) {
        // Only broken files are left (no audio, empty, corrupt): nothing more to try.
        await env.DB.prepare("UPDATE drive_jobs SET attempts = ? WHERE id = ?").bind(MAX_ATTEMPTS, job.id).run();
        continue;
      }
      if (await runner.resume(connection.user_id).catch(() => false)) {
        await env.DB.prepare("UPDATE drive_jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").bind(job.id).run();
        summary.retried++;
        active++;
      }
    }
  }
  if (summary.started || summary.finished || summary.retried) await refreshSheetDashboardSafe();
  return summary;
}

/** The "Retry all failed" button: give every finished job with failed videos fresh retry rounds and start them now. */
export async function retryAllFailed(): Promise<{ jobs: number; started: number }> {
  const reset = await env.DB.prepare(
    `UPDATE drive_jobs SET attempts = 0
      WHERE status = 'done' AND batch_id IN (SELECT id FROM batches WHERE failed_count > 0 AND status = 'done')`,
  ).run();
  const summary = await pumpJobs(true);
  return { jobs: Number(reset.meta?.changes || 0), started: summary.retried };
}

/** What the cron does at 23:50, and what the "Run now" button does. */
export async function nightlyRun(now = Date.now()): Promise<QueueResult & { pump: Awaited<ReturnType<typeof pumpJobs>> }> {
  const queued = await queueNight(now);
  return { ...queued, pump: await pumpJobs() };
}
