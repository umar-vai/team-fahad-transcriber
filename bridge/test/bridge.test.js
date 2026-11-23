import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Api } from "../src/api.js";
import { NoAudioError, PIECE_SECONDS, decodeToRaw, planPieces } from "../src/audio.js";
import { Bridge } from "../src/bridge.js";
import { Processor } from "../src/processor.js";
import { Store } from "../src/store.js";
import { startUi } from "../src/ui.js";
import { Updater, isNewer } from "../src/updater.js";
import { Watcher, fingerprint } from "../src/watcher.js";

process.env.BRIDGE_QUIET = "1";
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));

/** A tone with short silences at 290 s and 580 s, inside the last 12 s before each 5 minute boundary. */
function makeAudio(file, seconds, ext = "mp3") {
  const out = `${file}.${ext}`;
  const expr = `sin(2*PI*440*t)*0.5*not(between(t,289.5,290.5))*not(between(t,579.5,580.5))`;
  const run = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=16000:d=${seconds}`, "-ac", "1", out]);
  assert.equal(run.status, 0, String(run.stderr));
  return out;
}

test("pieces are cut in a pause close to every 5 minutes", { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const file = makeAudio(path.join(dir, "call"), 700, "wav");
  const { raw, samples } = await decodeToRaw(file);
  const pieces = planPieces(raw, samples);
  fs.rmSync(raw);
  assert.equal(pieces.length, 3);
  assert.ok(Math.abs(pieces[0].duration - 290) < 1.2, `first cut at ${pieces[0].duration}`);
  assert.ok(Math.abs(pieces[1].offset + pieces[1].duration - 580) < 1.2);
  assert.equal(pieces[2].end, samples);
  assert.ok(pieces.every((p) => p.duration <= PIECE_SECONDS + 0.01));
  assert.equal(pieces.reduce((n, p) => n + (p.end - p.start), 0), samples);
});

test("a file without audio is reported as such, not retried forever", { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const bad = path.join(dir, "broken.mp3");
  fs.writeFileSync(bad, "this is not audio at all");
  await assert.rejects(() => decodeToRaw(bad), (error) => error instanceof NoAudioError);
});

test("fingerprints follow the content, not the name", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "a.mp3"), Buffer.alloc(3_000_000, 1));
  fs.copyFileSync(path.join(dir, "a.mp3"), path.join(dir, "b.mp3"));
  fs.writeFileSync(path.join(dir, "c.mp3"), Buffer.alloc(3_000_000, 2));
  assert.equal(fingerprint(path.join(dir, "a.mp3"), 3_000_000), fingerprint(path.join(dir, "b.mp3"), 3_000_000));
  assert.notEqual(fingerprint(path.join(dir, "a.mp3"), 3_000_000), fingerprint(path.join(dir, "c.mp3"), 3_000_000));
});

test("the watcher waits until a file has stopped changing and ignores old files unless asked", () => {
  const dir = tmp();
  const store = new Store(path.join(dir, "data"));
  const folder = path.join(dir, "watch");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "old.mp3"), "x".repeat(100));
  store.saveConfig({ folder, watchSince: Date.now() + 60_000 });
  const watcher = new Watcher(store, { stableMs: 1000 });
  assert.equal(watcher.ready().ready.length, 0, "files that arrived before setup are skipped");

  store.saveConfig({ watchSince: 0 });
  fs.writeFileSync(path.join(folder, "notes.txt"), "not audio");
  const t0 = Date.now();
  assert.equal(watcher.ready(t0).ready.length, 0, "first sight: still being copied");
  assert.equal(watcher.ready(t0 + 500).ready.length, 0, "not stable long enough");
  assert.deepEqual(watcher.ready(t0 + 1500).ready.map((f) => f.name), ["old.mp3"]);
  fs.appendFileSync(path.join(folder, "old.mp3"), "more");
  assert.equal(watcher.ready(t0 + 3000).ready.length, 0, "the file grew: wait again");
});

/** A fake website with the same three calls as the real one. */
function fakeSite({ down = false } = {}) {
  const state = { down, pieces: [], completes: [], heartbeats: 0, known: [], settings: { mode: "smart", language: "Bangla (Bangladesh)" }, reject401: false };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const reply = (status, data) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(data)));
    if (state.down) return reply(503, { error: "Server busy, try again." });
    if (req.url === "/api/bridge/link") {
      const { pin, key } = JSON.parse(body.toString());
      if (pin !== "team-pin") return reply(403, { error: "The PIN is wrong." });
      return key ? reply(200, { token: "a".repeat(64), deviceId: "d9", name: "Hasan" }) : reply(200, { computers: [{ key: "computer:f1", name: "Hasan" }] });
    }
    if (state.reject401 && req.url !== "/api/bridge/pair") return reply(401, { error: "This PC was removed." });
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/bridge/pair") {
      const code = JSON.parse(body.toString()).code;
      return code === "GOODCODE" ? reply(200, { token: "a".repeat(64), deviceId: "d1", name: "PC-01" }) : reply(400, { error: "This code is wrong or has expired." });
    }
    if (req.headers.authorization !== `Bearer ${"a".repeat(64)}`) return reply(401, { error: "not connected" });
    if (url.pathname === "/api/bridge/heartbeat") {
      state.heartbeats++;
      const info = JSON.parse(body.toString());
      return reply(200, { ok: true, settings: state.settings, known: (info.check || []).filter((f) => state.known.includes(f)) });
    }
    if (url.pathname === "/api/bridge/piece") {
      state.pieces.push({ type: req.headers["content-type"], bytes: body.length, duration: url.searchParams.get("duration"), language: url.searchParams.get("language") });
      return reply(200, { transcript: `piece ${state.pieces.length}`, segments: [], detectedLanguage: null });
    }
    if (url.pathname === "/api/bridge/complete") {
      state.completes.push(JSON.parse(body.toString()));
      return reply(200, { ok: true });
    }
    reply(404, { error: "no" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function setup(site, { sleepMs = 0 } = {}) {
  const dir = tmp();
  const folder = path.join(dir, "watch");
  fs.mkdirSync(folder);
  const store = new Store(path.join(dir, "data"));
  store.saveConfig({ server: site.url, token: "a".repeat(64), deviceName: "PC-01", folder, watchSince: 0 });
  const api = new Api(store, "test");
  const processor = new Processor(api, { sleepFn: () => new Promise((r) => setTimeout(r, sleepMs)) });
  const bridge = new Bridge(store, api, { processor, watcher: new Watcher(store, { stableMs: 0 }) });
  return { dir, folder, store, bridge };
}

/** Run the loop body until nothing is left to do right now. */
async function drain(bridge, max = 10) {
  for (let i = 0; i < max; i++) {
    bridge.watcher.seen.clear();
    await bridge.runOnce();
    bridge.watcher.ready(); // second pass marks stable files
    if (!(await bridge.runOnce())) break;
  }
}

test("a new file is cut, sent piece by piece and completed once", { skip: !hasFfmpeg }, async () => {
  const site = await fakeSite();
  const { folder, store, bridge } = await setup(site);
  makeAudio(path.join(folder, "2026-11-17 call"), 700);
  // First scan only notices the file; the second finds it stable (stableMs = 0).
  await bridge.runOnce();
  await bridge.runOnce();
  site.server.close();

  assert.equal(site.state.pieces.length, 3);
  assert.ok(site.state.pieces.every((p) => p.type === "audio/mpeg" && p.bytes < 3_000_000), "pieces are small MP3 files");
  assert.equal(site.state.completes.length, 1);
  const done = site.state.completes[0];
  assert.equal(done.name, "2026-11-17 call.mp3");
  assert.deepEqual(done.pieces.map((p) => p.transcript).sort(), ["piece 1", "piece 2", "piece 3"]);
  assert.ok(Math.abs(done.duration - 700) < 1);
  const entry = Object.values(store.ledger)[0];
  assert.equal(entry.state, "done");

  // Nothing happens a second time for the same file.
  const before = site.state.pieces.length;
  await bridge.runOnce();
  assert.equal(site.state.pieces.length, before);
});

test("no internet: the file waits and is sent when the website is back", { skip: !hasFfmpeg }, async () => {
  const site = await fakeSite({ down: true });
  const { folder, store, bridge } = await setup(site);
  makeAudio(path.join(folder, "late"), 60);
  await bridge.runOnce();
  const first = await bridge.runOnce();
  assert.equal(first, true, "it tried");
  assert.equal(site.state.completes.length, 0);
  assert.equal(Object.keys(store.ledger).length, 0, "not marked done");
  assert.match(bridge.status.lastError, /busy|connection/i);

  site.state.down = false;
  bridge.nextTry.clear();
  await bridge.runOnce();
  site.server.close();
  assert.equal(site.state.completes.length, 1);
  assert.equal(Object.values(store.ledger)[0].state, "done");
});

test("a file the website already has is not transcribed again", { skip: !hasFfmpeg }, async () => {
  const site = await fakeSite();
  const { folder, store, bridge } = await setup(site);
  const file = makeAudio(path.join(folder, "dup"), 30);
  site.state.known.push(fingerprint(file, fs.statSync(file).size));
  await bridge.runOnce();
  await bridge.runOnce();
  site.server.close();
  assert.equal(site.state.pieces.length, 0);
  assert.equal(Object.values(store.ledger)[0].state, "done");
});

test("a broken file is reported as Failed once and listed in the ledger", { skip: !hasFfmpeg }, async () => {
  const site = await fakeSite();
  const { folder, store, bridge } = await setup(site);
  fs.writeFileSync(path.join(folder, "broken.mp3"), "garbage that is not audio");
  await bridge.runOnce();
  await bridge.runOnce();
  site.server.close();
  assert.equal(site.state.completes.length, 1);
  assert.equal(site.state.completes[0].failed, true);
  assert.match(site.state.completes[0].error, /no readable audio|no audio/i);
  assert.equal(Object.values(store.ledger)[0].state, "failed");

  // "Try failed files again" puts it back in the queue.
  assert.equal(bridge.retryFailed(), 1);
  assert.equal(Object.values(store.ledger)[0].state, "retry");
});

test("a removed PC stops and asks to be paired again, keeping its files", { skip: !hasFfmpeg }, async () => {
  const site = await fakeSite();
  site.state.reject401 = true;
  const { folder, store, bridge } = await setup(site);
  makeAudio(path.join(folder, "keep"), 30);
  await bridge.runOnce();
  await bridge.runOnce();
  site.server.close();
  assert.equal(bridge.status.needsPairing, true);
  assert.equal(Object.keys(store.ledger).length, 0, "nothing is lost");
});

test("pairing with a wrong code shows the website's message", async () => {
  const site = await fakeSite();
  const store = new Store(path.join(tmp(), "data"));
  store.saveConfig({ server: site.url });
  const api = new Api(store, "test");
  await assert.rejects(() => api.pair("WRONGONE"), /wrong or has expired/);
  const ok = await api.pair("GOODCODE");
  site.server.close();
  assert.equal(ok.name, "PC-01");
});

test("the connection indicator follows what really happened with the website", async () => {
  const site = await fakeSite();
  const { store, bridge } = await setup(site);
  assert.equal(bridge.connectionState().state, "checking", "nothing tried yet");

  await bridge.beat(true);
  assert.equal(bridge.connectionState().state, "connected");
  assert.ok(Date.now() - bridge.connectionState().lastContactAt < 5000);
  // A contact that is too old is not trusted any more.
  assert.equal(bridge.connectionState(Date.now() + 200_000).state, "offline");

  // The website cannot be reached.
  site.server.close();
  store.saveConfig({ server: "http://127.0.0.1:1" });
  await bridge.beat(true);
  assert.equal(bridge.connectionState().state, "offline");

  // The website answers but no longer knows this PC.
  const site2 = await fakeSite();
  site2.state.reject401 = true;
  store.saveConfig({ server: site2.url });
  await bridge.beat(true);
  assert.equal(bridge.connectionState().state, "removed");
  site2.server.close();

  store.saveConfig({ token: "" });
  assert.equal(bridge.connectionState().state, "unpaired");
});

test("the status window lists computers after the team PIN and links this PC to the chosen one", async () => {
  const site = await fakeSite();
  const dir = tmp();
  const store = new Store(path.join(dir, "data"));
  store.saveConfig({ server: site.url });
  const api = new Api(store, "test");
  const bridge = new Bridge(store, api, { processor: new Processor(api), watcher: new Watcher(store, { stableMs: 0 }) });
  const port = 47900 + Math.floor(Math.random() * 90);
  const ui = await startUi(bridge, store, { port });
  const post = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-bridge": "1" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/link-list", { pin: "wrong" })).status, 403);
    assert.equal(store.paired, false);
    const list = await (await post("/api/link-list", { pin: "team-pin" })).json();
    assert.deepEqual(list.computers, [{ key: "computer:f1", name: "Hasan" }]);
    const linked = await (await post("/api/link", { pin: "team-pin", key: "computer:f1" })).json();
    assert.equal(linked.name, "Hasan");
    assert.equal(store.paired, true);
    assert.equal(store.config.deviceName, "Hasan");
  } finally {
    ui.close();
    site.server.close();
  }
});

test("the app sees a newer version, downloads it, checks it and runs the installer", async () => {
  assert.ok(isNewer("1.10.0", "1.9.9") && isNewer("1.2.0", "1.1.0") && !isNewer("1.2.0", "1.2.0") && !isNewer("1.1.9", "1.2.0"));
  const installer = Buffer.alloc(1_500_000, 7);
  const info = { version: "1.3.0", size: installer.length, sha256: crypto.createHash("sha256").update(installer).digest("hex") };
  let served = installer;
  const server = http.createServer((req, res) => {
    if (req.url === "/latest.json") return res.end(JSON.stringify(info));
    if (req.url === "/TeamFahadBridge-Setup.exe") return res.end(served);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const launched = [];
    const dir = path.join(tmp(), "update");
    const same = new Updater("1.3.0", { base, dir, launch: (f) => launched.push(f) });
    assert.equal((await same.check()).state, "current");
    const updater = new Updater("1.2.0", { base, dir, launch: (f) => launched.push(f) });
    assert.equal((await updater.check()).state, "available");
    assert.equal(updater.state.latest, "1.3.0");

    served = Buffer.alloc(1_500_000, 8); // a damaged download is refused and never run
    await assert.rejects(() => updater.install(), /damaged/);
    assert.equal(launched.length, 0);
    assert.equal(updater.state.state, "error");
    assert.equal((await updater.check()).state, "available");

    served = installer;
    await updater.install();
    assert.equal(updater.state.state, "installing");
    assert.equal(launched.length, 1);
    assert.deepEqual(fs.readFileSync(launched[0]), installer);
  } finally {
    server.close();
  }
});
