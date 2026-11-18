import test from "node:test";
import assert from "node:assert/strict";
import { MP3_SLACK, buildPart, findMp3Frame, mp3Header, planParts, probeAudio, wavFile, UnsupportedAudioError } from "../src/lib/audiosplit.ts";

/** A minimal PCM WAV: 16 bit mono at `rate`, `seconds` long, sample values counting up. */
function makeWav(rate, seconds, extraChunk = false) {
  const samples = rate * seconds;
  const pcm = new Uint8Array(samples * 2);
  new DataView(pcm.buffer).setInt16(0, 1, true);
  const format = { audioFormat: 1, channels: 1, sampleRate: rate, bitsPerSample: 16, blockAlign: 2 };
  const plain = wavFile(format, pcm);
  if (!extraChunk) return plain;
  // Insert a LIST chunk before "data".
  const list = new Uint8Array(8 + 6);
  list.set([76, 73, 83, 84], 0);
  new DataView(list.buffer).setUint32(4, 6, true);
  const out = new Uint8Array(plain.length + list.length);
  out.set(plain.subarray(0, 36), 0);
  out.set(list, 36);
  out.set(plain.subarray(36), 36 + list.length);
  return out;
}

/** CBR MPEG1 Layer III, 128 kbit/s, 44.1 kHz: frames are 417 or 418 bytes. Each frame holds its index in byte 10. */
function makeMp3(frames, id3 = true) {
  const parts = [];
  if (id3) {
    const tag = new Uint8Array(10 + 20);
    tag.set([73, 68, 51, 3, 0, 0, 0, 0, 0, 20], 0);
    parts.push(tag);
  }
  for (let i = 0; i < frames; i++) {
    const padding = i % 2;
    const frame = new Uint8Array(417 + padding);
    frame.set([0xff, 0xfb, 0x90 | (padding << 1), 0x00], 0);
    frame[10] = i & 0xff;
    parts.push(frame);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

test("reads a WAV header and its length, even with an extra chunk before the data", () => {
  for (const extra of [false, true]) {
    const wav = makeWav(16000, 10, extra);
    const info = probeAudio(wav.subarray(0, 1000), wav.length);
    assert.equal(info.kind, "wav");
    assert.equal(info.duration, 10);
    assert.equal(info.wav.sampleRate, 16000);
    assert.equal(info.dataEnd, wav.length);
  }
});

test("a WAV with a wrong data size uses the real file size", () => {
  const wav = makeWav(8000, 4);
  new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
  assert.equal(probeAudio(wav, wav.length).duration, 4);
});

test("WAV parts are cut on sample boundaries and get their own header", () => {
  const wav = makeWav(16000, 20);
  const info = probeAudio(wav, wav.length);
  const parts = planParts(info, 32000 * 6, 6);
  assert.equal(parts.length, 4);
  assert.equal(parts[0].duration, 6);
  assert.ok(parts.every((p) => (p.end - p.start) % 2 === 0));
  assert.equal(parts.reduce((n, p) => n + p.duration, 0), 20);
  const last = parts[parts.length - 1];
  const piece = buildPart(info, last, wav.subarray(last.start, last.end), true);
  assert.equal(piece.mimeType, "audio/wav");
  assert.equal(piece.data.length, 44 + last.end - last.start);
  assert.equal(String.fromCharCode(...piece.data.subarray(0, 4)), "RIFF");
});

test("rejects compressed WAV and files that are not audio", () => {
  const wav = makeWav(8000, 1);
  new DataView(wav.buffer).setUint16(20, 85, true); // MP3 inside WAV
  assert.throws(() => probeAudio(wav, wav.length), UnsupportedAudioError);
  const junk = new Uint8Array(5000).fill(7);
  assert.throws(() => probeAudio(junk, junk.length), UnsupportedAudioError);
});

test("reads MP3 length and skips the ID3 tag", () => {
  const mp3 = makeMp3(400);
  const info = probeAudio(mp3.subarray(0, 8000), mp3.length);
  assert.equal(info.kind, "mp3");
  assert.equal(info.dataStart, 30);
  // 400 frames of 1152 samples at 44.1 kHz = 10.45 seconds.
  assert.ok(Math.abs(info.duration - 10.45) < 0.1, String(info.duration));
  assert.equal(mp3Header(mp3, 30).bitrate, 128000);
});

test("MP3 parts meet exactly: no frame is lost or repeated", () => {
  const mp3 = makeMp3(400);
  const info = probeAudio(mp3.subarray(0, 8000), mp3.length);
  const parts = planParts(info, 20000, 100);
  assert.ok(parts.length > 5);
  const seen = [];
  parts.forEach((part, i) => {
    const isLast = i === parts.length - 1;
    const fetched = mp3.subarray(part.start, Math.min(part.end + (isLast ? 0 : MP3_SLACK), info.dataEnd));
    const { data, mimeType } = buildPart(info, part, fetched, isLast);
    assert.equal(mimeType, "audio/mpeg");
    assert.equal(data[0], 0xff);
    for (let at = 0; at < data.length; ) {
      const header = mp3Header(data, at);
      if (!header) break;
      seen.push(data[at + 10]);
      at += header.frameLength;
    }
  });
  assert.deepEqual(seen, Array.from({ length: 400 }, (_, i) => i & 0xff));
});

test("findMp3Frame ignores random 0xFF bytes", () => {
  const bytes = new Uint8Array([1, 0xff, 0xff, 5, 6, ...makeMp3(3, false)]);
  assert.equal(findMp3Frame(bytes, 0), 5);
});

test("a tiny tail is merged into the previous part", () => {
  const wav = makeWav(8000, 10);
  const info = probeAudio(wav, wav.length);
  const parts = planParts(info, 16000 * 5 + 100, 5);
  assert.equal(parts.length, 2);
  assert.equal(parts[1].end, info.dataEnd);
});
