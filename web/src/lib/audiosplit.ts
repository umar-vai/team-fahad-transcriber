/**
 * Splits MP3 and WAV files into small pieces without ffmpeg (so no container is needed).
 *
 * Both formats can be cut by bytes:
 *  - WAV: PCM samples are cut on a sample boundary and given a fresh 44 byte header.
 *  - MP3: every frame decodes on its own, so a cut at a frame boundary is a valid MP3.
 *
 * The caller reads only the byte range of one piece from Google Drive (HTTP Range),
 * so a long recording never has to be held in memory as a whole.
 */

export interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
}

export interface AudioInfo {
  kind: "mp3" | "wav";
  /** First byte of the audio data (after tags or the WAV header). */
  dataStart: number;
  /** One past the last byte of the audio data. */
  dataEnd: number;
  /** Length in seconds. For variable bit rate MP3 the times inside it are approximate. */
  duration: number;
  bytesPerSec: number;
  wav?: WavFormat;
}

export interface PartPlan {
  index: number;
  /** Seconds from the start of the file. */
  offset: number;
  duration: number;
  /** Byte range [start, end) in the file. */
  start: number;
  end: number;
}

export class UnsupportedAudioError extends Error {}

/** Keeps one Gemini request well under its 20 MB limit (base64 adds a third). */
export const MAX_PART_BYTES = 10 * 1024 * 1024;
export const TARGET_PART_SECONDS = 300;
/** How many bytes from the start of the file are enough to read the header. */
export const PROBE_BYTES = 128 * 1024;
/** Extra bytes read after a MP3 piece so the cut can move to the next frame boundary. */
export const MP3_SLACK = 4096;

// ---------- Probing ----------

export function probeAudio(head: Uint8Array, totalSize: number): AudioInfo {
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return probeWav(head, totalSize);
  return probeMp3(head, totalSize);
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let out = "";
  for (let i = at; i < at + len && i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
}

function probeWav(head: Uint8Array, totalSize: number): AudioInfo {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let pos = 12;
  let fmt: WavFormat | null = null;
  while (pos + 8 <= head.length) {
    const id = ascii(head, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= head.length) {
      let audioFormat = view.getUint16(body, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is PCM for 8 to 32 bit integers.
      if (audioFormat === 0xfffe) audioFormat = 1;
      fmt = {
        audioFormat,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample,
      };
    } else if (id === "data") {
      if (!fmt) throw new UnsupportedAudioError("This WAV file is damaged (no format information).");
      if (!fmt.blockAlign || !fmt.sampleRate) throw new UnsupportedAudioError("This WAV file is damaged.");
      if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
        throw new UnsupportedAudioError("This WAV file uses a compressed format. Only normal (PCM) WAV files are supported.");
      }
      // Streamed or unfinished files can have a wrong data size; trust the real file size.
      let dataSize = size;
      if (!dataSize || dataSize === 0xffffffff || body + dataSize > totalSize) dataSize = totalSize - body;
      dataSize -= dataSize % fmt.blockAlign;
      if (dataSize <= 0) throw new UnsupportedAudioError("This WAV file has no audio in it.");
      const bytesPerSec = fmt.sampleRate * fmt.blockAlign;
      return { kind: "wav", dataStart: body, dataEnd: body + dataSize, duration: dataSize / bytesPerSec, bytesPerSec, wav: fmt };
    }
    pos = body + size + (size % 2);
  }
  throw new UnsupportedAudioError("Could not find the audio in this WAV file.");
}

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Mp3Header {
  frameLength: number;
  bitrate: number;
  sampleRate: number;
  samplesPerFrame: number;
  mono: boolean;
  mpeg1: boolean;
}

/** Reads a Layer III frame header at `i`, or null when there is none. */
export function mp3Header(b: Uint8Array, i: number): Mp3Header | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
  const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = b[i + 2] >> 4;
  const rateIndex = (b[i + 2] >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] * 1000;
  const sampleRate = MP3_RATES[version][rateIndex];
  const padding = (b[i + 2] >> 1) & 1;
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const frameLength = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return { frameLength, bitrate, sampleRate, samplesPerFrame, mono: (b[i + 3] >> 6) === 3, mpeg1 };
}

/** First valid frame at or after `from`. A match must be followed by another frame (when the buffer allows). */
export function findMp3Frame(b: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i + 4 <= b.length; i++) {
    if (b[i] !== 0xff) continue;
    const header = mp3Header(b, i);
    if (!header) continue;
    const next = i + header.frameLength;
    if (next + 4 > b.length || mp3Header(b, next)) return i;
  }
  return -1;
}

