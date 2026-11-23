/**
 * Bridge PCs: a small Windows app on each PC watches one folder. Every new audio file is cut into pieces of
 * about 5 minutes on the PC and sent here piece by piece. The Gemini key never leaves the server and the
 * audio is not stored. When all pieces are back, the PC sends them to /api/bridge/complete, which saves the
 * transcript to History and adds a row (with the date) to that PC's tab in Google Sheets.
 */
import { env } from "cloudflare:workers";
import { LANGUAGES } from "./gemini";
import { HttpError } from "./http";
import { appendSheetRow, createSheetTab, replaceFailedRow, sheetRow, sheetsConfigured, type SheetTab } from "./sheets";
import { clock, mergePieces, speakerTranscript, type PieceResult } from "./segments";
import { dayFromName, dayOf } from "./autodrive";
import type { BatchMode } from "../batch/runner";

export const PAIRING_MINUTES = 15;
const MODE_LABELS: Record<string, string> = { smart: "Smart clean", detailed: "Subtitles (timed)" };
const MAX_PIECES = 400;
const MAX_TRANSCRIPT_CHARS = 2_000_000;

export interface BridgeDevice {
  id: string;
  user_id: string;
  name: string;
  sheet_json: string | null;
  created_at: number;
  last_seen_at: number | null;
  version: string | null;
  watch_folder: string | null;
  queue_size: number;
  current_file: string | null;
  last_error: string | null;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A pairing code that is easy to type: 8 characters without look-alikes (no 0 O 1 I). */
function pairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const data = crypto.getRandomValues(new Uint8Array(8));
  return [...data].map((b) => alphabet[b % alphabet.length]).join("");
}

export const normalizeCode = (code: string) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------- Settings ----------

export async function bridgeSettings(): Promise<{ mode: BatchMode; language: string }> {
  const row = await env.DB.prepare("SELECT mode, language FROM bridge_settings WHERE id = 1").first<{ mode: BatchMode; language: string }>();
  return row || { mode: "smart", language: "Bangla (Bangladesh)" };
}

export async function saveBridgeSettings(patch: { mode?: string; language?: string }): Promise<void> {
  if (patch.mode !== undefined) {
    if (!(patch.mode in MODE_LABELS)) throw new HttpError(400, "Choose Smart clean or Subtitles (timed).");
    await env.DB.prepare("UPDATE bridge_settings SET mode = ? WHERE id = 1").bind(patch.mode).run();
  }
  if (patch.language !== undefined) {
    if (!LANGUAGES[patch.language]) throw new HttpError(400, "Unknown language.");
    await env.DB.prepare("UPDATE bridge_settings SET language = ? WHERE id = 1").bind(patch.language).run();
  }
}

// ---------- Pairing ----------

/** A signed-in person asks for a code for a new PC. */
export async function createPairingCode(userId: string, name: string): Promise<{ code: string; expiresAt: number }> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new HttpError(400, "Give the PC a name, for example PC-03.");
  const now = Date.now();
  await env.DB.prepare("DELETE FROM bridge_pairing WHERE expires_at < ?").bind(now).run();
  const code = pairingCode();
  const expiresAt = now + PAIRING_MINUTES * 60_000;
  await env.DB.prepare("INSERT INTO bridge_pairing (code_hash, user_id, name, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(code), userId, clean, expiresAt).run();
  return { code, expiresAt };
}

