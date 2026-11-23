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
/** Output styles a person who signed in with Google can pick for their own PC. */
export const PERSONAL_MODES: Record<string, string> = { smart: "Smart clean transcript", detailed: "Subtitles + speakers (timed)", verbatim: "Exact verbatim transcript" };
export const LOGIN_MINUTES = 10;
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
  linked_computer_id?: string | null;
  /** team = a named PC of the team; personal = one person who signed in with Google. */
  kind: "team" | "personal";
  mode: string | null;
  language: string | null;
  sheet_enabled: number;
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

/** The style and language this PC uses: the shared team setting, or the person's own choice on a personal PC. */
export async function settingsFor(device: BridgeDevice): Promise<{ mode: string; language: string }> {
  const shared = await bridgeSettings();
  if (device.kind !== "personal") return shared;
  return {
    mode: device.mode && PERSONAL_MODES[device.mode] ? device.mode : "smart",
    language: device.language && LANGUAGES[device.language] ? device.language : shared.language,
  };
}

/** What the app shows in its settings: choices only exist for what this kind of PC may change. */
export async function deviceView(device: BridgeDevice) {
  const account = device.kind === "personal" ? await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(device.user_id).first<{ email: string }>() : null;
  return {
    kind: device.kind,
    account: account?.email || null,
    sheetEnabled: device.kind === "team" && Boolean(device.sheet_enabled),
    settings: await settingsFor(device),
    choices: device.kind === "personal" ? { modes: PERSONAL_MODES, languages: Object.keys(LANGUAGES) } : null,
  };
}

/** The app changes its own settings: the sheet switch (team PC) or style and language (personal PC). */
export async function saveDevicePrefs(device: BridgeDevice, patch: { sheet?: unknown; mode?: unknown; language?: unknown }): Promise<void> {
  if (patch.sheet !== undefined && device.kind === "team") {
    await env.DB.prepare("UPDATE bridge_devices SET sheet_enabled = ? WHERE id = ?").bind(patch.sheet ? 1 : 0, device.id).run();
  }
  if (device.kind === "personal") {
    if (patch.mode !== undefined) {
      if (!PERSONAL_MODES[String(patch.mode)]) throw new HttpError(400, "Choose one of the output styles in the list.");
      await env.DB.prepare("UPDATE bridge_devices SET mode = ? WHERE id = ?").bind(String(patch.mode), device.id).run();
    }
    if (patch.language !== undefined) {
      if (!LANGUAGES[String(patch.language)]) throw new HttpError(400, "Unknown language.");
      await env.DB.prepare("UPDATE bridge_devices SET language = ? WHERE id = ?").bind(String(patch.language), device.id).run();
    }
  }
}

/** The app is reset: a personal PC removes itself (a team PC stays on the website so it can be linked again). */
export async function leaveDevice(device: BridgeDevice): Promise<void> {
  if (device.kind === "personal") await env.DB.prepare("DELETE FROM bridge_devices WHERE id = ?").bind(device.id).run();
}

// ---------- Sign in with Google from the app ----------

const loginCode = () => pairingCode();

