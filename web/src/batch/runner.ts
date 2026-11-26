/**
 * BatchRunner: one Durable Object per Google Drive folder batch.
 *
 * It works through the folder's audio files (MP3 and WAV) one after another on the
 * server, so the browser can be closed. Each alarm does one small step (read the file
 * header, transcribe up to 4 parts, save), stores its progress and sets the next alarm.
 *
 * No container is used: each part is a byte range read straight from Google Drive
 * (see lib/audiosplit.ts and lib/drivefetch.ts) and sent to Gemini.
 *
 * Usage of Cloudflare D1 is kept tiny on purpose: progress lives in this Durable
 * Object's own storage. D1 only gets one row per batch (written at start and end)
 * and one history row per finished video.
 */
import { DurableObject } from "cloudflare:workers";
import { LANGUAGES, TranscriptionQualityError, UserFacingError, transcribe, type Mode } from "../lib/gemini";
import { inferBanglaLanguage } from "../lib/transcription-quality";
import { clock, mergePieces, speakerTranscript, type PieceResult, type Segment } from "../lib/segments";
import { driveFileUrl } from "../lib/drive";
import { writeBatchDashboard } from "../lib/batchdash";
import { PROBE_BYTES, MP3_SLACK, UnsupportedAudioError, buildPart, planParts, probeAudio, type AudioInfo } from "../lib/audiosplit";
import { driveRange } from "../lib/drivefetch";
import { addNotionTranscript, archiveNotionPage, createNotionFolder, finishNotionFolder, notionConfigured, transcriptBlocks, type NotionFolder } from "../lib/notion";
import { accountSpreadsheetId, appendSheetRow, createSheetTab, replaceFailedRow, sheetHint, sheetRow, sheetsConfigured, type SheetTab } from "../lib/sheets";
import { driveAccessToken } from "../lib/autodrive";

export type BatchMode = "smart" | "detailed";

export const BATCH_MODES: Record<BatchMode, string> = {
  smart: "Smart clean",
  detailed: "Subtitles (timed)",
};

export interface BatchConfig {
  id: string;
  userId: string;
  folderId: string;
  folderName: string;
  folderUrl: string;
  mode: BatchMode;
  language: string;
  vocab: string[];
  appUrl: string;
  createdAt: number;
  total: number;
  /** Nightly auto jobs: the computer folder. Its Notion page and Sheets tab are reused every day. */
  computerId?: string;
  /** The files are private: download them with the connected Drive account's token. */
  authDrive?: boolean;
  /** Which connected Drive account owns the files (its token downloads them). */
  accountId?: string;
  /** The spreadsheet of that account (link or id); empty means the team spreadsheet. */
  spreadsheet?: string | null;
  /** Nightly auto jobs: false skips the Notion export (Sheets only). Manual folder batches always use Notion. */
  notion?: boolean;
}

type ItemStatus = "queued" | "preparing" | "ready" | "transcribing" | "saving" | "done" | "failed";

interface PartInfo {
  index: number;
  offset: number;
  duration: number;
  /** Byte range [start, end) of this part inside the Drive file. */
  start: number;
  end: number;
}

export interface BatchItem {
  index: number;
  fileId: string;
  name: string;
  title: string;
  /** YYYY-MM-DD the video belongs to (nightly auto jobs). */
  date?: string;
  status: ItemStatus;
  detail?: string;
  error?: string;
  /** The file itself is unusable (no audio, empty or corrupt), so retrying cannot help. */
  permanent?: boolean;
  /** How many times the whole file came back with no speech. A silent file is checked twice before it is given up. */
  silentTries?: number;
  /** Format details read from the file header (set when the file is ready). */
  audio?: AudioInfo;
  prepAttempts: number;
  partErrors: number;
  quotaWaitSince?: number;
  parts?: PartInfo[];
  partsDone: number;
  languageDecided?: boolean;
  lockedLanguage?: string | null;
  duration?: number | null;
  words?: number;
  historyId?: string;
  notionUrl?: string;
  notionPageId?: string;
  sheetDone?: boolean;
  /** Set when a video that was exported as "Failed" is retried. */
  replaceFailed?: { notionPageId?: string; sheetRow?: boolean };
  exportAttempts?: number;
  exportError?: string;
  finishedAt?: number;
}

