import test from "node:test";
import assert from "node:assert/strict";
import { env } from "./stubs/cloudflare-workers.mjs";
import { dayOf, dayStart, discoverComputers, listNewFiles } from "../src/lib/autodrive.ts";

test("days follow Bangladesh time (UTC+6), so 23:50 belongs to the same day", () => {
  // 23:50 on 17 Nov in Dhaka is 17:50 UTC.
  assert.equal(dayOf(Date.parse("2026-11-17T17:50:00Z")), "2026-11-17");
  // 00:10 on 18 Nov in Dhaka is 18:10 UTC the day before.
  assert.equal(dayOf(Date.parse("2026-11-17T18:10:00Z")), "2026-11-18");
  assert.equal(dayStart("2026-11-18"), Date.parse("2026-11-17T18:00:00Z"));
  assert.equal(dayOf(dayStart("2026-11-18")), "2026-11-18");
});

/** A tiny fake of the Drive API that answers files.list from a table of items. */
function fakeDrive(items) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const q = url.searchParams.get("q") || "";
    const parent = q.match(/'([^']+)' in parents/)?.[1];
    let files;
    if (url.pathname.endsWith("/files") && parent) {
      files = items.filter((i) => i.parents?.includes(parent));
      const since = q.match(/modifiedTime > '([^']+)'/)?.[1];
      files = files.filter((i) => i.mimeType === "application/vnd.google-apps.folder" || !since || i.modifiedTime > since);
    } else if (url.pathname.endsWith("/files")) {
      files = items.filter((i) => i.mimeType === "application/vnd.google-apps.folder");
    } else {
      files = [];
    }
    return new Response(JSON.stringify({ files }), { status: 200 });
  };
  return calls;
}
const FOLDER = "application/vnd.google-apps.folder";

test("computers are the owned folders that have no parent", async () => {
  env.DRIVE_API_BASE = "https://drive.test/v3";
  fakeDrive([
    { id: "pc1", name: "Hasan", mimeType: FOLDER },
    { id: "pc2", name: "Akash", mimeType: FOLDER },
    { id: "sub", name: "Recordings", mimeType: FOLDER, parents: ["pc1"] },
  ]);
  const computers = await discoverComputers("token");
  assert.deepEqual(computers.map((c) => c.name), ["Akash", "Hasan"]);
});

test("lists only media files changed since the cutoff, through subfolders, tagged with their day", async () => {
  env.DRIVE_API_BASE = "https://drive.test/v3";
  fakeDrive([
    { id: "f1", name: "call 1.mp4", mimeType: "video/mp4", parents: ["pc1"], modifiedTime: "2026-11-17T10:00:00Z" },
    { id: "f2", name: "notes.txt", mimeType: "text/plain", parents: ["pc1"], modifiedTime: "2026-11-17T10:00:00Z" },
    { id: "old", name: "old.mp4", mimeType: "video/mp4", parents: ["pc1"], modifiedTime: "2026-11-01T10:00:00Z" },
    { id: "d1", name: "2026-11-17", mimeType: FOLDER, parents: ["pc1"] },
    // 18:30 UTC on the 17th is 00:30 on the 18th in Bangladesh.
    { id: "f3", name: "late.mp3", mimeType: "audio/mpeg", parents: ["d1"], modifiedTime: "2026-11-17T18:30:00Z" },
  ]);
  const files = await listNewFiles("token", "pc1", Date.parse("2026-11-16T18:00:00Z"));
  assert.deepEqual(files.map((f) => [f.id, f.path, f.day]), [
    ["f1", "call 1.mp4", "2026-11-17"],
    ["f3", "2026-11-17 / late.mp3", "2026-11-18"],
  ]);
});
