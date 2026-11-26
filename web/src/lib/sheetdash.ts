/**
 * A "Dashboard" tab in the team spreadsheet: totals, one row per computer, a table by day, a list of failed
 * files and two charts. It is rewritten after every nightly job, so it is always current.
 *
 * Numbers come from D1 (computers, picked up files, jobs). Which files finished or failed comes from the
 * BatchRunner of the jobs that are still running or had failures; finished jobs without failures are all done.
 */
import { env } from "cloudflare:workers";
import { googleApi } from "./google";
import { accountSpreadsheetId, sheetsConfigured } from "./sheets";
import { getConnections, type DriveConnection } from "./autodrive";

/** Bangladesh calendar day (UTC+6, no daylight saving). */
const dayOf = (ms: number) => new Date(ms + 6 * 3600_000).toISOString().slice(0, 10);
const API = "https://sheets.googleapis.com/v4/spreadsheets";
export const DASHBOARD_TAB = "Dashboard";
const DAYS_SHOWN = 14;
const MAX_FAILED_ROWS = 100;
const MAX_RUNNER_CALLS = 60;

// ---------- Numbers ----------

export type FileState = "done" | "failed" | "waiting";

export interface DashInput {
  today: string;
  computers: { id: string; name: string; totalFiles: number }[];
  files: { id: string; computerId: string; day: string; state: FileState; name: string; error?: string }[];
}

export interface DashSummary {
  today: string;
  rows: { id: string; name: string; recorded: number; done: number; waiting: number; failed: number; percent: number; recordedToday: number }[];
  totals: { computers: number; recorded: number; done: number; waiting: number; failed: number; percent: number };
  days: { day: string; recorded: number; done: number; failed: number; waiting: number; perComputer: number[] }[];
  failedFiles: { computer: string; day: string; fileId: string; name: string; error: string }[];
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

export function summarize(input: DashInput): DashSummary {
  const names = new Map(input.computers.map((c) => [c.id, c.name]));
  const rows = input.computers.map((computer) => {
    const mine = input.files.filter((f) => f.computerId === computer.id);
    const done = mine.filter((f) => f.state === "done").length;
    const failed = mine.filter((f) => f.state === "failed").length;
    const recorded = Math.max(computer.totalFiles, mine.length);
    return {
      id: computer.id,
      name: computer.name,
      recorded,
      done,
      failed,
      waiting: Math.max(0, recorded - done - failed),
      percent: recorded ? done / recorded : 0,
      recordedToday: mine.filter((f) => f.day === input.today).length,
    };
  });
  const sum = (key: "recorded" | "done" | "waiting" | "failed") => rows.reduce((total, row) => total + row[key], 0);
  const recorded = sum("recorded");
  const totals = { computers: rows.length, recorded, done: sum("done"), waiting: sum("waiting"), failed: sum("failed"), percent: recorded ? sum("done") / recorded : 0 };

  const days = [];
  for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
    const day = shiftDay(input.today, -i);
    const mine = input.files.filter((f) => f.day === day);
    days.push({
      day,
      recorded: mine.length,
      done: mine.filter((f) => f.state === "done").length,
      failed: mine.filter((f) => f.state === "failed").length,
      waiting: mine.filter((f) => f.state === "waiting").length,
      perComputer: rows.map((row) => mine.filter((f) => f.computerId === row.id).length),
    });
  }
  const failedFiles = input.files
    .filter((f) => f.state === "failed")
    .sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name))
    .slice(0, MAX_FAILED_ROWS)
    .map((f) => ({ computer: names.get(f.computerId) || "", day: f.day, fileId: f.id, name: f.name, error: f.error || "" }));
  return { today: input.today, rows, totals, days, failedFiles };
}

// ---------- Reading the data ----------