interface BatchState {
  status: "running" | "done" | "cancelled";
  exportsReady: boolean;
  notion?: NotionFolder | null;
  notionError?: string;
  sheet?: SheetTab | null;
  sheetError?: string;
  finishedAt?: number;
  summaryWritten?: boolean;
  /** Automatic "try the failed files again" rounds done after everything else finished. */
  retryRounds?: number;
}

const PARALLEL_PARTS = 4;
const POLL_MS = 5000;
const MAX_PREP_ATTEMPTS = 8;
const MAX_PART_ERRORS = 6;
/** A file with no speech is transcribed this many times before it is given up. */
const SILENT_TRIES = 2;
/** After all files were tried, the files that could still succeed are tried again this many times. */
const MAX_RETRY_ROUNDS = 2;
/** How long a video keeps waiting on Gemini (quota, busy servers, timeouts) before it is marked failed. */
const QUOTA_WAIT_LIMIT_MS = 6 * 3600_000;
/** Temporary Gemini or network trouble (including Gemini sometimes refusing the server's egress location): the same audio part works again later, so it is never counted as a real failure. */
const TRANSIENT_RE = /rate limit|quota|busy|overload|unavailable|timed out|timeout|deadline|try again|temporar|\b(429|500|502|503|504|524)\b|fetch failed|network|connection|location is not supported/i;
const AUTO_LANGUAGE = "Auto detect / mixed language";

const itemKey = (index: number) => `item:${String(index).padStart(4, "0")}`;
const partKey = (index: number, part: number) => `part:${String(index).padStart(4, "0")}:${String(part).padStart(4, "0")}`;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) || []).length;
}

export class BatchRunner extends DurableObject<Env> {
  // ---------- Storage helpers ----------

  private config(): Promise<BatchConfig | undefined> {
    return this.ctx.storage.get<BatchConfig>("config");
  }

  private state(): Promise<BatchState | undefined> {
    return this.ctx.storage.get<BatchState>("state");
  }

  private async items(): Promise<BatchItem[]> {
    const map = await this.ctx.storage.list<BatchItem>({ prefix: "item:" });
    return [...map.values()].sort((a, b) => a.index - b.index);
  }

  private saveItem(item: BatchItem): Promise<void> {
    return this.ctx.storage.put(itemKey(item.index), item);
  }

  // ---------- Public RPC methods (called by the API routes) ----------

  async start(config: BatchConfig, files: { id: string; path: string; name: string; date?: string }[]): Promise<void> {
    if (await this.config()) return;
    const puts: Record<string, unknown> = { config, state: { status: "running", exportsReady: false } satisfies BatchState };
    files.forEach((file, i) => {
      const item: BatchItem = {
        index: i + 1,
        fileId: file.id,
        name: file.path,
        title: file.path.replace(/\.[^./\\]+$/, ""),
        date: file.date,
        status: "queued",
        prepAttempts: 0,
        partErrors: 0,
        partsDone: 0,
      };
      puts[itemKey(item.index)] = item;
    });
    // put() with an object accepts at most 128 keys per call.
    const entries = Object.entries(puts);
    for (let i = 0; i < entries.length; i += 128) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    await this.ctx.storage.setAlarm(Date.now());
  }

  async status(userId: string) {
    const config = await this.config();
    if (!config || config.userId !== userId) return null;
    const state = (await this.state())!;
    const items = await this.items();
    return {
      id: config.id,
      folderName: config.folderName,
      folderUrl: config.folderUrl,
      mode: config.mode,
      language: config.language,
      createdAt: config.createdAt,
      status: state.status,
      finishedAt: state.finishedAt,
      notion: { configured: notionConfigured(), url: state.notion?.pageUrl || null, error: state.notionError || null },
      sheet: { configured: sheetsConfigured(config.spreadsheet), url: state.sheet?.url || null, error: state.sheetError || null },
      items: items.map((item) => ({
        index: item.index,
        name: item.name,
        title: item.title,
        status: item.status,
        detail: item.detail || null,
        error: item.error || null,
        parts: item.parts?.length || 0,
        partsDone: item.partsDone,
        duration: item.duration ?? null,
        words: item.words ?? null,
        historyId: item.historyId || null,
        notionUrl: item.notionUrl || null,
        exportError: item.exportError || null,
      })),
    };
  }

