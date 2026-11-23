/**
 * Finds files in the watched folder that are new, finished copying and not handled yet.
 * A plain scan every few seconds is used instead of file system events: events are unreliable on network
 * drives and when a program replaces a file, and a scan of one folder costs almost nothing.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MEDIA = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wma", ".amr", ".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".3gp"]);
/** A file must be unchanged for this long before it counts as finished copying. */
export const STABLE_MS = 8000;
const MAX_DEPTH = 8;

export const isMedia = (file) => MEDIA.has(path.extname(file).toLowerCase());

export class Watcher {
  constructor(store, { stableMs = STABLE_MS } = {}) {
    this.store = store;
    this.stableMs = stableMs;
    /** path -> {size, mtimeMs, since} while a file is still being copied */
    this.seen = new Map();
  }

  list(folder) {
    const found = [];
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH && !entry.name.startsWith(".") && entry.name !== "$RECYCLE.BIN") walk(full, depth + 1);
        } else if (entry.isFile() && isMedia(entry.name)) found.push(full);
      }
    };
    walk(folder, 0);
    return found;
  }

  /** Files ready to transcribe, oldest first. */
  ready(now = Date.now()) {
    const { folder, watchSince } = this.store.config;
    if (!folder) return { ready: [], waiting: 0 };
    const ready = [];
    let waiting = 0;
    const present = new Set();
    for (const file of this.list(folder)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      present.add(file);
      const known = this.store.ledger[file];
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.state !== "retry") continue;
      // New means it arrived in the folder after the bridge was set up (copying keeps the old modified time, but not the
      // creation time). The creation time only: on Windows the "changed" time moves whenever a backup or sync program
      // touches an old file, which made old recordings look new.
      const arrived = stat.birthtimeMs || stat.ctimeMs || 0;
      if (watchSince && arrived < watchSince) continue;
      const before = this.seen.get(file);
      if (!before || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) {
        this.seen.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, since: now });
        waiting++;
        continue;
      }
      if (now - before.since < this.stableMs || stat.size === 0) {
        waiting++;
        continue;
      }
      // Still locked by the program that writes it?
      try {
        fs.closeSync(fs.openSync(file, "r"));
      } catch {
        waiting++;
        continue;
      }
      ready.push({ path: file, name: path.basename(file), size: stat.size, mtimeMs: stat.mtimeMs });
    }
    for (const file of this.seen.keys()) if (!present.has(file)) this.seen.delete(file);
    ready.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    return { ready, waiting };
  }
}

/** Same content gives the same fingerprint (size plus the first and last megabyte), so a renamed or re-copied file is not done twice. */
export function fingerprint(file, size) {
  const hash = crypto.createHash("sha256");
  hash.update(String(size));
  const fd = fs.openSync(file, "r");
  try {
    const chunk = 1024 * 1024;
    const head = Buffer.alloc(Math.min(chunk, size));
    fs.readSync(fd, head, 0, head.length, 0);
    hash.update(head);
    if (size > chunk) {
      const tail = Buffer.alloc(Math.min(chunk, size - chunk));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex").slice(0, 32);
}
