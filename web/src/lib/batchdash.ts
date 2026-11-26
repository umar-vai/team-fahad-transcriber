/**
 * A "Dashboard" tab for one Drive folder batch (the manual folder import, for example 3,000 files):
 * totals, a status chart and one row per file with its name, status, words, length and Drive link.
 * Rewritten every time the batch finishes, so a retry run updates it.
 */
import { env } from "cloudflare:workers";
import { googleApi } from "./google";
import { safeTabTitle, sheetsConfigured, spreadsheetId, type SheetTab } from "./sheets";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const NAVY = { red: 0.15, green: 0.17, blue: 0.32 };
const LAVENDER = { red: 0.93, green: 0.92, blue: 1 };
const GREY = { red: 0.96, green: 0.96, blue: 0.98 };
const GREEN = { red: 0.05, green: 0.55, blue: 0.35 };
const RED = { red: 0.8, green: 0.15, blue: 0.15 };
const AMBER = { red: 0.7, green: 0.45, blue: 0 };

export interface DashItem {
  index: number;
  fileId: string;
  title: string;
  status: string;
  words?: number;
  duration?: number | null;
  error?: string;
  permanent?: boolean;
}

export type FileKind = "Transcribed" | "No speech" | "Failed" | "Waiting";

export function kindOf(item: DashItem): FileKind {
  if (item.status === "done") return "Transcribed";
  if (item.status === "failed") return /no speech/i.test(item.error || "") ? "No speech" : "Failed";
  return "Waiting";
}

export function summarizeBatch(items: DashItem[]) {
  const count: Record<FileKind, number> = { Transcribed: 0, "No speech": 0, Failed: 0, Waiting: 0 };
  let words = 0;
  let seconds = 0;
  for (const item of items) {
    count[kindOf(item)]++;
    words += item.words || 0;
    seconds += item.duration || 0;
  }
  const done = count.Transcribed;
  return { total: items.length, count, words, seconds, averageWords: done ? Math.round(words / done) : 0, percent: items.length ? done / items.length : 0 };
}

const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
};

type Cell = Record<string, unknown>;
const text = (value: string, format: Cell = {}): Cell => ({ userEnteredValue: { stringValue: value }, userEnteredFormat: format });
const num = (value: number, format: Cell = {}): Cell => ({ userEnteredValue: { numberValue: value }, userEnteredFormat: format });
const head = (label: string): Cell => text(label, { backgroundColor: NAVY, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, horizontalAlignment: "CENTER" });
const link = (url: string, label: string): Cell => ({
  userEnteredValue: { formulaValue: `=HYPERLINK("${url}","${label.replace(/"/g, '""')}")` },
  userEnteredFormat: { textFormat: { foregroundColor: { red: 0.2, green: 0.25, blue: 0.85 }, underline: true } },
});

export function buildBatchGrid(folderName: string, items: DashItem[], updated: string) {
  const s = summarizeBatch(items);
  const grid: Cell[][] = [];
  const tile = (label: string, color: Cell) => text(label, { backgroundColor: LAVENDER, textFormat: { bold: true, fontSize: 10, foregroundColor: color }, horizontalAlignment: "CENTER" });
  const big = (value: number, color: Cell, pct = false) =>
    num(value, { backgroundColor: LAVENDER, textFormat: { bold: true, fontSize: 22, foregroundColor: color }, horizontalAlignment: "CENTER", ...(pct ? { numberFormat: { type: "PERCENT", pattern: "0%" } } : { numberFormat: { type: "NUMBER", pattern: "#,##0" } }) });
  grid.push([text(`${folderName} · Dashboard`, { textFormat: { bold: true, fontSize: 20, foregroundColor: NAVY } })]);
  grid.push([text(`Updated ${updated} UTC. Rewritten when the folder finishes or is retried.`, { textFormat: { italic: true, foregroundColor: { red: 0.4, green: 0.4, blue: 0.45 } } })]);
  grid.push([]);
  grid.push([tile("FILES", NAVY), tile("TRANSCRIBED", GREEN), tile("NO SPEECH", AMBER), tile("FAILED", RED), tile("WAITING", AMBER), tile("DONE", NAVY), tile("TOTAL WORDS", NAVY), tile("AVG WORDS", NAVY)]);
  grid.push([big(s.total, NAVY), big(s.count.Transcribed, GREEN), big(s.count["No speech"], AMBER), big(s.count.Failed, RED), big(s.count.Waiting, AMBER), big(s.percent, NAVY, true), big(s.words, NAVY), big(s.averageWords, NAVY)]);
  grid.push([]);
  const statusHeader = grid.length;
  grid.push([head("Status"), head("Files")]);
  for (const kind of ["Transcribed", "No speech", "Failed", "Waiting"] as FileKind[]) grid.push([text(kind), num(s.count[kind])]);
  while (grid.length < statusHeader + 12) grid.push([]);
  const tableHeader = grid.length;
  grid.push([head("No."), head("File"), head("Status"), head("Words"), head("Length"), head("Note")]);
  items.forEach((item, i) => {
    const band = i % 2 ? { backgroundColor: GREY } : {};
    const kind = kindOf(item);
    const color = kind === "Transcribed" ? GREEN : kind === "Failed" ? RED : AMBER;
    grid.push([
      num(item.index + 1, band),
      link(`https://drive.google.com/file/d/${item.fileId}/view`, item.title || item.fileId),
      text(kind, { ...band, textFormat: { bold: true, foregroundColor: color } }),
      num(item.words || 0, band),
      text(item.duration ? clock(item.duration) : "", band),
      text(kind === "Transcribed" ? "" : (item.error || "").slice(0, 300), { ...band, textFormat: { foregroundColor: color } }),
    ]);
  });
  return { grid, statusHeader, tableHeader };
}