/** The app asks to be approved. It keeps the secret requestId; the person sees only the short code. */
export async function startLogin(rawName: string): Promise<{ requestId: string; userCode: string; expiresAt: number }> {
  const name = String(rawName || "").trim().slice(0, 60) || "My PC";
  const now = Date.now();
  await env.DB.prepare("DELETE FROM bridge_login WHERE expires_at < ?").bind(now).run();
  const requestId = randomToken(24);
  const userCode = loginCode();
  const expiresAt = now + LOGIN_MINUTES * 60_000;
  await env.DB.prepare("INSERT INTO bridge_login (id_hash, user_code, name, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(requestId), userCode, name, expiresAt).run();
  return { requestId, userCode, expiresAt };
}

export async function loginRequestInfo(rawCode: string): Promise<{ name: string; expiresAt: number } | null> {
  const row = await env.DB.prepare("SELECT name, expires_at FROM bridge_login WHERE user_code = ? AND expires_at >= ?").bind(normalizeCode(rawCode), Date.now()).first<{ name: string; expires_at: number }>();
  return row ? { name: row.name, expiresAt: row.expires_at } : null;
}

/** A signed-in person allows the computer that shows this code. */
export async function approveLogin(userId: string, rawCode: string): Promise<{ name: string }> {
  const code = normalizeCode(rawCode);
  const row = await env.DB.prepare("UPDATE bridge_login SET user_id = ? WHERE user_code = ? AND expires_at >= ? AND user_id IS NULL RETURNING name").bind(userId, code, Date.now()).first<{ name: string }>();
  if (!row) throw new HttpError(400, "This code is wrong, was already used or has expired. Press the Google button in the app again.");
  return { name: row.name };
}

/** The app asks whether it was approved. On approval it receives its token once. */
export async function pollLogin(requestId: string): Promise<{ pending: true } | { token: string; deviceId: string; name: string; account: string | null }> {
  const hash = await sha256(String(requestId || ""));
  const row = await env.DB.prepare("SELECT name, expires_at, user_id FROM bridge_login WHERE id_hash = ?").bind(hash).first<{ name: string; expires_at: number; user_id: string | null }>();
  if (!row || row.expires_at < Date.now()) throw new HttpError(410, "The approval time ran out. Press the Google button again.");
  if (!row.user_id) return { pending: true };
  // Deleting first makes the token single use even if two polls race.
  const claimed = await env.DB.prepare("DELETE FROM bridge_login WHERE id_hash = ? RETURNING user_id").bind(hash).first<{ user_id: string }>();
  if (!claimed) throw new HttpError(410, "This request was already used. Press the Google button again.");
  const token = randomToken(32);
  const deviceId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO bridge_devices (id, user_id, name, token_hash, created_at, last_seen_at, kind, sheet_enabled) VALUES (?, ?, ?, ?, ?, ?, 'personal', 0)")
    .bind(deviceId, claimed.user_id, row.name, await sha256(token), now, now)
    .run();
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(claimed.user_id).first<{ email: string }>();
  return { token, deviceId, name: row.name, account: user?.email || null };
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

// ---------- Linking a PC to an existing computer ----------

export const MIN_PIN_LENGTH = 4;
const MAX_PIN_FAILS = 8;
const PIN_LOCK_MINUTES = 10;

/** A signed-in person sets (or changes) the team PIN a fresh PC must type before it sees the list. */
export async function setLinkPin(userId: string, pin: string): Promise<void> {
  const clean = String(pin || "").trim();
  if (clean.length < MIN_PIN_LENGTH || clean.length > 40) throw new HttpError(400, `The PIN needs at least ${MIN_PIN_LENGTH} characters.`);
  const salt = randomToken(8);
  await env.DB.prepare("UPDATE bridge_settings SET link_pin_hash = ?, link_user_id = ?, link_fail_count = 0, link_locked_until = 0 WHERE id = 1")
    .bind(`${salt}:${await sha256(`${salt}:${clean}`)}`, userId)
    .run();
}

export async function linkPinIsSet(): Promise<boolean> {
  const row = await env.DB.prepare("SELECT link_pin_hash FROM bridge_settings WHERE id = 1").first<{ link_pin_hash: string | null }>();
  return Boolean(row?.link_pin_hash);
}

/** Checks the PIN. Too many wrong tries lock the list for a few minutes. Returns the user the new PC belongs to. */
async function checkLinkPin(rawPin: string): Promise<string> {
  const row = await env.DB.prepare("SELECT link_pin_hash, link_user_id, link_fail_count, link_locked_until FROM bridge_settings WHERE id = 1").first<any>();
  if (!row?.link_pin_hash || !row.link_user_id) throw new HttpError(403, "No team PIN is set yet. Open the Auto page on the website and set one first.");
  const now = Date.now();
  if (row.link_locked_until > now) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((row.link_locked_until - now) / 60_000)} minutes.`);
  const [salt] = String(row.link_pin_hash).split(":");
  const expected = String(row.link_pin_hash).slice(salt.length + 1);
  const given = await sha256(`${salt}:${String(rawPin || "").trim()}`);
  let diff = given.length ^ expected.length;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  if (diff !== 0) {
    const fails = Number(row.link_fail_count) + 1;
    const locked = fails >= MAX_PIN_FAILS;
    await env.DB.prepare("UPDATE bridge_settings SET link_fail_count = ?, link_locked_until = ? WHERE id = 1").bind(locked ? 0 : fails, locked ? now + PIN_LOCK_MINUTES * 60_000 : 0).run();
    throw new HttpError(403, locked ? `Too many wrong PINs. Try again in ${PIN_LOCK_MINUTES} minutes.` : "The PIN is wrong.");
  }
  if (row.link_fail_count) await env.DB.prepare("UPDATE bridge_settings SET link_fail_count = 0 WHERE id = 1").run();
  return row.link_user_id;
}

export interface LinkChoice {
  key: string;
  name: string;
}

/** Every computer a new PC can take over: earlier bridge PCs and Drive computers that no bridge PC has taken yet. */
export async function linkChoices(pin: string): Promise<LinkChoice[]> {
  await checkLinkPin(pin);
  const devices = await env.DB.prepare("SELECT id, name FROM bridge_devices WHERE kind = 'team'").all<{ id: string; name: string }>();
  const computers = await env.DB.prepare("SELECT folder_id, name FROM drive_computers WHERE folder_id NOT IN (SELECT linked_computer_id FROM bridge_devices WHERE linked_computer_id IS NOT NULL)").all<{ folder_id: string; name: string }>();
  const taken = new Set(devices.results.map((d) => d.name.toLowerCase()));
  return [
    ...devices.results.map((d) => ({ key: `device:${d.id}`, name: d.name })),
    ...computers.results.filter((c) => !taken.has(c.name.toLowerCase())).map((c) => ({ key: `computer:${c.folder_id}`, name: c.name })),
  ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * The new PC takes the place of the chosen computer: same name, same sheet tab, same History owner. A new token
 * replaces the old one, so a computer that was linked before stops working at once (only one PC per name).
 */
export async function linkDevice(pin: string, key: string): Promise<{ token: string; deviceId: string; name: string }> {
  const userId = await checkLinkPin(pin);
  const [kind, id] = String(key || "").split(/:(.+)/);
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  if (kind === "device" && id) {
    const device = await env.DB.prepare("SELECT id, name FROM bridge_devices WHERE id = ?").bind(id).first<{ id: string; name: string }>();
    if (!device) throw new HttpError(404, "This computer was removed from the website. Pick another one.");
    await env.DB.prepare("UPDATE bridge_devices SET token_hash = ?, last_seen_at = ?, queue_size = 0, current_file = NULL, last_error = NULL WHERE id = ?").bind(tokenHash, now, device.id).run();
    return { token, deviceId: device.id, name: device.name };
  }
  if (kind === "computer" && id) {
    const computer = await env.DB.prepare("SELECT folder_id, name, sheet_json FROM drive_computers WHERE folder_id = ?").bind(id).first<{ folder_id: string; name: string; sheet_json: string | null }>();
    if (!computer) throw new HttpError(404, "This computer is not on the website any more. Pick another one.");
    const deviceId = crypto.randomUUID();
    try {
      await env.DB.prepare("INSERT INTO bridge_devices (id, user_id, name, token_hash, sheet_json, created_at, last_seen_at, linked_computer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(deviceId, userId, computer.name, tokenHash, computer.sheet_json, now, now, computer.folder_id)
        .run();
    } catch {
      // Another PC took this computer a moment ago: the list now shows it as a normal PC.
      throw new HttpError(409, "Another PC just linked to this computer. Press Refresh and pick it again.");
    }
    return { token, deviceId, name: computer.name };
  }
  throw new HttpError(400, "Pick a computer from the list.");
}

// ---------- Device requests ----------

export async function authDevice(request: Request): Promise<BridgeDevice> {
  const header = request.headers.get("authorization") || "";
  const token = header.match(/^Bearer\s+([a-f0-9]{64})$/i)?.[1];
  if (!token) throw new HttpError(401, "This PC is not connected. Pair it again with a new code.");
  const device = await env.DB.prepare("SELECT * FROM bridge_devices WHERE token_hash = ?").bind(await sha256(token.toLowerCase())).first<BridgeDevice>();
  if (!device) throw new HttpError(401, "This PC was removed, or another computer took its place. Link it again.");
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
  // Personal PCs never use the team sheet, and a team PC can switch it off in the app.
  const tab = device.kind === "personal" || !device.sheet_enabled ? null : await deviceSheet(device);
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
  const settings = await settingsFor(device);
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
    style: (MODE_LABELS[settings.mode] || PERSONAL_MODES[settings.mode] || settings.mode),
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
  const settings = await settingsFor(device);
  const file = await claimRow(device, info, "failed", { error });
  if (file.sheet_done) return { ok: true };
  await writeSheetRow(device, info, file, {
    index: file.row_no,
    title: info.name,
    duration: duration ? clock(duration) : "",
    style: (MODE_LABELS[settings.mode] || PERSONAL_MODES[settings.mode] || settings.mode),
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
