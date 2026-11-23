/**
 * The local setup and status page at http://127.0.0.1:47821 (only this PC can open it).
 * Pair the PC with a code from the Auto page, choose the folder, see what is happening.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { Api } from "./api.js";
import { recentLog } from "./log.js";
import { VERSION } from "./paths.js";
import { PAGE } from "./page.js";

export const UI_PORT = Number(process.env.BRIDGE_PORT) || 47821;

function browseFolder() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select the folder to watch'; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; if ($d.ShowDialog($top) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }";
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim() || null));
  });
}

export function startUi(bridge, store, { port = UI_PORT } = {}) {
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
        store.saveConfig({ token: result.token, deviceName: result.name });
        bridge.status.needsPairing = false;
        bridge.status.lastError = null;
        bridge.lastBeat = 0;
        bridge.nudge();
        return send(res, 200, { ok: true, name: result.name });
      }
      if (url.pathname === "/api/link-list") return send(res, 200, await api.linkList(String(body.pin || "")));
      if (url.pathname === "/api/link") {
        const result = await api.link(String(body.pin || ""), String(body.key || ""));
        store.saveConfig({ token: result.token, deviceName: result.name });
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
      if (url.pathname === "/api/browse") return send(res, 200, { folder: await browseFolder() });
      if (url.pathname === "/api/retry") return send(res, 200, { count: bridge.retryFailed() });
      if (url.pathname === "/api/unpair") {
        store.saveConfig({ token: "", deviceName: "" });
        return send(res, 200, { ok: true });
      }
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