function probeMp3(head: Uint8Array, totalSize: number): AudioInfo {
  let start = 0;
  // ID3v2 tag at the start: 10 byte header, size as four 7 bit values.
  if (ascii(head, 0, 3) === "ID3" && head.length >= 10) {
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    start = 10 + size + ((head[5] & 0x10) !== 0 ? 10 : 0);
  }
  if (start >= totalSize) throw new UnsupportedAudioError("This file has no audio in it.");
  const at = findMp3Frame(head, start);
  if (at < 0) throw new UnsupportedAudioError("This file is not a readable MP3 or WAV audio file.");
  const header = mp3Header(head, at)!;

  const dataEnd = totalSize;
  let duration = 0;
  // Variable bit rate files carry their frame count in a Xing, Info or VBRI frame.
  const frame = head.subarray(at, at + Math.min(header.frameLength, 200));
  for (const tag of ["Xing", "Info"]) {
    for (let k = 4; k + 12 <= frame.length; k++) {
      if (ascii(frame, k, 4) === tag) {
        const flags = frame[k + 7];
        if (flags & 1) {
          const frames = ((frame[k + 8] << 24) | (frame[k + 9] << 16) | (frame[k + 10] << 8) | frame[k + 11]) >>> 0;
          if (frames > 0) duration = (frames * header.samplesPerFrame) / header.sampleRate;
        }
        break;
      }
    }
    if (duration) break;
  }
  if (!duration && ascii(frame, 36, 4) === "VBRI" && frame.length >= 54) {
    const frames = ((frame[50] << 24) | (frame[51] << 16) | (frame[52] << 8) | frame[53]) >>> 0;
    if (frames > 0) duration = (frames * header.samplesPerFrame) / header.sampleRate;
  }
  const audioBytes = dataEnd - at;
  if (!duration) duration = (audioBytes * 8) / header.bitrate; // constant bit rate
  if (!(duration > 0)) throw new UnsupportedAudioError("Could not measure the length of this MP3 file.");
  return { kind: "mp3", dataStart: at, dataEnd, duration, bytesPerSec: audioBytes / duration };
}

// ---------- Planning ----------

export function planParts(info: AudioInfo, maxBytes = MAX_PART_BYTES, targetSeconds = TARGET_PART_SECONDS): PartPlan[] {
  const align = info.wav ? info.wav.blockAlign : 1;
  let partBytes = Math.min(Math.floor(targetSeconds * info.bytesPerSec), maxBytes);
  partBytes -= partBytes % align;
  if (partBytes < align) partBytes = align;
  const parts: PartPlan[] = [];
  for (let start = info.dataStart; start < info.dataEnd; start += partBytes) {
    const end = Math.min(start + partBytes, info.dataEnd);
    parts.push({
      index: parts.length,
      offset: (start - info.dataStart) / info.bytesPerSec,
      duration: (end - start) / info.bytesPerSec,
      start,
      end,
    });
  }
  // A tiny tail (under a second) is merged into the part before it.
  if (parts.length > 1 && parts[parts.length - 1].duration < 1) {
    const tail = parts.pop()!;
    const last = parts[parts.length - 1];
    last.end = tail.end;
    last.duration += tail.duration;
  }
  return parts;
}

// ---------- Building one piece ----------

/** Wraps raw PCM bytes in a WAV header. */
export function wavFile(format: WavFormat, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format.audioFormat, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * format.blockAlign, true);
  view.setUint16(32, format.blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  put(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Turns the bytes fetched for one piece into a playable file.
 * For MP3 the bytes must include MP3_SLACK extra bytes after `plan.end`, so the cut moves to the next frame.
 * Both ends use the same rule, so neighbouring pieces meet exactly with nothing lost or repeated.
 */
export function buildPart(info: AudioInfo, plan: PartPlan, fetched: Uint8Array, isLast: boolean): { data: Uint8Array; mimeType: string } {
  if (info.kind === "wav") {
    return { data: wavFile(info.wav!, fetched.subarray(0, plan.end - plan.start)), mimeType: "audio/wav" };
  }
  const length = plan.end - plan.start;
  const startAt = plan.index === 0 ? 0 : Math.max(0, findMp3Frame(fetched, 0));
  const endAt = isLast ? Math.min(fetched.length, length) : findMp3Frame(fetched, length);
  const end = endAt < 0 ? Math.min(fetched.length, length) : endAt;
  return { data: fetched.subarray(startAt, end), mimeType: "audio/mpeg" };
}
