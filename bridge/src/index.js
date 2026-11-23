/**
 * Team Fahad Bridge. Started once per PC (at sign-in). It restarts itself if it ever crashes.
 *   node src/index.js          run (the first process supervises a worker process)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Api } from "./api.js";
import { Bridge } from "./bridge.js";
import { log } from "./log.js";
import { VERSION } from "./paths.js";
import { Store } from "./store.js";
import { startTray } from "./tray.js";
import { Updater } from "./updater.js";
import { UI_PORT, startUi } from "./ui.js";

const self = fileURLToPath(import.meta.url);

function supervise() {
  const start = () => {
    const child = spawn(process.execPath, [self, "--worker", ...process.argv.slice(2).filter((a) => a !== "--worker")], { stdio: "inherit", windowsHide: true });
    child.on("exit", (code) => {
      if (code === 0) return process.exit(0);
      log(`The bridge stopped (code ${code}). Starting it again in 5 seconds.`);
      setTimeout(start, 5000);
    });
  };
  start();
}

async function work() {
  const store = new Store();
  const api = new Api(store, VERSION);
  const bridge = new Bridge(store, api);
  const updater = new Updater(VERSION);
  try {
    await startUi(bridge, store, { updater });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      log("The bridge is already running on this PC.");
      process.exit(0);
    }
    throw error;
  }
  log(`Team Fahad Bridge ${VERSION} started. Setup page: http://127.0.0.1:${UI_PORT}`);
  process.on("uncaughtException", (error) => log(`Unexpected problem: ${error?.stack || error}`));
  process.on("unhandledRejection", (error) => log(`Unexpected problem: ${error?.stack || error}`));
  // Only the tray icon is visible after sign-in. "Exit" ends this worker with code 0, so the supervisor stops too.
  updater.start();
  startTray({ onExit: () => process.exit(0) });
  await bridge.loop();
}

if (process.argv.includes("--worker") || process.env.BRIDGE_NO_SUPERVISOR) await work();
else supervise();
