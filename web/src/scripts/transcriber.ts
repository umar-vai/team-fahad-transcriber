/** Main page controller: files, links and live voice. */
import { decodeToMono, encodeWav, hasSound, LiveRecorder, PIECE_SECONDS, splitIntoPieces, type Piece } from "./audio";
import { mergePieces, type PieceResult, type Result, type Segment } from "./format";
import { initResults, setHistoryId, showResult } from "./results";

const PARALLEL = 4;
const BROWSER_DECODE_LIMIT = 300 * 1024 * 1024;
const UPLOAD_PIECE = 50 * 1024 * 1024;

const $ = (id: string): any => document.getElementById(id);
let busy = false;

interface Settings {
  mode: string;
  language: string;
  vocab: string;
}

function settings(): Settings {
  return {
    mode: ($("mode") as HTMLSelectElement).value,
    language: ($("language") as HTMLSelectElement).value,
    vocab: ($("vocab") as HTMLInputElement).value,
  };
}

function setProgress(label: string, fraction: number | null, detail = ""): void {
  $("progress-card").classList.remove("hidden");
  $("progress-label").textContent = label;
  $("progress-detail").textContent = detail;
  ($("progress-bar") as HTMLDivElement).style.width = `${Math.round(Math.max(0.03, fraction ?? 0.05) * 100)}%`;
}

function hideProgress(): void {
  $("progress-card").classList.add("hidden");
}

function showError(message: string): void {
  const box = $("error-box");
  box.textContent = message;
  box.classList.remove("hidden");
}

function clearError(): void {
  $("error-box").classList.add("hidden");
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ["upload-go", "link-go"]) ($(id) as HTMLButtonElement).disabled = value || (id === "upload-go" && !selectedFile);
  ($("live-go") as HTMLButtonElement).disabled = value && !recorder;
}

class FatalError extends Error {}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = (await response.json().catch(() => ({}))) as any;
  if (response.status === 401) location.href = "/login?next=/";
  if (!response.ok) throw response.status < 500 && response.status !== 429 ? new FatalError(payload.error || `Error ${response.status}`) : new Error(payload.error || `Error ${response.status}`);
  return payload;
}

async function withRetry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (error instanceof FatalError) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (i + 1)));
    }
  }
  throw lastError;
}

/** Run tasks with a fixed number in flight; report progress as they finish. */
async function runPool<T>(tasks: (() => Promise<T>)[], onDone: (done: number) => void): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  let failure: unknown = null;
  async function worker() {
    while (next < tasks.length && !failure) {
      const index = next++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        failure = error;
        return;
      }
      onDone(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, tasks.length) }, worker));
  if (failure) throw failure;
  return results;
}

function query(s: Settings, duration: number): string {
  return new URLSearchParams({ mode: s.mode, language: s.language, vocab: s.vocab, duration: duration.toFixed(2) }).toString();
}

