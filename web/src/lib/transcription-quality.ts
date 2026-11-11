/**
 * Conservative script checks for Bangla transcription.
 *
 * These checks do not claim to verify speech against audio. They detect obvious
 * script drift / copied instructions so an unsafe chunk can be retried instead
 * of silently inserted into a long transcript.
 */
interface ScriptCounts {
  bengali: number;
  latin: number;
  arabic: number;
  devanagari: number;
  other: number;
}

function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = { bengali: 0, latin: 0, arabic: 0, devanagari: 0, other: 0 };
  for (const character of text) {
    if (/[\u0985-\u09B9\u09CE\u09DC-\u09DF\u09F0-\u09F1]/u.test(character)) counts.bengali++;
    else if (/[A-Za-z]/.test(character)) counts.latin++;
    else if (/[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FC]/u.test(character)) counts.arabic++;
    else if (/[\u0904-\u0939\u0958-\u0961]/u.test(character)) counts.devanagari++;
    else if (/\p{L}/u.test(character)) counts.other++;
  }
  return counts;
}

export function inferBanglaLanguage(transcript: string): "Bangla (Bangladesh)" | null {
  const c = countScripts(transcript);
  const all = c.bengali + c.latin + c.arabic + c.devanagari + c.other;
  // Require a substantial, mostly Bengali first chunk. Leave genuinely
  // bilingual/uncertain audio in auto-detect mode.
  return c.bengali >= 120 && all > 0 && c.bengali / all >= 0.65
    ? "Bangla (Bangladesh)"
    : null;
}

export function transcriptionQualityIssue(transcript: string, languageCodes: readonly string[]): string | null {
  if (!transcript || /^\s*\[no speech\]\s*$/i.test(transcript)) return null;

  // A prompt echo is not an audio transcription, regardless of the language.
  if (/return only the transcript|if there is no speech, return exactly|language guidance:|do not summarize, translate, invent words/i.test(transcript)) {
    return "The transcription included processing instructions instead of speech.";
  }

  if (!languageCodes.includes("bn-BD")) return null;

  const c = countScripts(transcript);
  const foreign = c.latin + c.arabic + c.devanagari + c.other;
  const total = c.bengali + foreign;
  if (total < 160) return null; // Too little evidence to decide safely.

  // Large runs of fully English paragraphs inside a Bangla recording are the
  // observed failure mode; a few English names and loanwords must stay allowed.
  const longEnglishBlock = transcript.split(/\n\s*\n/).some((paragraph) => {
    const p = countScripts(paragraph);
    return p.latin >= 260 && p.bengali < 45;
  });
  const foreignWritingSystems = c.arabic + c.devanagari + c.other;
  if (
    longEnglishBlock ||
    (foreign >= 180 && c.bengali < 60) ||
    (foreign >= 300 && foreign > c.bengali * 1.25) ||
    (foreignWritingSystems >= 120 && foreignWritingSystems > c.bengali * 0.3)
  ) {
    return "The result unexpectedly changed away from Bangla. Verify the spoken language before accepting it.";
  }
  return null;
}
