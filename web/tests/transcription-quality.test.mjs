import test from "node:test";
import assert from "node:assert/strict";
import { inferBanglaLanguage, transcriptionQualityIssue } from "../src/lib/transcription-quality.ts";

const bangla = "আজকের আলোচনায় আমরা আমাদের সেবার নিয়ম ও পরবর্তী কার্যক্রম নিয়ে বিস্তারিত কথা বলব। ".repeat(12);

test("locks a genuinely Bengali first chunk to Bangla", () => {
  assert.equal(inferBanglaLanguage(bangla), "Bangla (Bangladesh)");
  assert.equal(inferBanglaLanguage(""), null);
  assert.equal(inferBanglaLanguage("A short English lecture about computer science.".repeat(12)), null);
});

test("preserves Bangla text with short English terms", () => {
  assert.equal(transcriptionQualityIssue(bangla + " PDF, Support Team, Google Drive.", ["bn-BD"]), null);
  assert.equal(transcriptionQualityIssue("[no speech]", ["bn-BD"]), null);
});

test("flags an unexpected all-English transcript for a Bangla recording", () => {
  const english = "This unrelated English lecture is an example of a suspicious transcript. ".repeat(12);
  assert.match(transcriptionQualityIssue(english, ["bn-BD"]) || "", /changed away from Bangla/);
  assert.equal(transcriptionQualityIssue(english, ["en-US"]), null);
});

test("flags lengthy English paragraphs inside Bengali content", () => {
  const english = "This is an entirely unrelated paragraph in English that does not belong in the Bangla meeting recording. ".repeat(5);
  assert.match(transcriptionQualityIssue(bangla + "\n\n" + english, ["bn-BD"]) || "", /changed away from Bangla/);
});

test("flags unexpected Arabic/Urdu-script responses but allows short quotes", () => {
  const arabic = "هذا مثال على نص طويل بلغة غير متوقعة في تسجيل محاضرة بنغالية. ".repeat(20);
  assert.match(transcriptionQualityIssue(arabic, ["bn-BD"]) || "", /changed away from Bangla/);
  assert.equal(transcriptionQualityIssue(bangla + " الحمد لله", ["bn-BD"]), null);
});

test("rejects copied prompt instructions even with auto detect", () => {
  assert.match(transcriptionQualityIssue("Return only the transcript.", []) || "", /processing instructions/);
  assert.equal(transcriptionQualityIssue("Some actual English speech.", []), null);
});
