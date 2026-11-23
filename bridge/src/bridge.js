/** The main loop: keep the website informed and work through new files one at a time. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError } from "./api.js";
import { NoAudioError } from "./audio.js";
import { PermanentError, Processor } from "./processor.js";
import { Watcher } from "./watcher.js";
import { log } from "./log.js";

const SCAN_MS = 5000;
const HEARTBEAT_MS = 60_000;
/** Heartbeats go out every minute, so a contact older than this means something is wrong. */
const CONNECTED_WITHIN_MS = 150_000;
const MAX_ATTEMPTS = 8;

export class Bridge {
  constructor(store, api, { processor = new Processor(api), watcher = new Watcher(store) } = {}) {
    this.store = store;
    this.api = api;
    this.processor = processor;
    this.watcher = watcher;
    this.status = { phase: "idle", current: null, detail: "", queue: 0, lastError: null, lastDone: [], online: true, needsPairing: false };
    this.attempts = new Map();
    this.nextTry = new Map();
    this.lastBeat = 0;
    this.settings = null;
    this.stopped = false;
    this.wake = null;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.wake?.();
  }

  /**
   * One word for the status window: unpaired, removed (the website forgot this PC), connected,
   * offline (the website cannot be reached) or checking (just started).
   */
  connectionState(now = Date.now()) {
    if (!this.store.paired) return { state: "unpaired", lastContactAt: 0 };
    if (this.status.needsPairing) return { state: "removed", lastContactAt: this.api.lastOkAt };
    const { lastOkAt, lastFailAt } = this.api;
    if (lastFailAt > lastOkAt) return { state: "offline", lastContactAt: lastOkAt };
    if (lastOkAt && now - lastOkAt < CONNECTED_WITHIN_MS) return { state: "connected", lastContactAt: lastOkAt };
    return { state: lastOkAt ? "offline" : "checking", lastContactAt: lastOkAt };
  }

  /** Wait, but wake up early when asked (for example after pairing or choosing a folder). */
  pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  nudge() {
    this.wake?.();
  }

  async beat(force = false) {
    if (!this.store.paired) return;
    if (!force && Date.now() - this.lastBeat < HEARTBEAT_MS) return;
    this.lastBeat = Date.now();
    try {
      const info = await this.api.heartbeat({ folder: this.store.config.folder, queue: this.status.queue, current: this.status.current, error: this.status.lastError });
      this.settings = info.settings;
      this.status.online = true;
      this.status.needsPairing = false;
    } catch (error) {
      this.noteApiError(error);
    }
  }

  noteApiError(error) {
    if (error instanceof ApiError) {
      this.status.online = error.status !== 0;
      if (error.status === 401) {
        this.status.needsPairing = true;
        this.status.lastError = error.message;
      } else if (error.status === 0) this.status.lastError = error.message;
      else this.status.lastError = error.message;
    } else this.status.lastError = String(error?.message || error);
  }

  async runOnce() {
    await this.beat();
    if (!this.store.paired || !this.store.config.folder || this.status.needsPairing) {
      this.status.phase = this.status.needsPairing || !this.store.paired ? "needs-setup" : "needs-folder";
      return false;
    }
    if (!fs.existsSync(this.store.config.folder)) {
      this.status.phase = "folder-missing";
      this.status.lastError = "The watched folder was not found. Is the drive connected?";
      return false;
    }
    const { ready, waiting } = this.watcher.ready();
    const now = Date.now();
    const due = ready.filter((f) => (this.nextTry.get(f.path) || 0) <= now);
    this.status.queue = ready.length + waiting;
    if (!due.length) {
      this.status.phase = ready.length ? "retry-later" : "idle";
      this.status.current = null;
      return false;
    }
    await this.handle(due[0]);
    return true;
  }

