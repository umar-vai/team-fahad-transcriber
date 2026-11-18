import test from "node:test";
import assert from "node:assert/strict";
import { buildGrid, summarize } from "../src/lib/sheetdash.ts";

const input = {
  today: "2026-11-18",
  computers: [
    { id: "a", name: "Akash", totalFiles: 5 },
    { id: "b", name: "Evan", totalFiles: 0 },
  ],
  files: [
    { id: "f1", computerId: "a", day: "2026-11-18", state: "done", name: "one.mp4" },
    { id: "f2", computerId: "a", day: "2026-11-18", state: "failed", name: "two.mp4", error: "no audio" },
    { id: "f3", computerId: "a", day: "2026-11-17", state: "waiting", name: "three.mp4" },
    { id: "f4", computerId: "b", day: "2026-11-17", state: "done", name: "four.mp4" },
  ],
};

test("summary counts per computer, per day and the failed list", () => {
  const s = summarize(input);
  const akash = s.rows[0];
  // Drive holds 5 files for Akash; 3 were picked up, so 2 more are still waiting.
  assert.deepEqual([akash.recorded, akash.done, akash.failed, akash.waiting, akash.recordedToday], [5, 1, 1, 3, 2]);
  assert.equal(s.rows[1].recorded, 1);
  assert.deepEqual([s.totals.recorded, s.totals.done, s.totals.failed], [6, 2, 1]);
  const today = s.days.at(-1);
  assert.deepEqual([today.day, today.recorded, today.done, today.failed, today.perComputer], ["2026-11-18", 2, 1, 1, [2, 0]]);
  assert.equal(s.days.length, 14);
  assert.deepEqual(s.failedFiles.map((f) => [f.computer, f.name, f.error]), [["Akash", "two.mp4", "no audio"]]);
});

test("the grid has a section for every table and escapes file names in links", () => {
  const s = summarize({ ...input, files: [...input.files, { id: "f5", computerId: "b", day: "2026-11-18", state: "failed", name: 'a "quoted".mp4' }] });
  const { grid, computerHeader, dayHeader } = buildGrid(s, "2026-11-18 23:50");
  assert.ok(computerHeader > 20 && dayHeader > computerHeader);
  const formulas = grid.flat().map((c) => c.userEnteredValue?.formulaValue).filter(Boolean);
  assert.ok(formulas.some((f) => f.includes('a ""quoted"".mp4')));
});