async function transcribeWav(piece: Piece, s: Settings): Promise<PieceResult> {
  if (!hasSound(piece.samples)) return { offset: piece.offset, duration: piece.duration, transcript: "", segments: [] };
  const payload = await withRetry(async () => {
    const response = await fetch(`/api/transcribe?${query(s, piece.duration)}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: encodeWav(piece.samples),
    });
    const data = (await response.json().catch(() => ({}))) as any;
    if (response.status === 401) location.href = "/login?next=/";
    if (!response.ok) {
      throw response.status < 500 && response.status !== 429 ? new FatalError(data.error || `Error ${response.status}`) : new Error(data.error || `Error ${response.status}`);
    }
    return data;
  });
  return { offset: piece.offset, duration: piece.duration, transcript: payload.transcript || "", segments: payload.segments || [] };
}

async function finish(
  pieces: PieceResult[],
  meta: { title: string; sourceType: string; sourceRef?: string; duration: number | null; mode?: string },
  s: Settings,
): Promise<void> {
  const mode = meta.mode || s.mode;
  const merged = mergePieces(pieces, mode === "detailed");
  const result: Result = {
    title: meta.title,
    sourceType: meta.sourceType,
    sourceRef: meta.sourceRef,
    mode,
    language: s.language,
    duration: meta.duration,
    transcript: merged.transcript,
    segments: merged.segments,
    estimatedTimes: merged.estimated,
    extras: {},
  };
  hideProgress();
  showResult(result);
  document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!result.transcript.trim()) {
    showError("No speech was found in this media.");
    return;
  }
  try {
    const saved = await postJson("/api/history", { ...result, segments: result.segments });
    setHistoryId(saved.id);
  } catch (error) {
    console.warn("Could not save to history", error);
  }
}

// ---------- Container jobs (links and large files) ----------

async function waitForJob(job: string, labelPrefix: string): Promise<{ title: string; duration: number; parts: { index: number; offset: number; duration: number }[] }> {
  const started = Date.now();
  const labels: Record<string, string> = {
    starting: "Starting media helper…",
    downloading: "Downloading media…",
    uploading: "Uploading…",
    converting: "Extracting audio…",
  };
  while (true) {
    const response = await fetch(`/api/media/status?job=${job}`);
    const state = (await response.json().catch(() => ({ status: "starting" }))) as any;
    if (state.status === "ready") return state;
    if (state.status === "error") throw new FatalError(state.error || "Could not prepare this media.");
    const seconds = Math.round((Date.now() - started) / 1000);
    setProgress(labels[state.status] || `${labelPrefix}…`, null, `${seconds}s`);
    if (Date.now() - started > 45 * 60_000) throw new FatalError("Preparing the media took too long.");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function transcribeJob(job: string, s: Settings, meta: { sourceType: string; sourceRef?: string; fallbackTitle: string }): Promise<void> {
  const state = await waitForJob(job, "Preparing");
  const total = state.parts.length;
  setProgress("Transcribing…", 0, `0 of ${total} parts`);
  const results = await runPool(
    state.parts.map((part) => async (): Promise<PieceResult> => {
      const payload = await withRetry(() => postJson("/api/transcribe", { source: "job", job, part: part.index, duration: part.duration, ...s }));
      return { offset: part.offset, duration: part.duration, transcript: payload.transcript || "", segments: payload.segments || [] };
    }),
    (done) => setProgress("Transcribing…", done / total, `${done} of ${total} parts`),
  );
  await finish(results, { title: state.title || meta.fallbackTitle, sourceType: meta.sourceType, sourceRef: meta.sourceRef, duration: state.duration }, s);
}

async function uploadToContainer(file: File): Promise<string> {
  const job = crypto.randomUUID();
  const count = Math.max(1, Math.ceil(file.size / UPLOAD_PIECE));
  for (let i = 0; i < count; i++) {
    setProgress("Uploading…", i / count, `${Math.round((i * UPLOAD_PIECE) / 1048576)} of ${Math.round(file.size / 1048576)} MB`);
    const body = file.slice(i * UPLOAD_PIECE, Math.min(file.size, (i + 1) * UPLOAD_PIECE));
    await withRetry(async () => {
      const params = new URLSearchParams({ job, part: String(i), final: i === count - 1 ? "1" : "0", name: file.name });
      const response = await fetch(`/api/media/upload?${params}`, { method: "POST", body, headers: { "content-type": "application/octet-stream" } });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as any;
        throw new Error(data.error || "Upload failed.");
      }
    });
  }
  return job;
}

// ---------- Sources ----------

let selectedFile: File | null = null;

async function transcribeFile(file: File): Promise<void> {
  const s = settings();
  const meta = { title: file.name.replace(/\.[^.]+$/, ""), sourceType: "upload", sourceRef: file.name };
  let samples: Float32Array | null = null;
  if (file.size <= BROWSER_DECODE_LIMIT) {
    setProgress("Reading audio in your browser…", null, `${(file.size / 1048576).toFixed(1)} MB`);
    try {
      samples = await decodeToMono(file);
    } catch (error) {
      console.info("Browser could not decode this file; using the media helper.", error);
    }
  }
  if (!samples) {
    const job = await uploadToContainer(file);
    await transcribeJob(job, s, { ...meta, fallbackTitle: meta.title });
    return;
  }
  const duration = samples.length / 16000;
  const pieces = splitIntoPieces(samples, PIECE_SECONDS);
  samples = null;
  setProgress("Transcribing…", 0, `0 of ${pieces.length} parts`);
  const results = await runPool(
    pieces.map((piece) => () => transcribeWav(piece, s)),
    (done) => setProgress("Transcribing…", done / pieces.length, `${done} of ${pieces.length} parts`),
  );
  await finish(results, { ...meta, duration }, s);
}

async function transcribeLink(url: string): Promise<void> {
  const s = settings();
  setProgress("Checking link…", null);
  const info = await postJson("/api/media/link", { url });
  if (info.kind === "youtube") {
    try {
      const duration: number | null = info.duration;
      const ranges: { start?: number; end?: number }[] = [];
      if (duration && duration > PIECE_SECONDS * 1.5) {
        for (let start = 0; start < duration; start += PIECE_SECONDS) ranges.push({ start, end: Math.min(duration, start + PIECE_SECONDS) });
      } else ranges.push({});
      setProgress("Transcribing YouTube video…", 0, ranges.length > 1 ? `0 of ${ranges.length} parts` : "");
      const results = await runPool(
        ranges.map((range) => async (): Promise<PieceResult> => {
          const payload = await withRetry(() => postJson("/api/transcribe", { source: "youtube", url: info.url, ...range, ...s }), 2);
          const start = range.start ?? 0;
          return { offset: start, duration: (range.end ?? duration ?? 0) - start, transcript: payload.transcript || "", segments: payload.segments || [] };
        }),
        (done) => setProgress("Transcribing YouTube video…", done / ranges.length, ranges.length > 1 ? `${done} of ${ranges.length} parts` : ""),
      );
      await finish(results, { title: info.title, sourceType: "youtube", sourceRef: info.url, duration }, s);
      return;
    } catch (error) {
      console.info("Direct YouTube transcription failed; downloading instead.", error);
      setProgress("Downloading the video instead…", null);
      const job = await postJson("/api/media/link", { url, forceDownload: true });
      await transcribeJob(job.job, s, { sourceType: "youtube", sourceRef: url, fallbackTitle: info.title });
      return;
    }
  }
  await transcribeJob(info.job, s, { sourceType: "link", sourceRef: url, fallbackTitle: "Linked media" });
}

// ---------- Live voice ----------

let recorder: LiveRecorder | null = null;
let liveResults: PieceResult[] = [];
let livePending: Promise<void>[] = [];
let liveTimer = 0;

function renderLive(): void {
  const box = $("live-text");
  box.classList.remove("hidden");
  const text = [...liveResults].sort((a, b) => a.offset - b.offset).map((r) => r.transcript).filter(Boolean).join(" ");
  box.textContent = text || "Listening…";
  box.scrollTop = box.scrollHeight;
}

async function toggleLive(): Promise<void> {
  const button = $("live-go") as HTMLButtonElement;
  if (!recorder) {
    clearError();
    const s = settings();
    const liveSettings = { ...s, mode: s.mode === "detailed" ? "verbatim" : s.mode };
    liveResults = [];
    livePending = [];
    recorder = new LiveRecorder((piece) => {
      const task = withRetry(() => transcribeWav(piece, liveSettings))
        .then((result) => {
          liveResults.push(result);
          renderLive();
        })
        .catch((error) => showError(error instanceof Error ? error.message : String(error)));
      livePending.push(task);
    });
    try {
      await recorder.start();
    } catch (error) {
      recorder = null;
      showError("Microphone access was blocked. Allow the microphone in your browser and try again.");
      return;
    }
    setBusy(true);
    button.textContent = "Stop recording";
    renderLive();
    liveTimer = window.setInterval(() => {
      if (!recorder) return;
      const seconds = Math.floor(recorder.elapsed);
      $("live-state").innerHTML = `<span class="live-dot"></span> Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      ($("live-level") as HTMLDivElement).style.width = `${Math.min(100, recorder.level * 140)}%`;
    }, 150);
    return;
  }
  const active = recorder;
  recorder = null;
  clearInterval(liveTimer);
  button.disabled = true;
  await active.stop();
  $("live-state").textContent = "Finishing…";
  ($("live-level") as HTMLDivElement).style.width = "0";
  await Promise.allSettled(livePending);
  button.disabled = false;
  button.textContent = "Start recording";
  $("live-state").textContent = "";
  setBusy(false);
  const s = settings();
  const stamp = new Date().toLocaleString();
  await finish(liveResults, { title: `Live voice ${stamp}`, sourceType: "live", duration: active.elapsed, mode: s.mode === "smart" ? "smart" : "verbatim" }, s);
}