  async handle(file) {
    this.status.phase = "working";
    this.status.current = file.name;
    this.status.detail = "Starting";
    this.status.lastError = null;
    const setDetail = (text) => (this.status.detail = text);
    try {
      const outcome = await this.processor.process(file, { settings: this.settings, setDetail });
      this.record(file, "done", outcome.fingerprint);
      this.status.lastDone.unshift({ name: file.name, at: Date.now(), skipped: outcome.status === "skipped" });
      this.status.lastDone.length = Math.min(this.status.lastDone.length, 12);
      log(`${outcome.status === "skipped" ? "Already on the website" : "Done"}: ${file.name}`);
      this.attempts.delete(file.path);
    } catch (error) {
      await this.failure(file, error);
    } finally {
      this.status.current = null;
      this.status.detail = "";
      this.lastBeat = 0;
      await this.beat(true);
    }
  }

  async failure(file, error) {
    const permanent = error instanceof PermanentError || error instanceof NoAudioError;
    const tries = (this.attempts.get(file.path) || 0) + 1;
    this.attempts.set(file.path, tries);
    if (error instanceof ApiError && error.status === 401) {
      this.noteApiError(error);
      this.nextTry.set(file.path, Date.now() + 60_000);
      return;
    }
    if (error instanceof ApiError) {
      this.noteApiError(error);
      log(`Will try again later: ${file.name} (${error.message})`);
      // Internet down or a busy server: wait, then try again, forever. Nothing is lost.
      if (error.retryable || tries < MAX_ATTEMPTS) {
        this.nextTry.set(file.path, Date.now() + Math.min(30_000 * 2 ** Math.min(tries, 5), 900_000));
        return;
      }
    }
    if (!permanent && tries < MAX_ATTEMPTS) {
      log(`Problem with ${file.name}: ${error.message}. Trying again later.`);
      this.status.lastError = `${file.name}: ${error.message}`;
      this.nextTry.set(file.path, Date.now() + Math.min(60_000 * tries, 900_000));
      return;
    }
    // Give up on this file and list it as Failed on the website.
    const reason = error?.message || String(error);
    log(`FAILED ${file.name}: ${reason}`);
    this.status.lastError = `${file.name}: ${reason}`;
    try {
      const print = await this.processor.reportFailed(file, reason);
      this.record(file, "failed", print, reason);
    } catch (reportError) {
      this.noteApiError(reportError);
      this.nextTry.set(file.path, Date.now() + 120_000);
    }
  }

  record(file, state, fingerprintValue, error) {
    this.store.ledger[file.path] = { size: file.size, mtimeMs: file.mtimeMs, fingerprint: fingerprintValue, state, error, at: Date.now() };
    this.store.saveLedger();
  }

  /** Put failed files back in the queue (the "Try failed files again" button). */
  retryFailed() {
    let count = 0;
    for (const [file, entry] of Object.entries(this.store.ledger)) {
      if (entry.state === "failed") {
        entry.state = "retry";
        this.attempts.delete(file);
        this.nextTry.delete(file);
        count++;
      }
    }
    this.store.saveLedger();
    this.nudge();
    return count;
  }

  async loop() {
    cleanTemp();
    // The heartbeat must not wait for a long file: it runs on its own timer (beat() limits it to once a minute).
    this.timer = setInterval(() => this.beat().catch(() => {}), 20_000);
    this.timer.unref?.();
    while (!this.stopped) {
      let busy = false;
      try {
        busy = await this.runOnce();
      } catch (error) {
        this.status.lastError = String(error?.message || error);
        log(`Unexpected problem: ${error?.stack || error}`);
      }
      if (!busy) await this.pause(SCAN_MS);
    }
  }
}

/** Raw audio from a crashed run is left in the temp folder: remove old ones at start. */
function cleanTemp() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^bridge-\d+-.*\.raw$/.test(name)) continue;
      const full = path.join(os.tmpdir(), name);
      if (Date.now() - fs.statSync(full).mtimeMs > 3600_000) fs.rmSync(full, { force: true });
    }
  } catch {}
}
