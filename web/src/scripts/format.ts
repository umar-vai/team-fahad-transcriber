/** Subtitle, text, DOCX and ZIP helpers (run in the browser). */
import { strToU8, zipSync } from "fflate";
import type { ShayariSections } from "../lib/shayari";

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

export interface PieceResult {
  offset: number;
  duration: number;
  transcript: string;
  segments: Segment[];
  shayari?: ShayariSections;
}

export interface Result {
  title: string;
  sourceType: string;
  sourceRef?: string;
  mode: string;
  language: string;
  duration: number | null;
  transcript: string;
  segments: Segment[];
  estimatedTimes: boolean;
  historyId?: string;
  extras: Record<string, string>;
  /** Shayari mode: sections so far, and whether the Bangla meaning is still on its way. */
  shayari?: ShayariSections;
  meaningState?: "loading" | "failed";
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function stamp(seconds: number, comma: boolean): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${comma ? "," : "."}${p(rest, 3)}`;
}

function cueText(segment: Segment): string {
  return segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text;
}

export function toSrt(segments: Segment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${stamp(s.start, true)} --> ${stamp(s.end, true)}\n${cueText(s)}\n`)
    .join("\n");
}

export function toVtt(segments: Segment[]): string {
  return "WEBVTT\n\n" + segments.map((s) => `${stamp(s.start, false)} --> ${stamp(s.end, false)}\n${cueText(s)}\n`).join("\n");
}

export function speakerTranscript(segments: Segment[]): string {
  return segments.map((s) => `[${clock(s.start)}] ${s.speaker ? s.speaker + ": " : ""}${s.text}`).join("\n");
}

/** Spread sentences over a piece's duration when the model gave no timings. */
export function estimateSegments(text: string, duration: number, offset = 0): Segment[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || duration <= 0) return [];
  const sentences = (clean.match(/[^.!?।৷؟]+[.!?।৷؟]*["')\]]*\s*/g) || [clean]).map((s) => s.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= 90) {
      pieces.push(sentence);
      continue;
    }
    let current = "";
    for (const word of sentence.split(" ")) {
      if ((current + " " + word).trim().length > 80 && current) {
        pieces.push(current.trim());
        current = word;
      } else current += " " + word;
    }
    if (current.trim()) pieces.push(current.trim());
  }
  const total = pieces.reduce((sum, p) => sum + p.length, 0) || 1;
  let cursor = offset;
  return pieces.map((piece) => {
    const length = (piece.length / total) * duration;
    const segment = { start: cursor, end: cursor + Math.max(0.6, length), text: piece };
    cursor += length;
    return segment;
  });
}

export function mergePieces(pieces: PieceResult[], detailed: boolean): { transcript: string; segments: Segment[]; estimated: boolean } {
  const ordered = [...pieces].sort((a, b) => a.offset - b.offset);
  const transcript = ordered.map((p) => p.transcript.trim()).filter(Boolean).join("\n\n");
  let estimated = false;
  const segments: Segment[] = [];
  for (const piece of ordered) {
    if (detailed && piece.segments.length) {
      for (const s of piece.segments) segments.push({ ...s, start: s.start + piece.offset, end: s.end + piece.offset });
    } else if (piece.transcript.trim()) {
      estimated = true;
      segments.push(...estimateSegments(piece.transcript, piece.duration, piece.offset));
    }
  }
  return { transcript, segments, estimated };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/** A small, valid Word document with a title and sections. */
export function makeDocx(title: string, sections: [string, string][]): Uint8Array {
  const para = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  let body = para(title, "Title");
  for (const [heading, text] of sections) {
    if (!text) continue;
    body += para(heading, "Heading1");
    for (const line of text.split("\n")) body += para(line);
  }
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Nirmala UI"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  };
  return zipSync(files);
}

export function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) entries[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(entries);
}

export function safeName(name: string): string {
  return (name || "transcript").replace(/\.[^.]{1,5}$/, "").replace(/[^\p{L}\p{N}_ -]+/gu, "_").trim().slice(0, 80) || "transcript";
}

export function download(name: string, data: string | Uint8Array, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
