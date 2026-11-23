import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;

/** Settings and progress live outside the program folder, so updating the program never loses them. */
export function dataDir() {
  if (process.env.BRIDGE_DATA_DIR) return process.env.BRIDGE_DATA_DIR;
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "TeamFahadBridge");
}

/** The ffmpeg that ships next to the program (Windows), or the one on PATH. */
export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundled = path.join(APP_DIR, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return fs.existsSync(bundled) ? bundled : "ffmpeg";
}
