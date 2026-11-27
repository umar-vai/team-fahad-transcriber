/**
 * LinkJob: one Durable Object per pasted link (YouTube for now).
 *
 * The browser only starts the job and then polls its progress, so the customer can open
 * other pages, switch tabs or even close the browser: the job keeps running on the server
 * and the finished transcript is saved to History.
 *
 * Each alarm transcribes a few 5 minute clips at the same time, stores them and sets the
 * next alarm. When every clip is back, the transcript is merged and saved to History.
 * The job's storage is deleted a day later (History keeps the transcript).
 */
import { DurableObject } from "cloudflare:workers";
import { LANGUAGES, TranscriptionQualityError, UserFacingError, shayariMeaning, transcribe, transcribeShayari, type Mode } from "../lib/gemini";
import { inferBanglaLanguage } from "../lib/transcription-quality";
import { mergePieces, type PieceResult } from "../lib/segments";
import { formatShayari, mergeShayari } from "../lib/shayari";

export interface LinkJobConfig {
  id: string;
  userId: string;
  url: string;
  title: string;
  duration: number | null;
  mode: Mode;
  language: string;
  vocab: string[];
  /** Clip ranges in seconds; an empty range means the whole video. */
  ranges: { start?: number; end?: number }[];
  createdAt: number;
}

interface LinkJobState {
  status: "running" | "done" | "failed";
  /** Clip index to how many temporary failures it had. */
  errors: Record<number, number>;
  languageDecided: boolean;
  lockedLanguage: string | null;
  error?: string;
  historyId?: string;
  finishedAt?: number;
  /** The first time Gemini kept refusing (quota, busy); the job gives up after QUOTA_WAIT_MS. */
  waitingSince?: number;
}

/** Clips transcribed at the same time. Server side, so several keys share the load. */
const PARALLEL = 6;
const MAX_CLIP_ERRORS = 5;
const QUOTA_WAIT_MS = 30 * 60_000;
const CLEANUP_AFTER_MS = 24 * 3600_000;
const AUTO_LANGUAGE = "Auto detect / mixed language";
const SHAYARI_LANGUAGE = "Urdu / Hindi shayari";
const TRANSIENT_RE = /rate limit|quota|busy|overload|unavailable|timed out|timeout|deadline|try again|temporar|\b(429|500|502|503|504|524)\b|fetch failed|network|connection|location is not supported/i;