export async function writeBatchDashboard(tab: SheetTab, folderName: string, items: DashItem[]): Promise<void> {
  if (!sheetsConfigured()) return;
  const id = spreadsheetId(env.SHEETS_SPREADSHEET_ID)!;
  const base = env.SHEETS_API_BASE || API;
  const meta = await googleApi(`${base}/${id}?fields=sheets(properties(sheetId,title),charts(chartId))`);
  const wanted = `Dashboard ${tab.title}`.slice(0, 100);
  let sheet = (meta.sheets || []).find((x: any) => x.properties?.title === wanted);
  if (!sheet) {
    const taken = new Set<string>((meta.sheets || []).map((x: any) => String(x.properties?.title || "").toLowerCase()));
    const title = safeTabTitle(wanted, taken);
    const added = await googleApi(`${base}/${id}:batchUpdate`, {
      body: { requests: [{ addSheet: { properties: { title, tabColor: NAVY, gridProperties: { hideGridlines: true } } } }] },
    });
    sheet = { properties: { sheetId: added.replies?.[0]?.addSheet?.properties?.sheetId }, charts: [] };
  }
  const sheetId = Number(sheet.properties.sheetId);
  const updated = new Date().toISOString().slice(0, 16).replace("T", " ");
  const built = buildBatchGrid(folderName, items, updated);
  const rows = built.grid.length + 5;
  const widths = [110, 320, 120, 90, 90, 380, 120, 110];
  const range = { sheetId, startRowIndex: built.statusHeader, endRowIndex: built.statusHeader + 5 };
  const requests: any[] = [
    ...(sheet.charts || []).map((c: any) => ({ deleteEmbeddedObject: { objectId: c.chartId } })),
    { updateSheetProperties: { properties: { sheetId, gridProperties: { hideGridlines: true, rowCount: Math.max(rows, 100), columnCount: 10 } }, fields: "gridProperties.hideGridlines,gridProperties.rowCount,gridProperties.columnCount" } },
    { repeatCell: { range: { sheetId }, cell: {}, fields: "userEnteredValue,userEnteredFormat" } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: built.grid.map((values) => ({ values })), fields: "userEnteredValue,userEnteredFormat" } },
    ...widths.map((pixelSize, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize }, fields: "pixelSize" } })),
    { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 44 }, fields: "pixelSize" } },
    {
      addChart: {
        chart: {
          spec: {
            title: "Files by status",
            pieChart: {
              legendPosition: "RIGHT_LEGEND",
              domain: { sourceRange: { sources: [{ ...range, startRowIndex: built.statusHeader + 1, startColumnIndex: 0, endColumnIndex: 1 }] } },
              series: { sourceRange: { sources: [{ ...range, startRowIndex: built.statusHeader + 1, startColumnIndex: 1, endColumnIndex: 2 }] } },
            },
          },
          position: { overlayPosition: { anchorCell: { sheetId, rowIndex: built.statusHeader, columnIndex: 3 }, widthPixels: 420, heightPixels: 220 } },
        },
      },
    },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: built.tableHeader, endRowIndex: built.tableHeader + items.length + 1, startColumnIndex: 0, endColumnIndex: 6 } } } },
  ];
  await googleApi(`${base}/${id}:batchUpdate`, { body: { requests } });
}
