/** Transcribes one file: decode, cut into pieces, send each piece, then hand the finished transcript to the website. */
import fs from "node:fs";
import { ApiError } from "./api.js";
import { NoAudioError, decodeToRaw, encodePiece, planPieces } from "./audio.js";
import { fingerprint } from "./watcher.js";
import { log } from "./log.js";

const PARALLEL = 3;
const AUTO_LANGUAGE = "Auto detect / mixed language";
const TRANSIENT_RE = /rate limit|quota|busy|overload|unavailable|timed out|timeout|deadline|try again|temporar|location is not supported/i;
/** How long one piece keeps waiting on a busy Gemini or a missing connection before the file is tried again later. */
const PIECE_PATIENCE_MS = 6 * 3600_000;

export class PermanentError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Processor {
  constructor(api, { sleepFn = sleep } = {}) {
    this.api = api;
    this.sleep = sleepFn;
  }

  /** Send one piece, retrying temporary trouble (no internet, busy Gemini) for hours, real problems a few times. */
  async sendPiece(raw, piece, query, onWait) {
    const started = Date.now();
    let quality = 0;
    let other = 0;
    for (let attempt = 0; ; attempt++) {
      const { data, mimeType } = await encodePiece(raw, piece);
      try {
        const result = await this.api.piece(data, mimeType, { duration: piece.duration.toFixed(1), ...query });
        return { offset: piece.offset, duration: piece.duration, transcript: result.transcript || "", segments: result.segments || [], detectedLanguage: result.detectedLanguage || null };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.status === 401) throw error;
        if (error.status === 422) {
          if (++quality >= 2) throw new PermanentError(error.message);
        } else if (error.retryable || TRANSIENT_RE.test(error.message)) {
          if (Date.now() - started > PIECE_PATIENCE_MS) throw error;
        } else if (++other >= 6) {
          throw new PermanentError(error.message);
        }
        onWait?.(error.message);
        await this.sleep(Math.min(10_000 * 2 ** Math.min(attempt, 4), 120_000));
      }
    }
  }

  /**
   * Returns "done" or "skipped" (the website already had it). Throws ApiError for trouble that should be
   * retried later, PermanentError / NoAudioError for files that cannot work.
   */
  async process(file, { settings, setDetail }) {
    const print = fingerprint(file.path, file.size);
    const info = await this.api.heartbeat({ check: [print], checkName: file.name, current: file.name });
    // Already done on the website (same content, or same file name from this PC or its Drive backup): not again.
    if (info.known?.includes(print) || info.knownName) return { status: "skipped", fingerprint: print };

    setDetail("Reading the audio");
    const { raw, samples } = await decodeToRaw(file.path);
    try {
      const pieces = planPieces(raw, samples);
      const language = info.settings?.language || settings?.language || AUTO_LANGUAGE;
      const results = new Array(pieces.length);
      let locked = null;
      let finished = 0;
      const query = () => (locked ? { language: locked } : {});
      const work = async (piece) => {
        const result = await this.sendPiece(raw, piece, query(), (why) => setDetail(`Waiting: ${why.slice(0, 80)}`));
        results[piece.index] = result;
        finished++;
        setDetail(`Part ${finished} of ${pieces.length}`);
        return result;
      };
      let next = 0;
      if (language === AUTO_LANGUAGE && pieces.length > 1) {
        // The first piece decides the language for the rest, as on the website.
        const first = await work(pieces[0]);
        locked = first.detectedLanguage;
        next = 1;
      }
      const runners = Array.from({ length: PARALLEL }, async () => {
        while (next < pieces.length) await work(pieces[next++]);
      });
      await Promise.all(runners);

      setDetail("Saving to the sheet");
      const duration = samples / 16000;
      await this.api.complete({
        fingerprint: print,
        name: file.name,
        mtimeMs: file.mtimeMs,
        duration,
        language: locked || undefined,
        pieces: results.map(({ offset, duration: d, transcript, segments }) => ({ offset, duration: d, transcript, segments })),
      });
      return { status: "done", fingerprint: print };
    } finally {
      fs.rmSync(raw, { force: true });
    }
  }

  /** Tell the website a file could not be transcribed, so it shows up as Failed instead of silently missing. */
  async reportFailed(file, error, fingerprintValue) {
    const print = fingerprintValue || fingerprint(file.path, file.size);
    await this.api.complete({ failed: true, fingerprint: print, name: file.name, mtimeMs: file.mtimeMs, error: String(error).slice(0, 300) });
    return print;
  }
}

export { NoAudioError };
export const logFailure = (file, error) => log(`FAILED ${file.name}: ${error}`);
