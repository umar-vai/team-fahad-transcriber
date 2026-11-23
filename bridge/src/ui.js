/**
 * The local setup and status page at http://127.0.0.1:47821 (only this PC can open it).
 * Pair the PC with a code from the Auto page, choose the folder, see what is happening.
 */
import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { Api } from "./api.js";
import { log, recentLog } from "./log.js";
import { VERSION } from "./paths.js";
import { PAGE } from "./page.js";

export const UI_PORT = Number(process.env.BRIDGE_PORT) || 47821;

/**
 * The folder picker. A hidden PowerShell cannot show a dialog in front of other windows by itself, so the dialog
 * gets an invisible owner window in the middle of the screen that is brought to the front first.
 * Returns { folder } (null when the person cancels) or { error } when the dialog could not be shown.
 */
const PICKER_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$top = New-Object System.Windows.Forms.Form",
  "$top.TopMost = $true; $top.ShowInTaskbar = $false; $top.FormBorderStyle = 'None'; $top.Opacity = 0",
  "$top.StartPosition = 'CenterScreen'; $top.Size = New-Object System.Drawing.Size(1, 1)",
  "$top.Show(); $top.Activate()",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = 'Select the folder to watch'; $d.ShowNewFolderButton = $true",
  "if ($d.ShowDialog($top) -eq 'OK') { Write-Output $d.SelectedPath }",
  "$top.Close()",
].join("\n");

function browseFolder() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve({ folder: null, error: "The folder window works on Windows only. Type the folder path." });
    // -EncodedCommand (UTF-16 base64) avoids every quoting problem of passing a script as an argument.
    const encoded = Buffer.from(PICKER_SCRIPT, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => resolve({ folder: null, error: `The folder window could not start (${error.message}). Type the folder path.` }));
    child.on("close", (code) => {
      const folder = out.trim();
      if (folder) return resolve({ folder });
      // Cancelled: exit code 0 and no error text. Anything else is a real problem.
      if (code !== 0 || err.trim()) return resolve({ folder: null, error: "The folder window could not open. Type the folder path instead." });
      resolve({ folder: null });
    });
  });
}

/** Opens a web address in the person's browser (Windows: the default browser). */
function openInBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {}
}