async function loadInput(now: number, account: DriveConnection): Promise<DashInput> {
  const computers = (await env.DB.prepare("SELECT folder_id, name, total_files FROM drive_computers WHERE account_id = ? ORDER BY name COLLATE NOCASE").bind(account.id).all<any>()).results.map((c) => ({
    id: String(c.folder_id),
    name: String(c.name),
    totalFiles: Number(c.total_files || 0),
  }));
  const picked = (await env.DB.prepare("SELECT file_id, computer_id, name, file_day, job_id FROM drive_files WHERE computer_id IN (SELECT folder_id FROM drive_computers WHERE account_id = ?)").bind(account.id).all<any>()).results;
  const jobs = (
    await env.DB.prepare(
      `SELECT j.id, j.status, j.batch_id, b.status AS batch_status, b.failed_count FROM drive_jobs j LEFT JOIN batches b ON b.id = j.batch_id WHERE j.account_id = ?`,
    ).bind(account.id).all<any>()
  ).results;
  const connection = { user_id: account.user_id };

  // Per job: which files are done, failed, or still waiting.
  const stateByFile = new Map<string, { state: FileState; name?: string; error?: string }>();
  let calls = 0;
  const jobState = new Map<string, string>();
  for (const job of jobs) {
    const finished = job.batch_id && job.batch_status && job.batch_status !== "running";
    if (!job.batch_id) jobState.set(job.id, "waiting");
    else if (finished && Number(job.failed_count || 0) === 0) jobState.set(job.id, "done");
    else jobState.set(job.id, "detail");
    if (jobState.get(job.id) !== "detail" || !connection || calls >= MAX_RUNNER_CALLS) continue;
    calls++;
    try {
      const status: any = await env.BATCH_RUNNER.getByName(job.batch_id).status(connection.user_id);
      for (const item of status?.items || []) {
        const state: FileState = item.status === "done" ? "done" : item.status === "failed" ? "failed" : "waiting";
        stateByFile.set(String(item.fileId || ""), { state, name: item.name, error: item.error || undefined });
      }
    } catch (error) {
      console.warn("Dashboard: batch status failed:", error);
    }
  }
  const jobOfFile = new Map<string, string>();
  const files = picked.map((row) => {
    jobOfFile.set(String(row.file_id), String(row.job_id));
    const detail = stateByFile.get(String(row.file_id));
    const byJob = jobState.get(String(row.job_id));
    const state: FileState = detail ? detail.state : byJob === "done" ? "done" : "waiting";
    return {
      id: String(row.file_id),
      computerId: String(row.computer_id),
      day: String(row.file_day),
      state,
      name: detail?.name || String(row.name),
      error: detail?.error,
    };
  });
  return { today: dayOf(now), computers, files };
}

// ---------- Writing the sheet ----------

const NAVY = { red: 0.15, green: 0.17, blue: 0.32 };
const LAVENDER = { red: 0.93, green: 0.92, blue: 1 };
const GREY = { red: 0.96, green: 0.96, blue: 0.98 };
const GREEN = { red: 0.05, green: 0.55, blue: 0.35 };
const RED = { red: 0.8, green: 0.15, blue: 0.15 };
const AMBER = { red: 0.7, green: 0.45, blue: 0.0 };