const clipKey = (index: number) => `clip:${String(index).padStart(4, "0")}`;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export class LinkJob extends DurableObject<Env> {
  private config(): Promise<LinkJobConfig | undefined> {
    return this.ctx.storage.get<LinkJobConfig>("config");
  }

  private state(): Promise<LinkJobState | undefined> {
    return this.ctx.storage.get<LinkJobState>("state");
  }

  private async clips(): Promise<Map<number, PieceResult>> {
    const map = await this.ctx.storage.list<PieceResult & { index: number }>({ prefix: "clip:" });
    return new Map([...map.values()].map((clip) => [clip.index, clip]));
  }

  // ---------- RPC (called by /api/jobs) ----------

  async start(config: LinkJobConfig): Promise<void> {
    if (await this.config()) return;
    const decided = config.language !== AUTO_LANGUAGE || config.mode === "shayari" || config.ranges.length < 2;
    const state: LinkJobState = { status: "running", errors: {}, languageDecided: decided, lockedLanguage: null };
    await this.ctx.storage.put({ config, state });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async status(userId: string) {
    const config = await this.config();
    if (!config || config.userId !== userId) return null;
    const state = (await this.state())!;
    const done = (await this.ctx.storage.list({ prefix: "clip:" })).size;
    return {
      id: config.id,
      title: config.title,
      url: config.url,
      status: state.status,
      done,
      total: config.ranges.length,
      error: state.error || null,
      historyId: state.historyId || null,
      waiting: Boolean(state.waitingSince),
    };
  }

  // ---------- The work ----------

  async alarm(): Promise<void> {
    const config = await this.config();
    const state = await this.state();
    if (!config || !state) return;
    if (state.status !== "running") {
      // Finished a day ago: History has the transcript, so the job's own storage can go.
      if (state.finishedAt && Date.now() - state.finishedAt >= CLEANUP_AFTER_MS - 60_000) await this.ctx.storage.deleteAll();
      return;
    }
    try {
      await this.step(config, state);
    } catch (error) {
      console.error(`Link job ${config.id} step failed:`, error);
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    }
  }

  private settingsFor(config: LinkJobConfig, state: LinkJobState) {
    const language = state.lockedLanguage || config.language;
    return { codes: LANGUAGES[language] || [], language };
  }

  private async runClip(config: LinkJobConfig, state: LinkJobState, index: number): Promise<PieceResult> {
    const range = config.ranges[index];
    const input = { kind: "youtube" as const, url: config.url, startSeconds: range.start, endSeconds: range.end };
    const clipDuration = range.start !== undefined && range.end !== undefined ? range.end - range.start : undefined;
    const result =
      config.mode === "shayari"
        ? await transcribeShayari(input, config.vocab, "pron")
        : await transcribe(input, config.mode, this.settingsFor(config, state).codes, config.vocab, clipDuration);
    const offset = range.start ?? 0;
    return {
      offset,
      duration: (range.end ?? config.duration ?? 0) - offset,
      transcript: result.transcript,
      segments: result.segments,
      shayari: result.shayari,
    };
  }

  private async step(config: LinkJobConfig, state: LinkJobState): Promise<void> {
    const done = await this.clips();
    const pending = config.ranges.map((_, i) => i).filter((i) => !done.has(i));
    if (!pending.length) return this.finish(config, state, done);

    // Auto language: the first spoken clip decides the language for all others (as in the browser).
    const batch = state.languageDecided ? pending.slice(0, PARALLEL) : pending.slice(0, 1);
    const results = await Promise.allSettled(batch.map((index) => this.runClip(config, state, index)));

    let fatal: string | null = null;
    let anyTransient = false;
    const puts: Record<string, unknown> = {};
    results.forEach((outcome, n) => {
      const index = batch[n];
      if (outcome.status === "fulfilled") {
        puts[clipKey(index)] = { index, ...outcome.value };
        if (!state.languageDecided) {
          state.lockedLanguage = inferBanglaLanguage(outcome.value.transcript);
          // A silent opening clip says nothing about the language: let the next clip decide.
          if (state.lockedLanguage || outcome.value.transcript.trim() || done.size + 1 >= 2) state.languageDecided = true;
        }
        return;
      }
      const text = message(outcome.reason);
      const transient = TRANSIENT_RE.test(text) && !(outcome.reason instanceof TranscriptionQualityError);
      state.errors[index] = (state.errors[index] || 0) + 1;
      if (transient) anyTransient = true;
      else if (state.errors[index] >= (outcome.reason instanceof UserFacingError ? 2 : MAX_CLIP_ERRORS)) fatal = text;
    });

    if (anyTransient && !Object.keys(puts).length) state.waitingSince ||= Date.now();
    else if (Object.keys(puts).length) state.waitingSince = undefined;
    if (state.waitingSince && Date.now() - state.waitingSince > QUOTA_WAIT_MS) {
      fatal = "Gemini stayed busy or out of quota for too long. Please try this link again later.";
    }
    if (fatal) {
      state.status = "failed";
      state.error = fatal;
      state.finishedAt = Date.now();
      await this.ctx.storage.put({ ...puts, state });
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_AFTER_MS);
      return;
    }
    await this.ctx.storage.put({ ...puts, state });
    // Back off a little while Gemini is refusing; go straight on otherwise.
    await this.ctx.storage.setAlarm(Date.now() + (state.waitingSince ? 20_000 : 0));
  }

  private async finish(config: LinkJobConfig, state: LinkJobState, done: Map<number, PieceResult>): Promise<void> {
    const pieces = [...done.values()];
    const merged = mergePieces(pieces, config.mode === "detailed");
    let language = this.settingsFor(config, state).language;
    if (config.mode === "shayari") {
      language = SHAYARI_LANGUAGE;
      const sections = mergeShayari([...pieces].sort((a, b) => a.offset - b.offset).map((p) => p.shayari));
      if (sections.english || sections.bangla) {
        try {
          sections.meaning = await shayariMeaning(sections.english, sections.bangla);
        } catch (error) {
          console.warn(`Link job ${config.id}: Bangla meaning failed`, error);
        }
      }
      merged.transcript = formatShayari(sections);
      merged.segments = [];
    }
    state.finishedAt = Date.now();
    if (!merged.transcript.trim()) {
      state.status = "failed";
      state.error = "No speech was found in this video.";
    } else {
      state.historyId ||= crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO transcriptions (id, user_id, title, source_type, source_ref, mode, language, duration, transcript, segments_json, extras_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          state.historyId,
          config.userId,
          config.title.slice(0, 200),
          "youtube",
          config.url,
          config.mode,
          language,
          config.duration,
          merged.transcript,
          JSON.stringify(merged.segments.slice(0, 20000)),
          JSON.stringify({}),
          Date.now(),
        )
        .run();
      state.status = "done";
    }
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_AFTER_MS);
  }
}