/** The bridge app swaps the code for a device token (shown once, stored only as a hash). */
export async function redeemPairingCode(rawCode: string): Promise<{ token: string; deviceId: string; name: string }> {
  const code = normalizeCode(rawCode);
  if (code.length !== 8) throw new HttpError(400, "The code has 8 letters and numbers.");
  const hash = await sha256(code);
  // Deleting first makes the code single use even if two requests race.
  const claimed = await env.DB.prepare("DELETE FROM bridge_pairing WHERE code_hash = ? AND expires_at >= ? RETURNING user_id, name").bind(hash, Date.now()).first<{ user_id: string; name: string }>();
  if (!claimed) throw new HttpError(400, "This code is wrong or has expired. Make a new one on the Auto page.");
  const token = randomToken(32);
  const deviceId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO bridge_devices (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(deviceId, claimed.user_id, claimed.name, await sha256(token), Date.now(), Date.now())
    .run();
  return { token, deviceId, name: claimed.name };
}

// ---------- Device requests ----------

export async function authDevice(request: Request): Promise<BridgeDevice> {
  const header = request.headers.get("authorization") || "";
  const token = header.match(/^Bearer\s+([a-f0-9]{64})$/i)?.[1];
  if (!token) throw new HttpError(401, "This PC is not connected. Pair it again with a new code.");
  const device = await env.DB.prepare("SELECT * FROM bridge_devices WHERE token_hash = ?").bind(await sha256(token.toLowerCase())).first<BridgeDevice>();
  if (!device) throw new HttpError(401, "This PC was removed. Pair it again with a new code.");
  return device;
}

export async function recordHeartbeat(device: BridgeDevice, info: { version?: string; folder?: string; queue?: number; current?: string | null; error?: string | null }): Promise<void> {
  await env.DB.prepare("UPDATE bridge_devices SET last_seen_at = ?, version = ?, watch_folder = ?, queue_size = ?, current_file = ?, last_error = ? WHERE id = ?")
    .bind(
      Date.now(),
      String(info.version || "").slice(0, 30) || null,
      String(info.folder || "").slice(0, 300) || null,
      Math.max(0, Math.floor(Number(info.queue) || 0)),
      info.current ? String(info.current).slice(0, 300) : null,
      info.error ? String(info.error).slice(0, 400) : null,
      device.id,
    )
    .run();
}

// ---------- Saving a finished file ----------

export interface FileInfo {
  fingerprint: string;
  name: string;
  mtimeMs: number;
}

export function readFileInfo(body: any): FileInfo {
  const fingerprint = String(body?.fingerprint || "");
  if (!/^[a-f0-9]{16,64}$/.test(fingerprint)) throw new HttpError(400, "Missing file fingerprint.");
  const name = String(body?.name || "").trim().slice(0, 300);
  if (!name) throw new HttpError(400, "Missing file name.");
  const mtimeMs = Number(body?.mtimeMs) || Date.now();
  return { fingerprint, name, mtimeMs };
}

/** The recording date: from the file name if it has one, otherwise the day the file was last changed (Bangladesh time). */
export function fileDay(info: FileInfo): string {
  return dayFromName(info.name) || dayOf(info.mtimeMs);
}

async function deviceSheet(device: BridgeDevice): Promise<SheetTab | null> {
  if (!sheetsConfigured()) return null;
  if (device.sheet_json) return JSON.parse(device.sheet_json);
  // Another request may have created the tab a moment ago.
  const fresh = await env.DB.prepare("SELECT sheet_json FROM bridge_devices WHERE id = ?").bind(device.id).first<{ sheet_json: string | null }>();
  if (fresh?.sheet_json) return JSON.parse(fresh.sheet_json);
  const tab = await createSheetTab(device.name, true);
  await env.DB.prepare("UPDATE bridge_devices SET sheet_json = ? WHERE id = ?").bind(JSON.stringify(tab), device.id).run();
  device.sheet_json = JSON.stringify(tab);
  return tab;
}

interface FileRow {
  row_no: number;
  status: string;
  sheet_done: number;
  history_id: string | null;
}

/** The file's row number, created once so every repeat (after a network error) lands on the same row. */
async function claimRow(device: BridgeDevice, info: FileInfo, status: "done" | "failed", extra: { historyId?: string; words?: number; error?: string }): Promise<FileRow & { replacedFailed: boolean }> {
  const existing = await env.DB.prepare("SELECT row_no, status, sheet_done, history_id FROM bridge_files WHERE device_id = ? AND fingerprint = ?").bind(device.id, info.fingerprint).first<FileRow>();
  if (existing) {
    // A failed file that later works: keep its row number and replace the Failed row.
    if (existing.status === "failed" && status === "done") {
      await env.DB.prepare("UPDATE bridge_files SET status = 'done', history_id = ?, words = ?, error = NULL, sheet_done = 0 WHERE device_id = ? AND fingerprint = ?")
        .bind(extra.historyId || null, extra.words || 0, device.id, info.fingerprint)
        .run();
      return { ...existing, status: "done", sheet_done: 0, history_id: extra.historyId || null, replacedFailed: true };
    }
    return { ...existing, replacedFailed: false };
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO bridge_files (device_id, fingerprint, name, file_day, status, row_no, history_id, words, error, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(row_no), 0) + 1 FROM bridge_files WHERE device_id = ?1), ?6, ?7, ?8, ?9)`,
  )
    .bind(device.id, info.fingerprint, info.name, fileDay(info), status, extra.historyId || null, extra.words || 0, extra.error || null, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT row_no, status, sheet_done, history_id FROM bridge_files WHERE device_id = ? AND fingerprint = ?").bind(device.id, info.fingerprint).first<FileRow>();
  return { ...row!, replacedFailed: false };
}

async function writeSheetRow(device: BridgeDevice, info: FileInfo, file: FileRow & { replacedFailed: boolean }, row: Parameters<typeof sheetRow>[0]): Promise<void> {
  const tab = await deviceSheet(device);
  if (tab) {
    const cells = sheetRow(row);
    const replaced = file.replacedFailed ? await replaceFailedRow(tab, file.row_no, cells, row.date).catch(() => false) : false;
    if (!replaced) await appendSheetRow(tab, cells);
  }
  await env.DB.prepare("UPDATE bridge_files SET sheet_done = 1 WHERE device_id = ? AND fingerprint = ?").bind(device.id, info.fingerprint).run();
}

export interface CompleteBody {
  pieces: PieceResult[];
  duration?: number;
  language?: string;
}

/** All pieces are transcribed: merge, save to History and add the Sheets row. Safe to repeat. */
export async function completeFile(device: BridgeDevice, rawBody: any): Promise<{ ok: true; duplicate?: boolean; words?: number; failed?: boolean }> {
  const info = readFileInfo(rawBody);
  const pieces: PieceResult[] = (Array.isArray(rawBody?.pieces) ? rawBody.pieces : []).slice(0, MAX_PIECES).map((p: any) => ({
    offset: Number(p?.offset) || 0,
    duration: Number(p?.duration) || 0,
    transcript: String(p?.transcript || ""),
    segments: Array.isArray(p?.segments) ? p.segments : [],
  }));
  if (!pieces.length) throw new HttpError(400, "No transcript pieces were sent.");
  const settings = await bridgeSettings();
  const detailed = settings.mode === "detailed";
  const merged = mergePieces(pieces, detailed);
  const day = fileDay(info);
  const duration = Number(rawBody?.duration) > 0 ? Number(rawBody.duration) : pieces.reduce((end, p) => Math.max(end, p.offset + p.duration), 0);

  if (!merged.transcript.trim()) {
    await failFile(device, { ...info, error: "No speech was found in this recording.", permanent: true }, duration);
    return { ok: true, failed: true };
  }
  if (merged.transcript.length > MAX_TRANSCRIPT_CHARS) throw new HttpError(413, "This transcript is too large.");

  const historyId = `bridge-${device.id}-${info.fingerprint}`;
  const words = (merged.transcript.match(/\S+/g) || []).length;
  const file = await claimRow(device, info, "done", { historyId, words });
  if (file.status === "done" && file.sheet_done) return { ok: true, duplicate: true, words };

  const language = LANGUAGES[String(rawBody?.language || "")] ? String(rawBody.language) : settings.language;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO transcriptions (id, user_id, title, source_type, source_ref, mode, language, duration, transcript, segments_json, extras_json, created_at)
     VALUES (?, ?, ?, 'bridge', ?, ?, ?, ?, ?, ?, '{}', ?)`,
  )
    .bind(historyId, device.user_id, info.name.slice(0, 200), `${device.name}: ${info.name}`.slice(0, 300), settings.mode, language, duration || null, merged.transcript, JSON.stringify(merged.segments), Date.now())
    .run();

  await writeSheetRow(device, info, file, {
    index: file.row_no,
    title: info.name,
    duration: duration ? clock(duration) : "",
    style: MODE_LABELS[settings.mode],
    status: "Done",
    words,
    driveUrl: device.name,
    notionUrl: "",
    transcript: detailed && merged.segments.length ? speakerTranscript(merged.segments) : merged.transcript,
    date: day,
  });
  return { ok: true, words };
}

