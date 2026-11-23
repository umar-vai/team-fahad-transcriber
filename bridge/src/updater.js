/**
 * Updates from inside the app. The build publishes latest.json (version, size, SHA-256) next to the installer
 * in the "bridge-latest" release. The status window shows "new version available"; one click downloads the
 * installer, checks it against latest.json and runs it silently. The installer stops the old bridge, replaces
 * the files and starts the new one. Settings and the list of finished files are kept.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { dataDir } from "./paths.js";
import { log } from "./log.js";

export const UPDATE_BASE = process.env.BRIDGE_UPDATE_BASE || "https://github.com/umar-vai/team-fahad-transcriber/releases/download/bridge-latest";
const CHECK_EVERY_MS = 6 * 3600_000;
const INSTALLER = "TeamFahadBridge-Setup.exe";

/** True when version a is newer than b ("1.10.0" > "1.9.0"). */
export function isNewer(a, b) {
  const parts = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

export class Updater {
  constructor(version, { base = UPDATE_BASE, dir = path.join(dataDir(), "update"), launch = defaultLaunch } = {}) {
    this.version = version;
    this.base = base.replace(/\/$/, "");
    this.dir = dir;
    this.launch = launch;
    /** state: idle | checking | current | available | downloading | installing | error */
    this.state = { state: "idle", latest: null, progress: 0, error: null, checkedAt: 0 };
    this.timer = null;
  }

  set(patch) {
    Object.assign(this.state, patch);
  }

  start() {
    setTimeout(() => this.check().catch(() => {}), 20_000).unref?.();
    this.timer = setInterval(() => this.check().catch(() => {}), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  /** Looks for a newer version. Never throws: a failure only means "could not check now". */
  async check() {
    if (["downloading", "installing"].includes(this.state.state)) return this.state;
    this.set({ state: "checking", error: null });
    try {
      const response = await fetch(`${this.base}/latest.json`, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": `TeamFahadBridge/${this.version}` } });
      if (!response.ok) throw new Error(`The update information is not available (${response.status}).`);
      const info = await response.json();
      if (!/^\d+(\.\d+){1,3}$/.test(String(info.version)) || !/^[a-f0-9]{64}$/.test(String(info.sha256)) || !(Number(info.size) > 1_000_000)) throw new Error("The update information is not valid.");
      this.info = { version: String(info.version), sha256: String(info.sha256), size: Number(info.size) };
      this.set({ state: isNewer(info.version, this.version) ? "available" : "current", latest: this.info.version, checkedAt: Date.now() });
    } catch (error) {
      this.set({ state: "error", error: `Could not check for updates (${error.cause?.code || error.message}).`, checkedAt: Date.now() });
    }
    return this.state;
  }

  /** Downloads the installer, verifies it, and runs it. The current bridge is replaced by the installer. */
  async install() {
    if (this.state.state !== "available" || !this.info) throw new Error("There is no new version to install.");
    const { version, sha256, size } = this.info;
    this.set({ state: "downloading", progress: 0, error: null });
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const old of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, old), { force: true });
      const file = path.join(this.dir, `TeamFahadBridge-Setup-${version}.exe`);
      const response = await fetch(`${this.base}/${INSTALLER}`, { signal: AbortSignal.timeout(15 * 60_000), headers: { "user-agent": `TeamFahadBridge/${this.version}` } });
      if (!response.ok || !response.body) throw new Error(`The download failed (${response.status}).`);
      const hash = crypto.createHash("sha256");
      let received = 0;
      const out = fs.createWriteStream(file);
      await new Promise((resolve, reject) => {
        const stream = Readable.fromWeb(response.body);
        stream.on("data", (chunk) => {
          hash.update(chunk);
          received += chunk.length;
          this.state.progress = Math.min(99, Math.round((received / size) * 100));
        });
        stream.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        stream.pipe(out);
      });
      if (received !== size || hash.digest("hex") !== sha256) {
        fs.rmSync(file, { force: true });
        throw new Error("The downloaded file is damaged. Try again.");
      }
      this.set({ state: "installing", progress: 100 });
      log(`Installing version ${version}.`);
      this.launch(file);
    } catch (error) {
      this.set({ state: "error", error: error.message || "The update failed." });
      throw error;
    }
  }
}

/** Runs the installer silently and lets it outlive this process (it stops the old bridge itself). */
function defaultLaunch(file) {
  if (process.platform !== "win32") throw new Error("Updating from the app works on Windows only.");
  spawn(file, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
