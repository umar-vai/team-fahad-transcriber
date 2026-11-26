import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { LANGUAGES } from "../../../lib/gemini";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { dayOf, dayStart, discoverComputers, driveAccessToken, getConnection, getConnections, nightlyRun, retryAllFailed } from "../../../lib/autodrive";
import { refreshSheetDashboard } from "../../../lib/sheetdash";
import { accountSpreadsheetId, checkSpreadsheetAccess, spreadsheetId } from "../../../lib/sheets";
import { BATCH_MODES, type BatchMode } from "../../../batch/runner";

/** Connected Drive accounts, the computers found in them, and the latest nightly jobs. */
export const GET: APIRoute = handler(async (context) => {
  requireUser(context);
  const connections = await getConnections();
  let computers: { id: string; name: string }[] | null = null;
  let driveError: string | null = null;
  const checkId = context.url.searchParams.get("check") === "1" ? context.url.searchParams.get("account") : null;
  const checked = checkId ? connections.find((c) => c.id === checkId) : null;
  if (checked) {
    try {
      computers = await discoverComputers(await driveAccessToken(checked), checked.extra_folders || "");
    } catch (error) {
      driveError = error instanceof Error ? error.message : String(error);
    }
  }
  const jobs = await env.DB.prepare(
    `SELECT j.id, j.account_id, j.computer_name, j.day, j.status, j.attempts, j.batch_id, j.files_json, b.done_count, b.failed_count, b.total, b.status AS batch_status, b.notion_url, b.sheet_url
       FROM drive_jobs j LEFT JOIN batches b ON b.id = j.batch_id ORDER BY j.created_at DESC LIMIT 150`,
  ).all<any>();
  const today = dayOf(Date.now());
  const stats = await env.DB.prepare(
    `SELECT c.folder_id AS id, c.account_id, c.name, c.total_files, c.last_scan_at, c.scan_error,
       (SELECT COUNT(*) FROM drive_files f WHERE f.computer_id = c.folder_id) AS picked_up,
       (SELECT COUNT(*) FROM drive_files f WHERE f.computer_id = c.folder_id AND f.file_day = ?1) AS recorded_today,
       (SELECT COALESCE(SUM(b.done_count), 0) FROM batches b WHERE b.folder_id = c.folder_id) AS done,
       (SELECT COALESCE(SUM(b.failed_count), 0) FROM batches b WHERE b.folder_id = c.folder_id) AS failed,
       (SELECT COALESCE(SUM(b.done_count), 0) FROM batches b WHERE b.folder_id = c.folder_id AND b.created_at >= ?2) AS done_today,
       (SELECT COUNT(*) FROM drive_jobs j WHERE j.computer_id = c.folder_id AND j.status != 'done') AS open_jobs,
       (SELECT COALESCE(SUM(MAX(json_array_length(j.files_json) - COALESCE(b.done_count, 0) - COALESCE(b.failed_count, 0), 0)), 0)
          FROM drive_jobs j LEFT JOIN batches b ON b.id = j.batch_id
         WHERE j.computer_id = c.folder_id AND j.status != 'done') AS waiting
       FROM drive_computers c ORDER BY c.name COLLATE NOCASE`,
  )
    .bind(today, dayStart(today))
    .all<any>();
  return json({
    today,
    connected: connections.length > 0,
    accounts: connections.map((c) => {
      const sheet = accountSpreadsheetId(c.spreadsheet);
      return {
        id: c.id,
        email: c.google_email,
        enabled: Boolean(c.enabled),
        notion: Boolean(c.notion_enabled),
        mode: c.mode,
        language: c.language,
        spreadsheet: c.spreadsheet || "",
        extraFolders: c.extra_folders || "",
        ownSheet: Boolean(spreadsheetId(c.spreadsheet || undefined)),
        sheetUrl: sheet ? `https://docs.google.com/spreadsheets/d/${sheet}/edit` : null,
      };
    }),
    stats: stats.results,
    checkedAccount: checked?.id || null,
    computers,
    driveError,
    jobs: jobs.results.map((j) => ({ ...j, files: JSON.parse(j.files_json || "[]").length, files_json: undefined })),
  });
});

/** Run the nightly scan now (same as the 23:50 cron), for all accounts. */
export const POST: APIRoute = handler(async (context) => {
  requireUser(context);
  if (!(await getConnections()).length) throw new HttpError(400, "Connect Google Drive first.");
  if (context.url.searchParams.get("dashboard") === "1") {
    const url = await refreshSheetDashboard(Date.now(), context.url.searchParams.get("account") || undefined);
    if (!url) throw new HttpError(400, "Google Sheets is not set up (add a spreadsheet link for this account, or SHEETS_SPREADSHEET_ID, and the service account).");
    return json({ ok: true, url });
  }
  if (context.url.searchParams.get("retry") === "1") return json(await retryAllFailed());
  return json(await nightlyRun());
});

/** Change the settings of one account: on/off, Notion, output style, language, spreadsheet, extra folders. */
export const PATCH: APIRoute = handler(async (context) => {
  requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  const account = await getConnection(String(body.account || ""));
  if (!account) throw new HttpError(400, "Choose a connected Drive account.");
  const set = (column: string, value: string | number | null) =>
    env.DB.prepare(`UPDATE drive_accounts SET ${column} = ? WHERE id = ?`).bind(value, account.id).run();
  if (body.enabled !== undefined) await set("enabled", body.enabled ? 1 : 0);
  if (body.notion !== undefined) await set("notion_enabled", body.notion ? 1 : 0);
  if (body.mode !== undefined) {
    if (!(String(body.mode) in BATCH_MODES)) throw new HttpError(400, "Choose Smart clean or Subtitles (timed).");
    await set("mode", String(body.mode) as BatchMode);
  }
  if (body.language !== undefined) {
    if (!LANGUAGES[String(body.language)]) throw new HttpError(400, "Unknown language.");
    await set("language", String(body.language));
  }
  if (body.spreadsheet !== undefined) {
    const raw = String(body.spreadsheet || "").trim();
    if (raw && !spreadsheetId(raw)) throw new HttpError(400, "That is not a Google Sheets link. Paste the spreadsheet link (docs.google.com/spreadsheets/d/...), or leave it empty to use the team spreadsheet.");
    if (raw) {
      // Fail now, not on the first transcript: the sheet must be shared with the service account.
      await checkSpreadsheetAccess(raw).catch((error) => {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      });
    }
    await set("spreadsheet", raw || null);
  }
  if (body.extraFolders !== undefined) await set("extra_folders", String(body.extraFolders || "").trim().slice(0, 2000) || null);
  return json({ ok: true });
});

/** Disconnect one Drive account. Its finished transcripts stay; its waiting jobs are removed. */
export const DELETE: APIRoute = handler(async (context) => {
  requireUser(context);
  const account = await getConnection(context.url.searchParams.get("account") || "");
  if (!account) throw new HttpError(404, "That Drive account is not connected.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM drive_jobs WHERE account_id = ? AND status = 'queued'").bind(account.id),
    env.DB.prepare("DELETE FROM drive_accounts WHERE id = ?").bind(account.id),
  ]);
  return json({ ok: true });
});