/** A file that cannot be transcribed (no audio, corrupt): list it as Failed so nothing silently goes missing. */
export async function failFile(device: BridgeDevice, rawBody: any, duration = 0): Promise<{ ok: true }> {
  const info = readFileInfo(rawBody);
  const error = String(rawBody?.error || "Could not transcribe this file.").slice(0, 400);
  const settings = await bridgeSettings();
  const file = await claimRow(device, info, "failed", { error });
  if (file.sheet_done) return { ok: true };
  await writeSheetRow(device, info, file, {
    index: file.row_no,
    title: info.name,
    duration: duration ? clock(duration) : "",
    style: MODE_LABELS[settings.mode],
    status: "Failed",
    words: 0,
    driveUrl: device.name,
    notionUrl: "",
    transcript: error,
    date: fileDay(info),
  });
  return { ok: true };
}

/** Which of these fingerprints does the server already have? The PC skips them (safe to re-scan after a reinstall). */
export async function knownFingerprints(device: BridgeDevice, list: unknown): Promise<string[]> {
  const prints = (Array.isArray(list) ? list : []).map(String).filter((f) => /^[a-f0-9]{16,64}$/.test(f)).slice(0, 200);
  if (!prints.length) return [];
  const rows = await env.DB.prepare(`SELECT fingerprint FROM bridge_files WHERE device_id = ? AND status = 'done' AND sheet_done = 1 AND fingerprint IN (${prints.map(() => "?").join(",")})`)
    .bind(device.id, ...prints)
    .all<{ fingerprint: string }>();
  return rows.results.map((r) => r.fingerprint);
}
