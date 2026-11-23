import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

/** Settings (config.json) and the ledger of handled files (ledger.json), written atomically. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

export class Store {
  constructor(dir = dataDir()) {
    this.dir = dir;
    this.configFile = path.join(dir, "config.json");
    this.ledgerFile = path.join(dir, "ledger.json");
    this.config = {
      server: "https://transcribe.abdullahfahad.com",
      token: "",
      deviceName: "",
      /** team = a named PC of the team, personal = one person signed in with Google. */
      deviceKind: "",
      account: "",
      folder: "",
      /** Only files that arrived after this time are transcribed (0 = also the files already in the folder). */
      watchSince: 0,
      ...readJson(this.configFile, {}),
    };
    /** path -> { size, mtimeMs, fingerprint, state: "done" | "failed", error?, at } */
    this.ledger = readJson(this.ledgerFile, {});
  }

  saveConfig(patch = {}) {
    Object.assign(this.config, patch);
    writeJson(this.configFile, this.config);
  }

  saveLedger() {
    writeJson(this.ledgerFile, this.ledger);
  }

  get paired() {
    return Boolean(this.config.token);
  }
}
