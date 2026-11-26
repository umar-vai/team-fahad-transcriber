import test from "node:test";
import assert from "node:assert/strict";
import { buildBatchGrid, kindOf, summarizeBatch } from "../src/lib/batchdash.ts";

const items = [
  { index: 0, fileId: "a", title: "a.mp3", status: "done", words: 100, duration: 60 },
  { index: 1, fileId: "b", title: "b.mp3", status: "done", words: 50, duration: 30 },
  { index: 2, fileId: "c", title: "c.mp3", status: "failed", error: "No speech was found in this file (checked 2 times).", permanent: true },
  { index: 3, fileId: "d", title: "d.mp3", status: "failed", error: "Gemini busy" },
  { index: 4, fileId: "e", title: "e.mp3", status: "queued" },
];

test("files are classified", () => {
  assert.deepEqual(items.map(kindOf), ["Transcribed", "Transcribed", "No speech", "Failed", "Waiting"]);
});

test("batch summary counts words and percent", () => {
  const s = summarizeBatch(items);
  assert.equal(s.total, 5);
  assert.equal(s.words, 150);
  assert.equal(s.averageWords, 75);
  assert.equal(s.percent, 0.4);
  assert.deepEqual(s.count, { Transcribed: 2, "No speech": 1, Failed: 1, Waiting: 1 });
});

test("grid has one row per file below the table header", () => {
  const g = buildBatchGrid("Folder", items, "2026-11-26 10:00");
  assert.equal(g.grid.length, g.tableHeader + 1 + items.length);
  assert.ok(g.tableHeader >= g.statusHeader + 12);
});
