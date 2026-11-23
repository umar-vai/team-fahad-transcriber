/**
 * Turns any audio or video file into small pieces for the server: decode once with ffmpeg to 16 kHz mono,
 * cut into pieces of about 5 minutes at the quietest moment near each boundary (the same idea as the website),
 * and compress each piece to MP3 (about 2 MB per 5 minutes) for upload.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpegPath } from "./paths.js";

export const SAMPLE_RATE = 16000;
export const PIECE_SECONDS = 300;
const BYTES_PER_SAMPLE = 2;

export class NoAudioError extends Error {}

function run(args, { input, collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ["pipe", collect ? "pipe" : "ignore", "pipe"], windowsHide: true });
    const out = [];
    let err = "";
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
    });
    if (collect) child.stdout.on("data", (d) => out.push(d));
    child.on("error", (e) => reject(new Error(e.code === "ENOENT" ? "ffmpeg was not found next to the bridge program." : String(e))));
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `ffmpeg exited with ${code}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Decode to a temporary raw file (signed 16 bit, 16 kHz, mono). Returns its path and length in samples. */
export async function decodeToRaw(file) {
  const raw = path.join(os.tmpdir(), `bridge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.raw`);
  try {
    await run(["-v", "error", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-y", raw]);
  } catch (error) {
    fs.rmSync(raw, { force: true });
    if (/does not contain any stream|Output file .* does not contain|Invalid data found|moov atom not found|could not find codec|Error opening input|Invalid argument/i.test(error.message)) {
      throw new NoAudioError(`This file has no readable audio (${error.message.slice(0, 120)}).`);
    }
    throw error;
  }
  const samples = Math.floor(fs.statSync(raw).size / BYTES_PER_SAMPLE);
  if (samples < SAMPLE_RATE / 2) {
    fs.rmSync(raw, { force: true });
    throw new NoAudioError("This file has no audio (shorter than half a second).");
  }
  return { raw, samples };
}

/** Position (in samples) of the quietest 100 ms window between two sample positions. */
export function quietestPoint(buffer, from, to) {
  const windowSize = SAMPLE_RATE / 10;
  let best = to;
  let bestEnergy = Infinity;
  for (let start = from; start + windowSize <= to; start += windowSize / 2) {
    let energy = 0;
    for (let i = start; i < start + windowSize; i += 4) {
      const v = buffer.readInt16LE(i * BYTES_PER_SAMPLE);
      energy += v * v;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start + windowSize / 2;
    }
  }
  return Math.floor(best);
}

/** Plan the pieces: [{index, start, end, offset, duration}] in samples and seconds. */
export function planPieces(rawFile, samples, pieceSeconds = PIECE_SECONDS) {
  const pieces = [];
  const target = pieceSeconds * SAMPLE_RATE;
  const fd = fs.openSync(rawFile, "r");
  try {
    let start = 0;
    while (start < samples) {
      let end = Math.min(samples, start + target);
      if (samples - end > SAMPLE_RATE * 20) {
        const from = Math.max(start, end - SAMPLE_RATE * 12);
        const buffer = Buffer.alloc((end - from) * BYTES_PER_SAMPLE);
        fs.readSync(fd, buffer, 0, buffer.length, from * BYTES_PER_SAMPLE);
        end = from + quietestPoint(buffer, 0, end - from);
      } else {
        end = samples; // Avoid a tiny last piece.
      }
      pieces.push({ index: pieces.length, start, end, offset: start / SAMPLE_RATE, duration: (end - start) / SAMPLE_RATE });
      start = end;
    }
  } finally {
    fs.closeSync(fd);
  }
  return pieces;
}

/** Compress one piece to MP3 (48 kbit/s mono). Falls back to WAV if the MP3 encoder is missing. */
export async function encodePiece(rawFile, piece) {
  const fd = fs.openSync(rawFile, "r");
  let pcm;
  try {
    pcm = Buffer.alloc((piece.end - piece.start) * BYTES_PER_SAMPLE);
    fs.readSync(fd, pcm, 0, pcm.length, piece.start * BYTES_PER_SAMPLE);
  } finally {
    fs.closeSync(fd);
  }
  const inputArgs = ["-v", "error", "-nostdin", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0"];
  try {
    const data = await run([...inputArgs, "-b:a", "48k", "-f", "mp3", "pipe:1"], { input: pcm, collect: true });
    if (data.length) return { data, mimeType: "audio/mpeg" };
  } catch {}
  return { data: wav(pcm), mimeType: "audio/wav" };
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
