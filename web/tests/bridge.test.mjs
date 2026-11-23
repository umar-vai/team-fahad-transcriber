import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { env } from "./stubs/cloudflare-workers.mjs";
import { knownName, approveLogin, authDevice, completeFile, deviceView, leaveDevice, loginRequestInfo, pollLogin, saveDevicePrefs, settingsFor, startLogin, createPairingCode, failFile, knownFingerprints, linkChoices, linkDevice, normalizeCode, redeemPairingCode, setLinkPin } from "../src/lib/bridge.ts";

/** A tiny D1 look-alike on node:sqlite. */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_init", "0003_auto_drive", "0006_bridge", "0007_bridge_link", "0008_bridge_personal"]) db.exec(readFileSync(new URL(`../migrations/${file}.sql`, import.meta.url), "utf8"));
  const wrap = (sql, args = []) => ({
    bind: (...values) => wrap(sql, values),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { db, prepare: (sql) => wrap(sql) };
}

function setup() {
  const d1 = fakeD1();
  d1.db.prepare("INSERT INTO users (id, google_sub, email, created_at, last_login_at) VALUES ('u1','g1','a@b.c',1,1)").run();
  env.DB = d1;
  env.SHEETS_SPREADSHEET_ID = undefined;
  env.GOOGLE_SERVICE_ACCOUNT_JSON = undefined;
  return d1;
}

async function pairDevice(name = "PC-01") {
  const { code } = await createPairingCode("u1", name);
  return redeemPairingCode(code);
}

const pieces = (text) => [{ offset: 0, duration: 120, transcript: text, segments: [] }];
const info = (n) => ({ fingerprint: `${n}`.padStart(32, "a"), name: `2026-11-17 14-56-0${n}.mp3`, mtimeMs: Date.parse("2026-11-17T10:00:00Z") });

test("a pairing code works once, only for 15 minutes, and gives a token that identifies the PC", async () => {
  const d1 = setup();
  const { code } = await createPairingCode("u1", "PC-03");
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  const paired = await redeemPairingCode(`${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`);
  assert.equal(paired.name, "PC-03");
  await assert.rejects(() => redeemPairingCode(code), /wrong or has expired/);

  const device = await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${paired.token}` } }));
  assert.equal(device.id, paired.deviceId);
  // Only a hash of the token is stored.
  assert.equal(d1.db.prepare("SELECT COUNT(*) AS n FROM bridge_devices WHERE token_hash = ?").get(paired.token).n, 0);

  const late = await createPairingCode("u1", "PC-04");
  d1.db.prepare("UPDATE bridge_pairing SET expires_at = 1").run();
  await assert.rejects(() => redeemPairingCode(late.code), /wrong or has expired/);
});

test("bad or removed tokens are refused", async () => {
  const d1 = setup();
  await assert.rejects(() => authDevice(new Request("https://x")), /not connected/);
  await assert.rejects(() => authDevice(new Request("https://x", { headers: { authorization: `Bearer ${"a".repeat(64)}` } })), /removed/);
  const paired = await pairDevice();
  d1.db.prepare("DELETE FROM bridge_devices").run();
  await assert.rejects(() => authDevice(new Request("https://x", { headers: { authorization: `Bearer ${paired.token}` } })), /removed/);
  assert.equal(normalizeCode(" ab-cd 12 "), "ABCD12");
});

test("a finished file is saved to History once, with a row number and the date, even if the PC repeats the call", async () => {
  const d1 = setup();
  const paired = await pairDevice();
  const device = d1.db.prepare("SELECT * FROM bridge_devices").get();
  const first = await completeFile(device, { ...info(1), duration: 120, pieces: pieces("আমি ভালো আছি") });
  assert.equal(first.ok, true);
  const again = await completeFile(device, { ...info(1), duration: 120, pieces: pieces("আমি ভালো আছি") });
  assert.equal(again.duplicate, true);
  await completeFile(device, { ...info(2), duration: 60, pieces: pieces("second call") });

  const rows = d1.db.prepare("SELECT name, row_no, file_day, status FROM bridge_files ORDER BY row_no").all();
  assert.deepEqual(rows.map((r) => [r.row_no, r.file_day, r.status]), [[1, "2026-11-17", "done"], [2, "2026-11-17", "done"]]);
  const history = d1.db.prepare("SELECT title, source_type, user_id, transcript FROM transcriptions ORDER BY title").all();
  assert.equal(history.length, 2);
  assert.equal(history[0].source_type, "bridge");
  assert.equal(history[0].user_id, "u1");
  assert.equal(paired.name, "PC-01");
});

test("a recording with no speech is listed as Failed, and later success replaces it on the same row", async () => {
  const d1 = setup();
  await pairDevice();
  const device = d1.db.prepare("SELECT * FROM bridge_devices").get();
  const silent = await completeFile(device, { ...info(3), pieces: pieces("   ") });
  assert.equal(silent.failed, true);
  assert.equal(d1.db.prepare("SELECT status FROM bridge_files").get().status, "failed");
  assert.equal(d1.db.prepare("SELECT COUNT(*) AS n FROM transcriptions").get().n, 0);

  await failFile(device, { ...info(4), error: "Unreadable audio" });
  const rows = d1.db.prepare("SELECT row_no, status FROM bridge_files ORDER BY row_no").all();
  assert.deepEqual(rows.map((r) => r.status), ["failed", "failed"]);

  // The same file works later: it keeps its row number.
  await completeFile(device, { ...info(3), pieces: pieces("now there is speech") });
  const fixed = d1.db.prepare("SELECT row_no, status FROM bridge_files WHERE fingerprint = ?").get(info(3).fingerprint);
  assert.deepEqual({ ...fixed }, { row_no: 1, status: "done" });
});

test("the server tells a PC which files it already finished", async () => {
  const d1 = setup();
  await pairDevice();
  const device = d1.db.prepare("SELECT * FROM bridge_devices").get();
  await completeFile(device, { ...info(1), pieces: pieces("text") });
  await failFile(device, { ...info(2), error: "bad" });
  const known = await knownFingerprints(device, [info(1).fingerprint, info(2).fingerprint, info(5).fingerprint, "not hex"]);
  // Failed files are not "known": the PC may try them again.
  assert.deepEqual(known, [info(1).fingerprint]);
});

test("sheet rows are written to the PC's own dated tab, created once", async () => {
  const d1 = setup();
  await pairDevice("PC-07");
  const device = d1.db.prepare("SELECT * FROM bridge_devices").get();
  env.SHEETS_SPREADSHEET_ID = "S".repeat(30);
  env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "sa@x.iam", private_key: "unused" });
  env.SHEETS_API_BASE = "https://sheets.test/v4/spreadsheets";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("oauth2") || url.includes("token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("fields=sheets.properties")) return new Response(JSON.stringify({ sheets: [] }));
    if (url.endsWith(":batchUpdate")) {
      const first = JSON.parse(init.body).requests[0];
      return new Response(JSON.stringify({ replies: [first.addSheet ? { addSheet: { properties: { sheetId: 77 } } } : {}] }));
    }
    return new Response("{}");
  };
  try {
    const { generateKeyPairSync } = await import("node:crypto");
    env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: "sa@x.iam",
      private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    await completeFile(device, { ...info(1), duration: 90, pieces: pieces("hello world") });
    await completeFile({ ...device, sheet_json: null }, { ...info(2), duration: 30, pieces: pieces("second") });
    const adds = calls.filter((c) => c.body?.requests?.[0]?.addSheet);
    assert.equal(adds.length, 1, "the tab is created once");
    assert.equal(adds[0].body.requests[0].addSheet.properties.title, "PC-07");
    const appended = calls.filter((c) => c.body?.requests?.[0]?.appendCells).map((c) => c.body.requests[0].appendCells.rows[0].values.map((v) => v.userEnteredValue.stringValue ?? v.userEnteredValue.numberValue));
    assert.equal(appended.length, 2);
    // Date, No., Title, Duration, Style, Status, Words, ...
    assert.deepEqual(appended[0].slice(0, 7), ["2026-11-17", 1, info(1).name, "01:30", "Smart clean", "Done", 2]);
    assert.equal(appended[1][1], 2);
    assert.equal(appended[0].at(-1), "hello world");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a fresh PC needs the team PIN, then takes over an earlier PC or a Drive computer and its sheet tab", async () => {
  const d1 = setup();
  const old = await pairDevice("Mahbub");
  d1.db.prepare("INSERT INTO drive_computers (folder_id, name, sheet_json, created_at) VALUES ('f1','Hasan','{\"title\":\"Hasan\"}',1), ('f2','Mahbub',NULL,1)").run();

  await assert.rejects(() => linkChoices("1234"), /No team PIN/);
  await assert.rejects(() => setLinkPin("u1", "12"), /at least 4/);
  await setLinkPin("u1", "team-pin");
  assert.equal(d1.db.prepare("SELECT link_pin_hash FROM bridge_settings").get().link_pin_hash.includes("team-pin"), false);
  await assert.rejects(() => linkChoices("nope"), /wrong/);

  // The Drive computer with the same name as a bridge PC is not listed twice.
  assert.deepEqual((await linkChoices("team-pin")).map((c) => c.name), ["Hasan", "Mahbub"]);

  // A new computer takes over the Drive computer "Hasan": same name and same sheet tab.
  const hasan = (await linkChoices("team-pin")).find((c) => c.name === "Hasan");
  const linked = await linkDevice("team-pin", hasan.key);
  assert.equal(linked.name, "Hasan");
  const device = await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${linked.token}` } }));
  assert.equal(device.sheet_json, '{"title":"Hasan"}');
  assert.equal(device.user_id, "u1");
  assert.deepEqual((await linkChoices("team-pin")).map((c) => c.name), ["Hasan", "Mahbub"], "now listed as a normal PC");

  // Linking Mahbub again switches the old computer off at once.
  const mahbub = (await linkChoices("team-pin")).find((c) => c.name === "Mahbub");
  const second = await linkDevice("team-pin", mahbub.key);
  assert.equal(second.deviceId, old.deviceId);
  await assert.rejects(() => authDevice(new Request("https://x", { headers: { authorization: `Bearer ${old.token}` } })), /another computer took its place/);
  assert.equal((await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${second.token}` } }))).name, "Mahbub");
  await assert.rejects(() => linkDevice("team-pin", "device:missing"), /removed/);
});

test("too many wrong PINs lock the list for a while", async () => {
  const d1 = setup();
  await setLinkPin("u1", "team-pin");
  for (let i = 0; i < 7; i++) await assert.rejects(() => linkChoices("bad"), /wrong/);
  await assert.rejects(() => linkChoices("bad"), /Too many/);
  await assert.rejects(() => linkChoices("team-pin"), /Too many/);
  d1.db.prepare("UPDATE bridge_settings SET link_locked_until = 1").run();
  assert.deepEqual(await linkChoices("team-pin"), []);
});

test("a person signs in with Google from the app: approval on the website, own account, own settings, no team sheet", async () => {
  const d1 = setup();
  await setLinkPin("u1", "team-pin");
  const { requestId, userCode } = await startLogin("Office laptop");
  assert.deepEqual(await pollLogin(requestId), { pending: true });
  assert.equal((await loginRequestInfo(userCode)).name, "Office laptop");

  await approveLogin("u1", `${userCode.slice(0, 4)}-${userCode.slice(4).toLowerCase()}`);
  await assert.rejects(() => approveLogin("u1", userCode), /already used/);
  const done = await pollLogin(requestId);
  assert.equal(done.account, "a@b.c");
  await assert.rejects(() => pollLogin(requestId), /ran out|already used/);

  const device = await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${done.token}` } }));
  assert.equal(device.kind, "personal");
  assert.equal(device.user_id, "u1");
  // Personal PCs are not on the list of team computers.
  assert.deepEqual(await linkChoices("team-pin"), []);

  // Own style and language, from a fixed list.
  assert.deepEqual(await settingsFor(device), { mode: "smart", language: "Bangla (Bangladesh)" });
  await assert.rejects(() => saveDevicePrefs(device, { mode: "shayari" }), /Choose one/);
  await saveDevicePrefs(device, { mode: "verbatim", language: "English (US)" });
  const fresh = await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${done.token}` } }));
  const view = await deviceView(fresh);
  assert.deepEqual(view.settings, { mode: "verbatim", language: "English (US)" });
  assert.equal(view.sheetEnabled, false);
  assert.ok(view.choices.languages.includes("Hindi"));

  // The transcript goes to the person's History and never to the team sheet.
  await completeFile(fresh, { ...info(1), pieces: pieces("hello there friend") });
  const history = d1.db.prepare("SELECT user_id, mode, language FROM transcriptions").get();
  assert.deepEqual({ ...history }, { user_id: "u1", mode: "verbatim", language: "English (US)" });
  assert.equal(d1.db.prepare("SELECT sheet_done FROM bridge_files").get().sheet_done, 1);
  assert.equal(d1.db.prepare("SELECT sheet_json FROM bridge_devices WHERE id = ?").get(fresh.id).sheet_json, null);

  await leaveDevice(fresh);
  assert.equal(d1.db.prepare("SELECT COUNT(*) AS n FROM bridge_devices").get().n, 0);
  await assert.rejects(() => startLogin("x").then((r) => pollLogin("wrong")), /ran out/);
});

test("a team PC can switch the Google Sheet off and keeps its shared style and language", async () => {
  const d1 = setup();
  env.SHEETS_SPREADSHEET_ID = undefined;
  const paired = await pairDevice("Hasan");
  let device = await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${paired.token}` } }));
  assert.equal((await deviceView(device)).sheetEnabled, true, "on by default");
  await saveDevicePrefs(device, { sheet: false, mode: "verbatim" });
  device = await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${paired.token}` } }));
  const view = await deviceView(device);
  assert.equal(view.sheetEnabled, false);
  assert.equal(view.choices, null, "team PCs do not choose style or language");
  assert.equal(view.settings.mode, "smart");
  await leaveDevice(device);
  assert.equal(d1.db.prepare("SELECT COUNT(*) AS n FROM bridge_devices").get().n, 1, "a team PC stays on the website");
});

test("a file that was already transcribed (by this PC or from Drive) is not done again, only brand new files are", async () => {
  const d1 = setup();
  d1.db.prepare("INSERT INTO drive_computers (folder_id, name, sheet_json, created_at) VALUES ('f1','Mahbub',NULL,1)").run();
  d1.db.prepare("INSERT INTO drive_files (file_id, computer_id, name, file_day, job_id, created_at) VALUES ('x1','f1','Call Records / 2026-11-11 14-56-14.mp4','2026-11-11','j',1), ('x2','other','2026-11-12 09-00-00.mp4','2026-11-12','j',1), ('x3','f1','Call Records/ Sub / 2026-11-13 08-00-00.mp4','2026-11-13','j',1)").run();
  await setLinkPin("u1", "team-pin");
  const choice = (await linkChoices("team-pin")).find((c) => c.name === "Mahbub");
  const linked = await linkDevice("team-pin", choice.key);
  const device = await authDevice(new Request("https://x", { headers: { authorization: `Bearer ${linked.token}` } }));

  assert.equal(await knownName(device, "2026-11-11 14-56-14.mp4"), true, "done from Drive (stored as Folder / name)");
  assert.equal(await knownName(device, "2026-11-13 08-00-00.mp4"), true, "also inside a deeper folder");
  assert.equal(await knownName(device, "11-13 08-00-00.mp4"), false, "a part of a name is not a match");
  assert.equal(await knownName(device, "2026-11-12 09-00-00.mp4"), false, "another computer's file is not this one's");
  assert.equal(await knownName(device, "2026-11-23 10-00-00.mp4"), false, "a brand new file is transcribed");
  await completeFile(device, { ...info(1), pieces: pieces("hello there") });
  assert.equal(await knownName(device, info(1).name), true, "done by this PC");
});
