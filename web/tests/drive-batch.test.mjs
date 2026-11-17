import test from "node:test";
import assert from "node:assert/strict";
import { env } from "./stubs/cloudflare-workers.mjs";
import { driveFolderId, parseEmbeddedFolderView } from "../src/lib/drive.ts";
import { notionConfigured, notionPageId, transcriptBlocks } from "../src/lib/notion.ts";
import { safeTabTitle, sheetRow, spreadsheetId } from "../src/lib/sheets.ts";
import { mergePieces } from "../src/lib/segments.ts";

test("reads the folder id from every common Drive folder link", () => {
  assert.equal(driveFolderId("https://drive.google.com/drive/folders/1AbCdEfGhIjK_lm-NO?usp=sharing"), "1AbCdEfGhIjK_lm-NO");
  assert.equal(driveFolderId("https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlmNO"), "1AbCdEfGhIjKlmNO");
  assert.equal(driveFolderId("https://drive.google.com/open?id=1AbCdEfGhIjKlmNO"), "1AbCdEfGhIjKlmNO");
  assert.equal(driveFolderId("https://drive.google.com/file/d/1AbCdEfGhIjKlmNO/view"), null);
  assert.equal(driveFolderId("https://example.com/drive/folders/1AbCdEfGhIjKlmNO"), null);
  assert.equal(driveFolderId("not a link"), null);
});

test("parses Drive's public folder page into files and subfolders", () => {
  const html = `<html><head><title>ক্লাস &amp; Notes - Google Drive</title></head><body>
    <div class="flip-entry" id="entry-FILE111111" tabindex="0"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/FILE111111/view?usp=drive_web" target="_blank"><div class="flip-entry-visual"></div><div class="flip-entry-title">1. Intro.mp4</div></a></div></div>
    <div class="flip-entry" id="entry-FOLDER2222" tabindex="0"><div class="flip-entry-info"><a href="https://drive.google.com/drive/folders/FOLDER2222" target="_blank"><div class="flip-entry-title">Week 2</div></a></div></div>
  </body></html>`;
  const page = parseEmbeddedFolderView(html);
  assert.equal(page.name, "ক্লাস & Notes");
  assert.deepEqual(page.entries, [
    { id: "FILE111111", name: "1. Intro.mp4", folder: false },
    { id: "FOLDER2222", name: "Week 2", folder: true },
  ]);
});

test("accepts a Notion page link or id and only counts as connected with both secrets", () => {
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(notionPageId("https://www.notion.so/team/Transcripts-0123456789abcdef0123456789abcdef?pvs=4"), id);
  assert.equal(notionPageId("0123456789abcdef0123456789abcdef"), id);
  assert.equal(notionPageId(id), id);
  assert.equal(notionPageId("nope"), null);
  env.NOTION_TOKEN = "secret";
  assert.equal(notionConfigured(), false);
  env.NOTION_PARENT_PAGE_ID = id;
  assert.equal(notionConfigured(), true);
});

test("Notion blocks keep every text piece within Notion's 2000 character limit", () => {
  const long = "ক".repeat(4500);
  const blocks = transcriptBlocks(`প্রথম অনুচ্ছেদ\n\n${long}`, [], false);
  assert.equal(blocks.length, 2);
  const pieces = blocks[1].paragraph.rich_text;
  assert.equal(pieces.length, 3);
  assert.ok(pieces.every((p) => p.text.content.length <= 2000));
  assert.equal(pieces.map((p) => p.text.content).join(""), long);
});

test("timed style gives one Notion line per subtitle with time and speaker", () => {
  const blocks = transcriptBlocks("x", [{ start: 65, end: 70, text: "আসসালামু আলাইকুম", speaker: "Speaker 1" }], true);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].paragraph.rich_text.map((p) => p.text.content), ["[01:05] ", "Speaker 1: ", "আসসালামু আলাইকুম"]);
});

test("sheet tab names are valid and unique", () => {
  const taken = new Set(["class: week 1"]);
  assert.equal(safeTabTitle("Class: Week 1", new Set()), "Class Week 1");
  assert.equal(safeTabTitle("a/b?c*[d]", new Set()), "a b c d");
  assert.equal(safeTabTitle("class: week 1", new Set(["class week 1"])), "class week 1 (2)");
  assert.equal(safeTabTitle("", taken), "Folder");
});

test("long transcripts continue in the next cells instead of being cut", () => {
  const transcript = "শ".repeat(100_000);
  const row = sheetRow({ index: 1, title: "t", duration: "10:00", style: "Smart clean", status: "Done", words: 1, driveUrl: "d", notionUrl: "n", transcript });
  assert.equal(row.length, 8 + 3);
  assert.ok(row.slice(8).every((cell) => String(cell).length <= 45_000));
  assert.equal(row.slice(8).join(""), transcript);
});

test("reads the spreadsheet id from a link", () => {
  assert.equal(spreadsheetId("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123/edit#gid=0"), "1AbCdEfGhIjKlMnOpQrStUvWxYz0123");
  assert.equal(spreadsheetId("1AbCdEfGhIjKlMnOpQrStUvWxYz0123"), "1AbCdEfGhIjKlMnOpQrStUvWxYz0123");
  assert.equal(spreadsheetId(""), null);
});

test("parts are joined in time order with shifted subtitle times", () => {
  const merged = mergePieces(
    [
      { offset: 300, duration: 300, transcript: "দ্বিতীয়", segments: [{ start: 2, end: 4, text: "দ্বিতীয়" }] },
      { offset: 0, duration: 300, transcript: "প্রথম", segments: [{ start: 1, end: 3, text: "প্রথম" }] },
    ],
    true,
  );
  assert.equal(merged.transcript, "প্রথম\n\nদ্বিতীয়");
  assert.deepEqual(merged.segments.map((s) => s.start), [1, 302]);
});
