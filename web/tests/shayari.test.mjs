import test from "node:test";
import assert from "node:assert/strict";
import { cleanShayari, formatShayari, mergeShayari, SHAYARI_HEADINGS } from "../src/lib/shayari.ts";

const first = {
  bangla: "দিল-এ-নাদাঁ তুঝে হুয়া ক্যা হ্যায়\nআখির ইস দর্দ কি দাওয়া ক্যা হ্যায়",
  english: "dil-e-naadaan tujhe hua kya hai\naakhir is dard ki dawa kya hai",
  meaning: "হে অবুঝ মন, তোমার কী হয়েছে\nশেষ পর্যন্ত এই ব্যথার ওষুধ কী",
};

test("formats the three sections in order with headings", () => {
  const text = formatShayari(first);
  const b = text.indexOf(SHAYARI_HEADINGS.bangla);
  const e = text.indexOf(SHAYARI_HEADINGS.english);
  const m = text.indexOf(SHAYARI_HEADINGS.meaning);
  assert.ok(b === 0 && b < e && e < m);
  assert.ok(text.includes("dil-e-naadaan tujhe hua kya hai"));
});

test("keeps each section together when joining audio pieces", () => {
  const second = { bangla: "হাম হ্যায় মুশতাক", english: "hum hain mushtaaq", meaning: "আমরা আকুল" };
  const merged = mergeShayari([first, null, second]);
  assert.equal(merged.bangla, `${first.bangla}\n\nহাম হ্যায় মুশতাক`);
  assert.equal(merged.english, `${first.english}\n\nhum hain mushtaaq`);
  const text = formatShayari(merged);
  assert.ok(text.indexOf("হাম হ্যায় মুশতাক") < text.indexOf("dil-e-naadaan"));
});

test("cleans model output and handles empty results", () => {
  const cleaned = cleanShayari({ bangla: "  এক \r\n\n\n\n দুই ", english: null });
  assert.equal(cleaned.bangla, "এক\n\nদুই");
  assert.equal(cleaned.english, "");
  assert.equal(formatShayari(cleanShayari({})), "");
});