  async cancel(userId: string): Promise<boolean> {
    const config = await this.config();
    const state = await this.state();
    if (!config || !state || config.userId !== userId) return false;
    if (state.status !== "running") return true;
    for (const item of await this.items()) {
      const inProgress = item.status !== "done" && item.status !== "failed" && item.status !== "queued";
      if (!inProgress) continue;
      {
        // Its finished parts are deleted below, so it starts again from the beginning.
        Object.assign(item, { status: "queued", detail: undefined, parts: undefined, audio: undefined, partsDone: 0, languageDecided: undefined, lockedLanguage: undefined });
      }
      await this.saveItem(item);
    }
    await this.ctx.storage.delete([...(await this.ctx.storage.list({ prefix: "part:" })).keys()]);
    state.status = "cancelled";
    state.finishedAt = Date.now();
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.deleteAlarm();
    await this.writeSummary(config, state, await this.items());
    return true;
  }

  /** True if some failed video could still succeed on a retry (bad files are not retried). */
  async hasRetryable(userId: string): Promise<boolean> {
    const config = await this.config();
    if (!config || config.userId !== userId) return false;
    return (await this.items()).some((i) => i.status === "failed" && !i.permanent);
  }

  /** True if finished videos never reached the Google Sheet (for example the sheet was not shared yet). */
  async hasSheetBacklog(userId: string): Promise<boolean> {
    const config = await this.config();
    const state = await this.state();
    if (!config || !state || config.userId !== userId || state.status === "running") return false;
    if (!sheetsConfigured(config.spreadsheet)) return false;
    return (await this.items()).some((i) => i.status === "done" && !i.sheetDone);
  }

