/** Browser audio helpers: decode to 16 kHz mono, split at quiet points, encode WAV, live mic. */

export const SAMPLE_RATE = 16000;
export const PIECE_SECONDS = 300;

/** Decode any audio/video file the browser understands into 16 kHz mono samples. */
export async function decodeToMono(file: Blob): Promise<Float32Array> {
  const buffer = await file.arrayBuffer();
  const Ctx: typeof OfflineAudioContext = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const context = new Ctx(1, 1, SAMPLE_RATE);
  const audio = await context.decodeAudioData(buffer);
  if (audio.sampleRate !== SAMPLE_RATE) throw new Error("Browser could not resample this audio.");
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / audio.numberOfChannels;
  }
  return mono;
}

/** Find the quietest 100 ms window between two sample positions. */
function quietestPoint(samples: Float32Array, from: number, to: number): number {
  const windowSize = SAMPLE_RATE / 10;
  let best = to;
  let bestEnergy = Infinity;
  for (let start = Math.max(0, from); start + windowSize <= Math.min(to, samples.length); start += windowSize / 2) {
    let energy = 0;
    for (let i = start; i < start + windowSize; i += 4) energy += samples[i] * samples[i];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start + windowSize / 2;
    }
  }
  return Math.floor(best);
}

export interface Piece {
  offset: number;
  duration: number;
  samples: Float32Array;
}

/** Split into pieces of about PIECE_SECONDS, cutting in a pause near each boundary. */
export function splitIntoPieces(samples: Float32Array, pieceSeconds = PIECE_SECONDS): Piece[] {
  const pieces: Piece[] = [];
  const target = pieceSeconds * SAMPLE_RATE;
  let start = 0;
  while (start < samples.length) {
    let end = Math.min(samples.length, start + target);
    if (samples.length - end > SAMPLE_RATE * 20) {
      end = quietestPoint(samples, end - SAMPLE_RATE * 12, end);
    } else {
      end = samples.length; // Avoid a tiny last piece.
    }
    pieces.push({ offset: start / SAMPLE_RATE, duration: (end - start) / SAMPLE_RATE, samples: samples.subarray(start, end) });
    start = end;
  }
  return pieces;
}

export function hasSound(samples: Float32Array): boolean {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 8) peak = Math.max(peak, Math.abs(samples[i]));
  return peak > 0.01;
}

export function encodeWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) this.port.postMessage(input[0].slice(0));
    return true;
  }
}
registerProcessor("tf-tap", Tap);
`;

/**
 * Live microphone capture. Emits a piece of audio each time the speaker pauses
 * (after at least `minSeconds`), or after `maxSeconds` at the latest.
 */
export class LiveRecorder {
  private context?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private pending: Float32Array[] = [];
  private pendingLength = 0;
  private quietRun = 0;
  private totalSamples = 0;
  private pieceStart = 0;
  level = 0;

  constructor(
    private onPiece: (piece: Piece) => void,
    private minSeconds = 6,
    private maxSeconds = 15,
  ) {}

  get elapsed(): number {
    return this.totalSamples / SAMPLE_RATE;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.context = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "tf-tap");
    const ratio = this.context.sampleRate / SAMPLE_RATE;
    // Fractional read position into the incoming stream, kept across buffers.
    let position = 0;
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const input = event.data;
      const out: number[] = [];
      let peak = 0;
      while (position < input.length) {
        const value = input[Math.floor(position)];
        out.push(value);
        peak = Math.max(peak, Math.abs(value));
        position += ratio;
      }
      position -= input.length;
      this.level = peak;
      this.push(Float32Array.from(out), peak);
    };
    source.connect(this.node);
  }

  private push(samples: Float32Array, peak: number): void {
    this.pending.push(samples);
    this.pendingLength += samples.length;
    this.totalSamples += samples.length;
    this.quietRun = peak < 0.02 ? this.quietRun + samples.length : 0;
    const seconds = this.pendingLength / SAMPLE_RATE;
    if ((seconds >= this.minSeconds && this.quietRun > SAMPLE_RATE * 0.45) || seconds >= this.maxSeconds) this.flush();
  }

  flush(): void {
    if (!this.pendingLength) return;
    const samples = new Float32Array(this.pendingLength);
    let position = 0;
    for (const part of this.pending) {
      samples.set(part, position);
      position += part.length;
    }
    const piece = { offset: this.pieceStart, duration: samples.length / SAMPLE_RATE, samples };
    this.pieceStart += piece.duration;
    this.pending = [];
    this.pendingLength = 0;
    this.quietRun = 0;
    this.onPiece(piece);
  }

  async stop(): Promise<void> {
    this.flush();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close().catch(() => {});
  }
}
