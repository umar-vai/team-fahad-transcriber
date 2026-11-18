import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { LANGUAGES } from "../../../lib/gemini";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { dayOf, dayStart, discoverComputers, driveAccessToken, getConnection, nightlyRun } from "../../../lib/autodrive";
import { BATCH_MODES, type BatchMode } from "../../../batch/runner";

/** Connection state, the computers found in Drive, and the latest nightly jobs. */
export const GET: APIRoute = handler(async (context) => {
  requireUser(context);
  const connection = await getConnection();
  let computers: { id: string; name: string }[] | null = null;
  let driveError: string | null = null;
  if (connection && context.url.searchParams.get("check") === "1") {
    try {
      computers = await discoverComputers(await driveAccessToken(connection));
    } catch (error) {
      driveError = error instanceof Error ? error.message : String(error);
    }
  }
  const jobs = await env.DB.prepare(
    `SELECT j.id, j.computer_name, j.day, j.status, j.attempts, j.batch_id, j.files_json, b.done_count, b.failed_count, b.total, b.status AS batch_status, b.notion_url, b.sheet_url
       FROM drive_jobs j LEFT JOIN batches b ON b.id = j.batch_id ORDER BY j.created_at DESC LIMIT 150`,
  ).all<any>();
  const today = dayOf(Date.now());
  const stats = await env.DB.prepare(
    `SELECT c.folder_id AS id, c.name, c.total_files, c.last_scan_at, c.scan_error,
       (SELECT COUNT(*) FROM drive_files f WHERE f.computer_id = c.folder_id) AS picked_up,
       (SELECT COUNT(*) FROM drive_files f WHERE f.computer_id = c.folder_id AND f.file_day = ?1) AS recorded_today,
       (SELECT COALESCE(SUM(b.done_count), 0) FROM batches b WHERE b.folder_id = c.folder_id) AS done,
       (SELECT COALESCE(SUM(b.failed_count), 0) FROM batches b WHERE b.folder_id = c.folder_id) AS failed,
       (SELECT COALESCE(SUM(b.done_count), 0) FROM batches b WHERE b.folder_id = c.folder_id AND b.created_at >= ?2) AS done_today,
       (SELECT COUNT(*) FROM drive_jobs j WHERE j.computer_id = c.folder_id AND j.status != 'done') AS open_jobs
       FROM drive_computers c ORDER BY c.name COLLATE NOCASE`,
  )
    .bind(today, dayStart(today))
    .all<any>();
  return json({
    today,
    stats: stats.results,
    connected: Boolean(connection),
    email: connection?.google_email || null,
    enabled: connection ? Boolean(connection.enabled) : false,
    notion: connection ? Boolean(connection.notion_enabled) : false,
    mode: connection?.mode || "smart",
    language: connection?.language || "Bangla (Bangladesh)",
    computers,
    driveError,
    jobs: jobs.results.map((j) => ({ ...j, files: JSON.parse(j.files_json || "[]").length, files_json: undefined })),
  });
});

/** Run the nightly scan now (same as the 23:50 cron). Useful to test the connection. */
export const POST: APIRoute = handler(async (context) => {
  requireUser(context);
  if (!(await getConnection())) throw new HttpError(400, "Connect Google Drive first.");
  return json(await nightlyRun());
});

/** Change settings: on/off, Notion export on/off, output style, language. */
export const PATCH: APIRoute = handler(async (context) => {
  requireUser(context);
  if (!(await getConnection())) throw new HttpError(400, "Connect Google Drive first.");
  const body: any = await context.request.json().catch(() => ({}));
  if (body.enabled !== undefined) await env.DB.prepare("UPDATE drive_connection SET enabled = ? WHERE id = 1").bind(body.enabled ? 1 : 0).run();
  if (body.notion !== undefined) await env.DB.prepare("UPDATE drive_connection SET notion_enabled = ? WHERE id = 1").bind(body.notion ? 1 : 0).run();
  if (body.mode !== undefined) {
    if (!(String(body.mode) in BATCH_MODES)) throw new HttpError(400, "Choose Smart clean or Subtitles (timed).");
    await env.DB.prepare("UPDATE drive_connection SET mode = ? WHERE id = 1").bind(String(body.mode) as BatchMode).run();
  }
  if (body.language !== undefined) {
    if (!LANGUAGES[String(body.language)]) throw new HttpError(400, "Unknown language.");
    await env.DB.prepare("UPDATE drive_connection SET language = ? WHERE id = 1").bind(String(body.language)).run();
  }
  return json({ ok: true });
});
