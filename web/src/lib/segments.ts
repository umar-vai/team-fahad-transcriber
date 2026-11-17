/** Transcript pieces and segments: merging and timing helpers (browser and server). */
import type { ShayariSections } from "./shayari";

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

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
