/**
 * Shayari mode: Urdu / Hindi poetry written phonetically in Bengali letters
 * and in simple English (Roman) letters, plus a Bangla meaning.
 *
 * Shared by the server (one audio piece) and the browser (joining pieces).
 */
export interface ShayariSections {
  bangla: string;
  english: string;
  meaning: string;
}

export const SHAYARI_HEADINGS: Record<keyof ShayariSections, string> = {
  bangla: "বাংলা অক্ষরে উচ্চারণ",
  english: "English letters (pronunciation)",
  meaning: "বাংলা অনুবাদ (অর্থ)",
};

const ORDER: (keyof ShayariSections)[] = ["bangla", "english", "meaning"];

function tidy(text: unknown): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanShayari(value: any): ShayariSections {
  return { bangla: tidy(value?.bangla), english: tidy(value?.english), meaning: tidy(value?.meaning) };
}

export function isEmptyShayari(s: ShayariSections): boolean {
  return !s.bangla && !s.english && !s.meaning;
}

/** Join the sections of several audio pieces, keeping each section together. */
export function mergeShayari(parts: (ShayariSections | null | undefined)[]): ShayariSections {
  const merged: ShayariSections = { bangla: "", english: "", meaning: "" };
  for (const key of ORDER) {
    merged[key] = parts
      .map((p) => (p ? tidy(p[key]) : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return merged;
}

/** The plain-text transcript shown, copied, saved and downloaded. */
export function formatShayari(s: ShayariSections): string {
  if (isEmptyShayari(s)) return "";
  return ORDER.filter((key) => s[key])
    .map((key) => `${SHAYARI_HEADINGS[key]}\n${"─".repeat(24)}\n${s[key]}`)
    .join("\n\n\n");
}