// ---------- Wiring ----------

async function run(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  clearError();
  setBusy(true);
  try {
    await work();
  } catch (error) {
    hideProgress();
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

function chooseFile(file: File | undefined | null): void {
  if (!file) return;
  selectedFile = file;
  $("file-label").textContent = `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
  ($("upload-go") as HTMLButtonElement).disabled = busy;
}

export function initTranscriber(): void {
  initResults();
  for (const id of ["mode", "language", "vocab"]) {
    const element = $(id) as HTMLInputElement;
    try {
      const saved = localStorage.getItem(`tf:${id}`);
      if (saved !== null) element.value = saved;
    } catch {}
    element.addEventListener("change", () => {
      try {
        localStorage.setItem(`tf:${id}`, element.value);
      } catch {}
    });
  }
  document.querySelectorAll<HTMLButtonElement>("[data-source]").forEach((button) =>
    button.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>("[data-source]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
      document.querySelectorAll<HTMLElement>("[data-source-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.sourcePanel !== button.dataset.source));
    }),
  );
  const input = $("file") as HTMLInputElement;
  input.addEventListener("change", () => chooseFile(input.files?.[0]));
  const zone = $("dropzone");
  zone.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    zone.classList.remove("drag");
    chooseFile(e.dataTransfer?.files?.[0]);
  });
  $("upload-go").addEventListener("click", () => selectedFile && run(() => transcribeFile(selectedFile!)));
  $("link-go").addEventListener("click", () => {
    const url = ($("link") as HTMLInputElement).value.trim();
    if (!url) return showError("Please paste a link first.");
    run(() => transcribeLink(url));
  });
  $("live-go").addEventListener("click", () => toggleLive());
  window.addEventListener("beforeunload", (event) => {
    if (busy) event.preventDefault();
  });
}

export type { Segment };