  /** Retry failed videos, continue a cancelled batch, or redo missing Notion/Sheets exports. */
  async resume(userId: string): Promise<boolean> {
    const config = await this.config();
    const state = await this.state();
    if (!config || !state || config.userId !== userId) return false;
    for (const item of await this.items()) {
      if (item.status === "failed" && !item.permanent) {
        if (item.notionPageId || item.sheetDone) {
          item.replaceFailed = { notionPageId: item.notionPageId, sheetRow: item.sheetDone };
        }
        Object.assign(item, { notionUrl: undefined, notionPageId: undefined, sheetDone: undefined, exportAttempts: 0, exportError: undefined });
        Object.assign(item, { status: "queued", error: undefined, detail: undefined, prepAttempts: 0, partErrors: 0, partsDone: 0, parts: undefined, quotaWaitSince: undefined });
      }
      if (item.status === "done") {
        item.exportAttempts = 0;
        item.exportError = undefined;
      }
      // A step that was still running when the batch was stopped starts again from the beginning.
      if (state.status !== "running" && !["queued", "done", "failed"].includes(item.status)) {
        Object.assign(item, { status: "queued", detail: undefined, parts: undefined, audio: undefined, partsDone: 0, languageDecided: undefined, lockedLanguage: undefined });
      }
      await this.saveItem(item);
    }
    state.status = "running";
    state.retryRounds = 0;
    state.finishedAt = undefined;
    state.summaryWritten = false;
    if (!state.notion) state.notionError = undefined;
    if (!state.sheet) state.sheetError = undefined;
    state.exportsReady = false;
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now());
    await this.writeSummary(config, state, await this.items());
    return true;
  }

  // ---------- The work loop ----------

  async alarm(): Promise<void> {
    let delay = 30_000;
    try {
      const next = await this.tick();
      if (next === null) return;
      delay = next;
    } catch (error) {
      console.error("Batch step failed:", error);
    }
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /** Do one step. Returns the delay before the next step, or null when there is nothing left. */
  private async tick(): Promise<number | null> {
    const config = await this.config();
    const state = await this.state();
    if (!config || !state || state.status !== "running") return null;

    if (!state.exportsReady) {
      await this.setupExports(config, state);
      return 0;
    }

    const items = await this.items();
    const current = items.find((i) => i.status !== "done" && i.status !== "failed");
    if (!current) {
      // Exports that failed or were not set up earlier, one video per step.
      const pending = items.find((i) => this.needsExport(i, state));
      if (pending) {
        await this.exportItem(config, state, pending);
        return 0;
      }
      // Everything was tried once: give the failed files that could still work another go.
      const retry = items.filter((i) => i.status === "failed" && !i.permanent);
      if (retry.length && (state.retryRounds || 0) < MAX_RETRY_ROUNDS) {
        state.retryRounds = (state.retryRounds || 0) + 1;
        for (const item of retry) {
          Object.assign(item, { status: "queued", error: undefined, detail: undefined, prepAttempts: 0, partErrors: 0, partsDone: 0, parts: undefined, quotaWaitSince: undefined, finishedAt: undefined });
          await this.saveItem(item);
        }
        await this.ctx.storage.put("state", state);
        return 0;
      }
      await this.finish(config, state, items);
      return null;
    }

    const delay = await this.advance(config, current);

    return delay;
  }

  private async advance(config: BatchConfig, item: BatchItem): Promise<number> {
    if (item.status === "queued" || item.status === "preparing") {
      const delay = await this.prepare(item);
      return (item.status as ItemStatus) === "ready" ? 0 : delay;
    }
    if (item.status === "ready") {
      item.status = "transcribing";
      item.detail = undefined;
      await this.saveItem(item);
      return 0;
    }
    if (item.status === "transcribing") return this.transcribeParts(config, item);
    if (item.status === "saving") {
      await this.save(config, item);
      return 0;
    }
    return 0;
  }

  // ---------- Step 1: read the file header and plan the parts ----------

  private async prepare(item: BatchItem): Promise<number> {
    const config = (await this.config())!;
    let token: string | undefined;
    if (config.authDrive) {
      try {
        token = await driveAccessToken(config.accountId);
      } catch (error) {
        return this.prepFailed(item, message(error));
      }
    }
    try {
      const head = await driveRange(item.fileId, 0, PROBE_BYTES, token);
      if (!head.bytes.length) throw new UnsupportedAudioError("This file is empty.");
      const total = head.total ?? head.bytes.length;
      const audio = probeAudio(head.bytes, total);
      item.audio = audio;
      item.parts = planParts(audio).map((p) => ({ index: p.index, offset: p.offset, duration: p.duration, start: p.start, end: p.end }));
      item.duration = Math.round(audio.duration);
      item.partsDone = 0;
      item.status = "ready";
      item.detail = "Ready to transcribe";
      await this.saveItem(item);
      return 0;
    } catch (error) {
      if (error instanceof UnsupportedAudioError) {
        item.permanent = true;
        await this.fail(item, `${error.message} Only MP3, WAV and FLAC files are supported, so it was skipped.`);
        return 0;
      }
      return this.prepFailed(item, message(error));
    }
  }

  private async prepFailed(item: BatchItem, error: string): Promise<number> {
    item.prepAttempts++;
    if (item.prepAttempts >= MAX_PREP_ATTEMPTS) {
      await this.fail(item, error);
      return 0;
    }
    item.status = "queued";
    item.detail = `Retrying download (${error.slice(0, 120)})`;
    await this.saveItem(item);
    return Math.min(10_000 * 2 ** (item.prepAttempts - 1), 120_000);
  }

  // ---------- Step 2: transcribe the parts with Gemini ----------

  private async transcribeParts(config: BatchConfig, item: BatchItem): Promise<number> {
    const parts = item.parts || [];
    const stored = await this.ctx.storage.list<PieceResult>({ prefix: `part:${String(item.index).padStart(4, "0")}:` });
    const doneIndexes = new Set([...stored.keys()].map((k) => Number(k.split(":")[2])));
    const pending = parts.filter((p) => !doneIndexes.has(p.index));
    if (!pending.length) {
      item.status = "saving";
      item.detail = "Saving";
      await this.saveItem(item);
      return 0;
    }

    // With auto-detect, the first part decides the language for the rest (as on the website).
    const auto = config.language === AUTO_LANGUAGE && parts.length > 1 && !item.languageDecided;
    const batch = pending.slice(0, auto ? 1 : PARALLEL_PARTS);
    const language = item.lockedLanguage || config.language;
    const codes = LANGUAGES[language] || [];
    item.detail = `Transcribing part ${doneIndexes.size + 1} of ${parts.length}`;
    await this.saveItem(item);

    const outcomes = await Promise.allSettled(batch.map((part) => this.transcribePart(config, item, part, codes)));
    let quota = false;
    let waitReason = "";
    let quality: string | null = null;
    let other: string | null = null;
    for (const [i, outcome] of outcomes.entries()) {
      const part = batch[i];
      if (outcome.status === "fulfilled") {
        await this.ctx.storage.put(partKey(item.index, part.index), outcome.value);
        doneIndexes.add(part.index);
        if (auto && !item.languageDecided) {
          const found = inferBanglaLanguage(outcome.value.transcript);
          if (found) item.lockedLanguage = found;
          if (found || outcome.value.transcript.trim() || doneIndexes.size >= 2) item.languageDecided = true;
        }
        continue;
      }
      const reason = outcome.reason;
      const text = message(reason);
      if (reason instanceof TranscriptionQualityError) quality = text;
      else if (TRANSIENT_RE.test(text) || !(reason instanceof UserFacingError)) {
        quota = true;
        waitReason ||= text;
      }
      else other = text;
    }
    item.partsDone = doneIndexes.size;

    if (quota) {
      item.quotaWaitSince ||= Date.now();
      if (Date.now() - item.quotaWaitSince > QUOTA_WAIT_LIMIT_MS) {
        await this.fail(item, "Gemini stayed busy or out of quota for hours. It is retried automatically; add another API key to speed it up.");
        return 0;
      }
      // The real reason goes to the Worker logs, so a long wait can always be explained.
      console.warn(JSON.stringify({ batchWait: item.name, batch: config.id, reason: waitReason.slice(0, 300) }));
      item.detail = /google drive|drive api|returned no data/i.test(waitReason)
        ? "Google Drive did not send the file, trying again in a moment"
        : "Gemini is busy, switching to another API key in a moment";
      await this.saveItem(item);
      return 20_000;
    }
    item.quotaWaitSince = undefined;
    if (quality || other) {
      item.partErrors++;
      if (item.partErrors >= (quality ? 2 : MAX_PART_ERRORS)) {
        await this.fail(item, quality || other || "Transcription failed.");
        return 0;
      }
      item.detail = `Retrying a part (${(quality || other || "").slice(0, 120)})`;
      await this.saveItem(item);
      return 10_000;
    }
    await this.saveItem(item);
    return 0;
  }

  private async transcribePart(config: BatchConfig, item: BatchItem, part: PartInfo, codes: string[]): Promise<PieceResult> {
    const audio = item.audio!;
    const isLast = part.end >= audio.dataEnd;
    const token = config.authDrive ? await driveAccessToken(config.accountId) : undefined;
    // MP3 pieces are read a little past their end so the cut can move to the next frame.
    const wanted = audio.kind === "mp3" && !isLast ? part.end + MP3_SLACK : part.end;
    const fetched = await driveRange(item.fileId, part.start, Math.min(wanted, audio.dataEnd), token);
    if (!fetched.bytes.length) throw new Error("Google Drive returned no data for this part.");
    const piece = buildPart(audio, { index: part.index, offset: part.offset, duration: part.duration, start: part.start, end: part.end }, fetched.bytes, isLast);
    const data = piece.data.buffer.slice(piece.data.byteOffset, piece.data.byteOffset + piece.data.byteLength) as ArrayBuffer;
    const result = await transcribe({ kind: "inline", mimeType: piece.mimeType, data }, config.mode as Mode, codes, config.vocab, part.duration);
    return { offset: part.offset, duration: part.duration, transcript: result.transcript, segments: result.segments };
  }

  // ---------- Step 3: save to history, Notion and Sheets ----------

  private async save(config: BatchConfig, item: BatchItem): Promise<void> {
    const stored = await this.ctx.storage.list<PieceResult>({ prefix: `part:${String(item.index).padStart(4, "0")}:` });
    const merged = mergePieces([...stored.values()], config.mode === "detailed");
    if (!merged.transcript.trim()) {
      await this.ctx.storage.delete([...stored.keys()]);
      item.silentTries = (item.silentTries || 0) + 1;
      if (item.silentTries >= SILENT_TRIES) {
        item.permanent = true;
        await this.fail(item, `No speech was found in this file (checked ${item.silentTries} times).`);
      } else {
        // Not final yet: it is checked once more after the other files are done.
        await this.fail(item, `No speech was found (check ${item.silentTries} of ${SILENT_TRIES}), it will be checked again.`);
      }
      return;
    }
    item.historyId ||= crypto.randomUUID();
    // INSERT OR IGNORE: a repeated step after a restart never creates a second row.
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO transcriptions (id, user_id, title, source_type, source_ref, mode, language, duration, transcript, segments_json, extras_json, created_at, batch_id)
       VALUES (?, ?, ?, 'drive', ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    )
      .bind(
        item.historyId,
        config.userId,
        item.title.slice(0, 200),
        driveFileUrl(item.fileId),
        config.mode,
        item.lockedLanguage || config.language,
        item.duration ?? null,
        merged.transcript,
        JSON.stringify(merged.segments),
        Date.now(),
        config.id,
      )
      .run();
    item.words = wordCount(merged.transcript);
    item.status = "done";
    item.detail = undefined;
    item.finishedAt = Date.now();
    await this.saveItem(item);
    await this.ctx.storage.delete([...stored.keys()]);

    const state = (await this.state())!;
    await this.exportItem(config, state, item, { transcript: merged.transcript, segments: merged.segments });
  }

  private async fail(item: BatchItem, error: string): Promise<void> {
    item.status = "failed";
    item.error = error.slice(0, 500);
    item.detail = undefined;
    item.finishedAt = Date.now();
    await this.saveItem(item);
  }

  private async setupExports(config: BatchConfig, state: BatchState): Promise<void> {
    const modeLabel = BATCH_MODES[config.mode];
    // Nightly jobs reuse the computer's own Notion page and Sheets tab; a new computer gets new ones once.
    const computer = config.computerId
      ? await this.env.DB.prepare("SELECT notion_json, sheet_json FROM drive_computers WHERE folder_id = ?")
          .bind(config.computerId)
          .first<{ notion_json: string | null; sheet_json: string | null }>()
      : null;
    const useNotion = config.notion !== false;
    if (!state.notion && useNotion && computer?.notion_json) state.notion = JSON.parse(computer.notion_json);
    if (!state.sheet && computer?.sheet_json) {
      // A tab saved for another spreadsheet (the account's link changed since) is not reused.
      const saved: SheetTab = JSON.parse(computer.sheet_json);
      if (saved.spreadsheetId === accountSpreadsheetId(config.spreadsheet)) state.sheet = saved;
    }
    if (!state.notion && useNotion && notionConfigured()) {
      try {
        state.notion = await createNotionFolder({
          folderName: config.folderName,
          folderUrl: config.folderUrl,
          fileCount: config.total,
          modeLabel,
          appUrl: `${config.appUrl}/batches/${config.id}`,
          ongoing: Boolean(config.computerId),
        });
        state.notionError = undefined;
        if (config.computerId) {
          await this.env.DB.prepare("UPDATE drive_computers SET notion_json = ? WHERE folder_id = ?").bind(JSON.stringify(state.notion), config.computerId).run();
        }
      } catch (error) {
        state.notionError = message(error);
      }
    }
    if (!state.sheet && sheetsConfigured(config.spreadsheet)) {
      try {
        state.sheet = await createSheetTab(config.folderName, Boolean(config.computerId), config.spreadsheet);
        state.sheetError = undefined;
        if (config.computerId) {
          await this.env.DB.prepare("UPDATE drive_computers SET sheet_json = ? WHERE folder_id = ?").bind(JSON.stringify(state.sheet), config.computerId).run();
        }
      } catch (error) {
        state.sheetError = sheetHint(message(error), config.spreadsheet);
      }
    }
    state.exportsReady = true;
    await this.ctx.storage.put("state", state);
  }

  private needsExport(item: BatchItem, state: BatchState): boolean {
    if (item.status !== "done" || (item.exportAttempts || 0) >= 3) return false;
    return Boolean((state.notion && !item.notionUrl) || (state.sheet && !item.sheetDone));
  }

  private async exportItem(
    config: BatchConfig,
    state: BatchState,
    item: BatchItem,
    content?: { transcript: string; segments: Segment[] },
  ): Promise<void> {
    if (!this.needsExport(item, state)) return;
    item.exportAttempts = (item.exportAttempts || 0) + 1;
    if (!content) {
      const row = await this.env.DB.prepare("SELECT transcript, segments_json FROM transcriptions WHERE id = ?")
        .bind(item.historyId || "")
        .first<{ transcript: string; segments_json: string | null }>();
      if (!row) {
        item.exportError = "The saved transcript was deleted from history.";
        item.exportAttempts = 3;
        await this.saveItem(item);
        return;
      }
      content = { transcript: row.transcript, segments: JSON.parse(row.segments_json || "[]") };
    }
    const timed = config.mode === "detailed";
    const errors: string[] = [];
    if (state.notion && !item.notionUrl) {
      try {
        const page = await addNotionTranscript(state.notion, {
          index: item.index,
          title: item.title,
          duration: item.duration ?? null,
          styleLabel: BATCH_MODES[config.mode],
          status: "Done",
          driveUrl: driveFileUrl(item.fileId),
          words: item.words || 0,
          blocks: transcriptBlocks(content.transcript, content.segments, timed),
          date: item.date,
        });
        item.notionUrl = page.url;
        item.notionPageId = page.id;
        const old = item.replaceFailed?.notionPageId;
        if (old) {
          await archiveNotionPage(old).catch((error) => console.warn("Could not remove the old Failed page:", error));
          item.replaceFailed = { ...item.replaceFailed, notionPageId: undefined };
        }
      } catch (error) {
        errors.push(message(error));
      }
    }
    if (state.sheet && !item.sheetDone) {
      try {
        const row = sheetRow({
          index: item.index,
          title: item.title,
          duration: item.duration ? clock(item.duration) : "",
          style: BATCH_MODES[config.mode],
          status: "Done",
          words: item.words || 0,
          driveUrl: driveFileUrl(item.fileId),
          notionUrl: item.notionUrl || "",
          transcript: timed && content.segments.length ? speakerTranscript(content.segments) : content.transcript,
          date: item.date,
        });
        const replaced = item.replaceFailed?.sheetRow ? await replaceFailedRow(state.sheet, item.index, row, item.date).catch(() => false) : false;
        if (!replaced) await appendSheetRow(state.sheet, row);
        item.sheetDone = true;
        item.replaceFailed = undefined;
      } catch (error) {
        errors.push(`Sheets: ${message(error)}`);
      }
    }
    item.exportError = errors.length ? errors.join(" | ") : undefined;
    await this.saveItem(item);
  }

  private async finish(config: BatchConfig, state: BatchState, items: BatchItem[]): Promise<void> {
    const done = items.filter((i) => i.status === "done").length;
    const failed = items.filter((i) => i.status === "failed");
    // Failed videos are listed once at the end, so the table shows every file of the folder.
    if (!state.summaryWritten) {
      for (const item of failed) {
        // Already listed (or listed as Failed before a retry that failed again).
        if (item.notionUrl || item.sheetDone || item.replaceFailed) continue;
        try {
          if (state.notion) {
            const page = await addNotionTranscript(state.notion, {
              index: item.index, title: item.title, duration: item.duration ?? null, styleLabel: BATCH_MODES[config.mode],
              status: "Failed", driveUrl: driveFileUrl(item.fileId), words: 0,
              blocks: transcriptBlocks(`Could not transcribe: ${item.error || "unknown error"}`, [], false),
              date: item.date,
            });
            item.notionUrl = page.url;
            item.notionPageId = page.id;
          }
        } catch (error) {
          console.warn("Notion failed-row export:", error);
        }
        try {
          if (state.sheet) {
            await appendSheetRow(state.sheet, sheetRow({
              index: item.index, title: item.title, duration: item.duration ? clock(item.duration) : "", style: BATCH_MODES[config.mode],
              status: "Failed", words: 0, driveUrl: driveFileUrl(item.fileId), notionUrl: item.notionUrl || "", transcript: item.error || "",
              date: item.date,
            }));
            item.sheetDone = true;
          }
        } catch (error) {
          console.warn("Sheets failed-row export:", error);
        }
        await this.saveItem(item);
      }
      if (state.notion && !config.computerId) {
        const summary = `Finished ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${done} of ${items.length} videos transcribed` +
          (failed.length ? `, ${failed.length} failed.` : ".");
        await finishNotionFolder(state.notion, summary).catch((error) => console.warn("Notion summary:", error));
      }
      state.summaryWritten = true;
    }
    if (state.sheet && !config.computerId) {
      await writeBatchDashboard(state.sheet, config.folderName, items).catch((error) => console.warn("Batch dashboard:", error));
    }
    state.status = "done";
    state.finishedAt = Date.now();
    await this.ctx.storage.put("state", state);
    await this.writeSummary(config, state, items);
  }

  /** The only D1 update for a batch: its status, counts and links (used by the Folders list page). */
  private async writeSummary(config: BatchConfig, state: BatchState, items: BatchItem[]): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE batches SET status = ?, done_count = ?, failed_count = ?, notion_url = ?, sheet_url = ?, finished_at = ? WHERE id = ?`,
    )
      .bind(
        state.status,
        items.filter((i) => i.status === "done").length,
        items.filter((i) => i.status === "failed").length,
        state.notion?.pageUrl || null,
        state.sheet?.url || null,
        state.finishedAt || null,
        config.id,
      )
      .run()
      .catch((error) => console.error("Batch summary write failed:", error));
  }
}