type Cell = Record<string, unknown>;
const text = (value: string, format: Cell = {}): Cell => ({ userEnteredValue: { stringValue: value }, userEnteredFormat: format });
const num = (value: number, format: Cell = {}): Cell => ({ userEnteredValue: { numberValue: value }, userEnteredFormat: format });
const link = (url: string, label: string): Cell => ({
  userEnteredValue: { formulaValue: `=HYPERLINK("${url}","${label.replace(/"/g, '""')}")` },
  userEnteredFormat: { textFormat: { foregroundColor: { red: 0.2, green: 0.25, blue: 0.85 }, underline: true } },
});
const head = (label: string): Cell =>
  text(label, { backgroundColor: NAVY, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" });

/** Build the cell grid. Returns the rows and where the tables start, for the charts. */
export function buildGrid(summary: DashSummary, updated: string) {
  const grid: Cell[][] = [];
  const add = (...cells: Cell[]) => grid.push(cells);
  const blank = () => grid.push([]);
  const section = (label: string) => add(text(label, { textFormat: { bold: true, fontSize: 13, foregroundColor: NAVY } }));
  const t = summary.totals;

  add(text("Team Fahad Transcriber · Dashboard", { textFormat: { bold: true, fontSize: 20, foregroundColor: NAVY } }));
  add(text(`Updated ${updated} (Bangladesh time). Rewritten automatically after every nightly job.`, { textFormat: { italic: true, foregroundColor: { red: 0.4, green: 0.4, blue: 0.45 } } }));
  blank();
  const tile = (label: string, color: Cell) => text(label, { backgroundColor: LAVENDER, textFormat: { bold: true, fontSize: 10, foregroundColor: color }, horizontalAlignment: "CENTER" });
  const big = (value: number, color: Cell, pct = false) =>
    num(value, { backgroundColor: LAVENDER, textFormat: { bold: true, fontSize: 24, foregroundColor: color }, horizontalAlignment: "CENTER", ...(pct ? { numberFormat: { type: "PERCENT", pattern: "0%" } } : {}) });
  add(tile("COMPUTERS", NAVY), tile("RECORDED", NAVY), tile("TRANSCRIBED", GREEN), tile("WAITING", AMBER), tile("FAILED", RED), tile("DONE", NAVY));
  add(big(t.computers, NAVY), big(t.recorded, NAVY), big(t.done, GREEN), big(t.waiting, AMBER), big(t.failed, RED), big(t.percent, NAVY, true));
  blank();

  // Two charts sit here (rows 7 to 23).
  const chartsRow = grid.length;
  for (let i = 0; i < 17; i++) blank();

  section("By computer");
  const computerHeader = grid.length;
  add(head("Computer"), head("Recorded"), head("Transcribed"), head("Waiting"), head("Failed"), head("Done %"), head("Recorded today"));
  summary.rows.forEach((row, i) => {
    const band = i % 2 ? { backgroundColor: GREY } : {};
    add(
      text(row.name, { ...band, textFormat: { bold: true } }),
      num(row.recorded, band),
      num(row.done, { ...band, textFormat: { foregroundColor: GREEN } }),
      num(row.waiting, { ...band, textFormat: { foregroundColor: AMBER } }),
      num(row.failed, { ...band, textFormat: { foregroundColor: row.failed ? RED : { red: 0.5, green: 0.5, blue: 0.5 }, bold: row.failed > 0 } }),
      num(row.percent, { ...band, numberFormat: { type: "PERCENT", pattern: "0%" } }),
      num(row.recordedToday, band),
    );
  });
  const bold = { backgroundColor: LAVENDER, textFormat: { bold: true } };
  add(text("Total", bold), num(t.recorded, bold), num(t.done, bold), num(t.waiting, bold), num(t.failed, bold), num(t.percent, { ...bold, numberFormat: { type: "PERCENT", pattern: "0%" } }), num(summary.rows.reduce((s, r) => s + r.recordedToday, 0), bold));
  blank();

  section(`By day (last ${DAYS_SHOWN} days, recordings by their recording date)`);
  const dayHeader = grid.length;
  add(head("Date"), head("Recorded"), head("Transcribed"), head("Failed"), head("Waiting"), ...summary.rows.map((row) => head(row.name)));
  summary.days.forEach((d, i) => {
    const band = i % 2 ? { backgroundColor: GREY } : {};
    const today = d.day === summary.today ? { textFormat: { bold: true } } : {};
    add(
      text(d.day, { ...band, ...today }),
      num(d.recorded, band),
      num(d.done, { ...band, textFormat: { foregroundColor: GREEN } }),
      num(d.failed, { ...band, textFormat: { foregroundColor: d.failed ? RED : { red: 0.5, green: 0.5, blue: 0.5 } } }),
      num(d.waiting, { ...band, textFormat: { foregroundColor: AMBER } }),
      ...d.perComputer.map((n) => num(n, { ...band, ...(n ? {} : { textFormat: { foregroundColor: { red: 0.65, green: 0.65, blue: 0.7 } } }) })),
    );
  });
  blank();

  section("Failed files");
  add(head("Computer"), head("Date"), head("File"), head("Reason"));
  if (!summary.failedFiles.length) add(text("No failed files.", { textFormat: { foregroundColor: GREEN, bold: true } }));
  for (const f of summary.failedFiles) {
    add(text(f.computer), text(f.day), link(`https://drive.google.com/file/d/${f.fileId}/view`, f.name || f.fileId), text(f.error.slice(0, 300), { textFormat: { foregroundColor: RED } }));
  }
  return { grid, chartsRow, computerHeader, dayHeader, computerCount: summary.rows.length, dayCount: summary.days.length };
}

function chartRequest(sheetId: number, title: string, anchorColumn: number, anchorRow: number, domain: [number, number, number, number], series: { range: [number, number, number, number]; color: Record<string, number> }[], stacked: boolean) {
  const range = (r: [number, number, number, number]) => ({ sheetId, startRowIndex: r[0], endRowIndex: r[1], startColumnIndex: r[2], endColumnIndex: r[3] });
  return {
    addChart: {
      chart: {
        spec: {
          title,
          basicChart: {
            chartType: "COLUMN",
            legendPosition: "BOTTOM_LEGEND",
            ...(stacked ? { stackedType: "STACKED" } : {}),
            axis: [{ position: "BOTTOM_AXIS" }, { position: "LEFT_AXIS" }],
            domains: [{ domain: { sourceRange: { sources: [range(domain)] } } }],
            series: series.map((s) => ({ series: { sourceRange: { sources: [range(s.range)] } }, targetAxis: "LEFT_AXIS", color: s.color })),
            headerCount: 1,
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorColumn }, widthPixels: 455, heightPixels: 340, offsetXPixels: 6, offsetYPixels: 4 } },
      },
    },
  };
}

/** Rewrite the Dashboard tab of every connected account (each in its own spreadsheet). Returns the first dashboard's link. */
export async function refreshSheetDashboard(now = Date.now(), accountId?: string): Promise<string | null> {
  const accounts = (await getConnections()).filter((a) => !accountId || a.id === accountId);
  let first: string | null = null;
  for (const account of accounts) {
    if (!sheetsConfigured(account.spreadsheet)) continue;
    // Accounts that share one spreadsheet each get a tab named after their email.
    const shared = accounts.length > 1 && accounts.some((o) => o.id !== account.id && accountSpreadsheetId(o.spreadsheet) === accountSpreadsheetId(account.spreadsheet));
    try {
      const url = await writeDashboard(account, now, shared ? `${DASHBOARD_TAB} ${account.google_email.split("@")[0]}`.slice(0, 100) : DASHBOARD_TAB);
      first ||= url;
    } catch (error) {
      // One account's sheet problem must not stop the others (an explicit single-account refresh still reports it).
      if (accountId) throw error;
      console.warn(`Dashboard of ${account.google_email} failed:`, error);
    }
  }
  return first;
}

async function writeDashboard(account: DriveConnection, now: number, tabTitle: string): Promise<string> {
  const id = accountSpreadsheetId(account.spreadsheet)!;
  const base = env.SHEETS_API_BASE || API;
  const summary = summarize(await loadInput(now, account));
  const updated = new Date(now + 6 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  const built = buildGrid(summary, updated);

  const meta = await googleApi(`${base}/${id}?fields=sheets(properties(sheetId,title),charts(chartId))`);
  let sheet = (meta.sheets || []).find((s: any) => s.properties?.title === tabTitle);
  if (!sheet) {
    const added = await googleApi(`${base}/${id}:batchUpdate`, {
      body: { requests: [{ addSheet: { properties: { title: tabTitle, index: 0, tabColor: NAVY, gridProperties: { hideGridlines: true } } } }] },
    });
    sheet = { properties: { sheetId: added.replies?.[0]?.addSheet?.properties?.sheetId }, charts: [] };
  }
  const sheetId = Number(sheet.properties.sheetId);
  const columns = 5 + summary.rows.length;
  const widths = [170, 95, 110, 95, 95, 95, 130];
  const dayHeaderRow = built.dayHeader;

  const requests: any[] = [
    ...(sheet.charts || []).map((c: any) => ({ deleteEmbeddedObject: { objectId: c.chartId } })),
    { updateSheetProperties: { properties: { sheetId, gridProperties: { hideGridlines: true, frozenRowCount: 0 } }, fields: "gridProperties.hideGridlines,gridProperties.frozenRowCount" } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 400, startColumnIndex: 0, endColumnIndex: 30 }, cell: {}, fields: "userEnteredValue,userEnteredFormat" } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: built.grid.map((values) => ({ values })), fields: "userEnteredValue,userEnteredFormat" } },
    ...Array.from({ length: Math.max(columns, widths.length) }, (_, i) => ({
      updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: widths[i] || 110 }, fields: "pixelSize" },
    })),
    { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 46 }, fields: "pixelSize" } },
    chartRequest(sheetId, "Transcription progress by computer", 0, built.chartsRow, [built.computerHeader, built.computerHeader + 1 + built.computerCount, 0, 1], [
      { range: [built.computerHeader, built.computerHeader + 1 + built.computerCount, 2, 3], color: { red: 0.05, green: 0.65, blue: 0.4 } },
      { range: [built.computerHeader, built.computerHeader + 1 + built.computerCount, 3, 4], color: { red: 0.95, green: 0.65, blue: 0.1 } },
      { range: [built.computerHeader, built.computerHeader + 1 + built.computerCount, 4, 5], color: { red: 0.85, green: 0.2, blue: 0.2 } },
    ], true),
    chartRequest(sheetId, "Recorded and transcribed per day", 4, built.chartsRow, [dayHeaderRow, dayHeaderRow + 1 + built.dayCount, 0, 1], [
      { range: [dayHeaderRow, dayHeaderRow + 1 + built.dayCount, 1, 2], color: { red: 0.4, green: 0.35, blue: 0.95 } },
      { range: [dayHeaderRow, dayHeaderRow + 1 + built.dayCount, 2, 3], color: { red: 0.05, green: 0.65, blue: 0.4 } },
    ], false),
  ];
  await googleApi(`${base}/${id}:batchUpdate`, { body: { requests } });
  return `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${sheetId}`;
}

/** Never lets a dashboard problem break the nightly work. */
export async function refreshSheetDashboardSafe(): Promise<void> {
  try {
    await refreshSheetDashboard();
  } catch (error) {
    console.warn("Sheet dashboard update failed:", error);
  }
}