export function startUi(bridge, store, { port = UI_PORT, updater = null, openUrl = openInBrowser } = {}) {
  /** The "Sign in with Google" request that is waiting for approval on the website. */
  let pendingLogin = null;
  const api = new Api(store, VERSION);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const send = (res, status, body, type = "application/json; charset=utf-8") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let text = "";
      req.on("data", (d) => (text += d));
      req.on("end", () => {
        try {
          resolve(JSON.parse(text || "{}"));
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    // Other websites must not be able to drive this page (DNS rebinding, cross-site requests).
    if (!allowedHosts.has(String(req.headers.host))) return send(res, 403, { error: "Not allowed." });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/status") {
      return send(res, 200, {
        version: VERSION,
        paired: store.paired,
        deviceName: store.config.deviceName,
        server: store.config.server,
        folder: store.config.folder,
        includeExisting: !store.config.watchSince,
        ...bridge.status,
        connection: bridge.connectionState().state,
        // Seconds, not a clock time, so a wrong PC clock cannot make it look stale.
        contactAgo: bridge.connectionState().lastContactAt ? Math.round((Date.now() - bridge.connectionState().lastContactAt) / 1000) : null,
        serverHost: new URL(store.config.server).host,
        failed: Object.entries(store.ledger).filter(([, v]) => v.state === "failed").map(([file, v]) => ({ file, error: v.error })).slice(-20),
        doneCount: Object.values(store.ledger).filter((v) => v.state === "done").length,
        kind: store.config.deviceKind || "team",
        account: bridge.remote?.account || store.config.account || null,
        sheetEnabled: bridge.remote ? bridge.remote.sheetEnabled : true,
        settings: bridge.remote?.settings || null,
        choices: bridge.remote?.choices || null,
        update: updater ? { ...updater.state } : null,
        log: recentLog().slice(-25),
      });
    }
    if (req.method !== "POST") return send(res, 404, { error: "Not found." });
    const origin = req.headers.origin;
    if (req.headers["x-bridge"] !== "1" || (origin && !allowedHosts.has(new URL(origin).host))) return send(res, 403, { error: "Not allowed." });
    const body = await readBody(req);
    try {
      if (url.pathname === "/api/pair") {
        const result = await api.pair(String(body.code || ""));
        store.saveConfig({ token: result.token, deviceName: result.name, deviceKind: "team", account: "" });
        bridge.status.needsPairing = false;
        bridge.status.lastError = null;
        bridge.lastBeat = 0;
        bridge.nudge();
        return send(res, 200, { ok: true, name: result.name });
      }
      if (url.pathname === "/api/link-list") return send(res, 200, await api.linkList(String(body.pin || "")));
      if (url.pathname === "/api/link") {
        const result = await api.link(String(body.pin || ""), String(body.key || ""));
        store.saveConfig({ token: result.token, deviceName: result.name, deviceKind: "team", account: "" });
        bridge.status.needsPairing = false;
        bridge.status.lastError = null;
        bridge.lastBeat = 0;
        bridge.nudge();
        return send(res, 200, { ok: true, name: result.name });
      }
      if (url.pathname === "/api/folder") {
        const folder = String(body.folder || "").trim();
        if (!folder) return send(res, 400, { error: "Choose a folder." });
        const { default: fs } = await import("node:fs");
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return send(res, 400, { error: "This folder does not exist on this PC." });
        const changed = folder !== store.config.folder;
        // New files only, unless asked to also take the files already there.
        store.saveConfig({ folder, ...(changed || body.includeExisting !== undefined ? { watchSince: body.includeExisting ? 0 : Date.now() } : {}) });
        bridge.nudge();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/update/check" && updater) return send(res, 200, { ...(await updater.check()) });
      if (url.pathname === "/api/update/install" && updater) {
        // The download runs on; the window follows its progress through /api/status.
        updater.install().catch((error) => log(`Update failed: ${error.message}`));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/login-start") {
        const started = await api.loginStart(os.hostname());
        const link = `${store.config.server}/bridge/link?code=${started.userCode}`;
        pendingLogin = { requestId: started.requestId, userCode: started.userCode, expiresAt: started.expiresAt };
        openUrl(link);
        return send(res, 200, { userCode: `${started.userCode.slice(0, 4)}-${started.userCode.slice(4)}`, link });
      }
      if (url.pathname === "/api/login-poll") {
        if (!pendingLogin) return send(res, 200, { state: "none" });
        let result;
        try {
          result = await api.loginPoll(pendingLogin.requestId);
        } catch (error) {
          if (error.status && error.status < 500 && error.status !== 429) pendingLogin = null;
          throw error;
        }
        if (result.pending) return send(res, 200, { state: "pending" });
        pendingLogin = null;
        store.saveConfig({ token: result.token, deviceName: result.name, deviceKind: "personal", account: result.account || "" });
        bridge.remote = null;
        bridge.status.needsPairing = false;
        bridge.status.lastError = null;
        bridge.lastBeat = 0;
        bridge.nudge();
        return send(res, 200, { state: "done", account: result.account });
      }
      if (url.pathname === "/api/prefs") {
        const patch = {};
        for (const key of ["sheet", "mode", "language"]) if (body[key] !== undefined) patch[key] = body[key];
        const result = await api.prefs(patch);
        bridge.remote = { kind: result.kind, account: result.account, sheetEnabled: result.sheetEnabled, settings: result.settings, choices: result.choices };
        bridge.settings = result.settings;
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/reset") {
        // A personal PC removes itself from the website; a team PC stays there so it can be linked again.
        // The watched folder and the list of finished files are kept.
        await api.leave().catch(() => {});
        pendingLogin = null;
        store.saveConfig({ token: "", deviceName: "", deviceKind: "", account: "" });
        bridge.remote = null;
        bridge.settings = null;
        bridge.status.needsPairing = false;
        bridge.status.lastError = null;
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/browse") return send(res, 200, await browseFolder());
      if (url.pathname === "/api/retry") return send(res, 200, { count: bridge.retryFailed() });
      return send(res, 404, { error: "Not found." });
    } catch (error) {
      return send(res, error.status && error.status < 500 ? error.status : 502, { error: error.message || "Something went wrong." });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
