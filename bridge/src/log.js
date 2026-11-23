import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

const MAX_BYTES = 1_000_000;
const recent = [];

/** A small log file (kept under 1 MB, the older half is dropped) plus the last lines for the local page. */
export function log(message) {
  const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)}  ${message}`;
  recent.push(line);
  if (recent.length > 80) recent.shift();
  if (!process.env.BRIDGE_QUIET) console.log(line);
  try {
    const file = path.join(dataDir(), "bridge.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.slice(text.length / 2));
    }
    fs.appendFileSync(file, line + "\n");
  } catch {}
}

export const recentLog = () => [...recent];
