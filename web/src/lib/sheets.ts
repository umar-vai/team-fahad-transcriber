/**
 * Google Sheets export: one team spreadsheet, one tab per Drive folder batch, one row per video.
 *
 * Secrets: GOOGLE_SERVICE_ACCOUNT_JSON (see google.ts) and SHEETS_SPREADSHEET_ID (sheet link or id).
 * Share the spreadsheet with the service account's email as Editor.
 */
import { env } from "cloudflare:workers";
import { googleApi, serviceAccount } from "./google";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
/** Google Sheets allows 50,000 characters per cell; longer transcripts continue in the next cells. */
const CELL_LIMIT = 45_000;

export const SHEET_HEADER = ["No.", "Title", "Duration", "Style", "Status", "Words", "Drive file", "Notion page", "Transcript"];
/** Per-computer tabs have a Date column in front. */
export const SHEET_HEADER_DATED = ["Date", ...SHEET_HEADER];

export interface SheetTab {
  spreadsheetId: string;
  sheetId: number;
  title: string;
  url: string;
  /** Number of extra columns in front of "No." (1 when the tab has a Date column). */
  lead?: number;
}

export function spreadsheetId(raw: string | undefined): string | null {
  const value = String(raw || "").trim();
  const match = value.match(/\/spreadsheets\/d\/([\w-]{20,})/);
  if (match) return match[1];
  return /^[\w-]{20,}$/.test(value) ? value : null;
}

/** The spreadsheet an account writes to: its own, or the team spreadsheet. */
export function accountSpreadsheetId(own?: string | null): string | null {
  return spreadsheetId(own || undefined) || spreadsheetId(env.SHEETS_SPREADSHEET_ID);
}

export function sheetsConfigured(own?: string | null): boolean {
  return Boolean(serviceAccount() && accountSpreadsheetId(own));
}

/** Tab names cannot contain : \ / ? * [ ] and are limited to 100 characters. */
export function safeTabTitle(name: string, taken: Set<string>): string {
  const base = name.replace(/[:\\/?*\[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Folder";
  let title = base;
  for (let n = 2; taken.has(title.toLowerCase()); n++) title = `${base} (${n})`;
  return title;
}

export async function createSheetTab(folderName: string, dated = false, own?: string | null): Promise<SheetTab> {
  const id = accountSpreadsheetId(own)!;
  const base = env.SHEETS_API_BASE || API;
  const meta = await googleApi(`${base}/${id}?fields=sheets.properties(sheetId,title)`);
  const taken = new Set<string>((meta.sheets || []).map((s: any) => String(s.properties?.title || "").toLowerCase()));
  const title = safeTabTitle(folderName, taken);
  const added = await googleApi(`${base}/${id}:batchUpdate`, {
    body: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] },
  });
  const sheetId = Number(added.replies?.[0]?.addSheet?.properties?.sheetId);
  const header = dated ? SHEET_HEADER_DATED : SHEET_HEADER;
  const widths = dated ? [95, 50, 280, 80, 130, 80, 70, 220, 220, 600] : [50, 280, 80, 130, 80, 70, 220, 220, 600];
  await googleApi(`${base}/${id}:batchUpdate`, {
    body: {
      requests: [
        {
          updateCells: {
            start: { sheetId, rowIndex: 0, columnIndex: 0 },
            fields: "userEnteredValue,userEnteredFormat",
            rows: [{
              values: header.map((text) => ({
                userEnteredValue: { stringValue: text },
                userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.93, blue: 0.98 } },
              })),
            }],
          },
        },
        ...widths.map((pixelSize, index) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
            properties: { pixelSize },
            fields: "pixelSize",
          },
        })),
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 30 },
            cell: { userEnteredFormat: { verticalAlignment: "TOP", wrapStrategy: "CLIP" } },
            fields: "userEnteredFormat(verticalAlignment,wrapStrategy)",
          },
        },
      ],
    },
  });
  return { spreadsheetId: id, sheetId, title, url: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${sheetId}`, lead: dated ? 1 : 0 };
}

export function sheetRow(item: {
  index: number;
  title: string;
  duration: string;
  style: string;
  status: string;
  words: number;
  driveUrl: string;
  notionUrl: string;
  transcript: string;
  /** YYYY-MM-DD; adds the leading Date column of per-computer tabs. */
  date?: string;
}): (string | number)[] {
  const row: (string | number)[] = [...(item.date ? [item.date] : []), item.index, item.title, item.duration, item.style, item.status, item.words, item.driveUrl, item.notionUrl];
  const text = item.transcript || "";
  if (!text) row.push("");
  for (let i = 0; i < text.length; i += CELL_LIMIT) row.push(text.slice(i, i + CELL_LIMIT));
  return row;
}

function cells(row: (string | number)[]) {
  return row.map((value) => ({ userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: value } }));
}

/**
 * Overwrite the "Failed" row of a video that has now been transcribed.
 * Returns false when that row is not found (then the caller appends).
 */
export async function replaceFailedRow(tab: SheetTab, index: number, row: (string | number)[], date?: string): Promise<boolean> {
  const base = env.SHEETS_API_BASE || API;
  const meta = await googleApi(`${base}/${tab.spreadsheetId}?fields=sheets.properties(sheetId,title)`);
  const title = (meta.sheets || []).find((s: any) => Number(s.properties?.sheetId) === tab.sheetId)?.properties?.title;
  if (!title) return false;
  const lead = tab.lead || 0;
  const range = encodeURIComponent(`'${String(title).replace(/'/g, "''")}'!A1:F`);
  const values = (await googleApi(`${base}/${tab.spreadsheetId}/values/${range}`)).values || [];
  const rowIndex = values.findIndex((r: any[]) => String(r?.[lead]) === String(index) && r?.[lead + 4] === "Failed" && (!lead || !date || r?.[0] === date));
  if (rowIndex < 1) return false;
  await googleApi(`${base}/${tab.spreadsheetId}:batchUpdate`, {
    body: { requests: [{ updateCells: { start: { sheetId: tab.sheetId, rowIndex, columnIndex: 0 }, rows: [{ values: cells(row) }], fields: "userEnteredValue" } }] },
  });
  return true;
}

/** Append by sheet id (not tab name), so it still works if someone renames the tab. */
export async function appendSheetRow(tab: SheetTab, row: (string | number)[]): Promise<void> {
  const base = env.SHEETS_API_BASE || API;
  const values = cells(row);
  await googleApi(`${base}/${tab.spreadsheetId}:batchUpdate`, {
    body: { requests: [{ appendCells: { sheetId: tab.sheetId, rows: [{ values }], fields: "userEnteredValue" } }] },
  });
}
