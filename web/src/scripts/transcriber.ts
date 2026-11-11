/** Main page controller: files, links and live voice. */
import { decodeToMono, encodeWav, hasSound, LiveRecorder, PIECE_SECONDS, splitIntoPieces, type Piece } from "./audio";
import { makeDocx, makeZip, download, mergePieces, safeName, speakerTranscript, toSrt, toVtt, type PieceResult, type Result, type Segment } from "./format";
import { initResults, showResult } from "./results";
import { inferBanglaLanguage } from "../lib/transcription-quality";

const PARALLEL = 4;
const BROWSER_DECODE_LIMIT = 300 * 1024 * 1024;
const UPLOAD_PIECE = 50 * 1024 * 1024;

const $ = (id: string): any => document.getElementById(id);

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

/** Progress goes to whichever queue item is running. */
let progressSink: (label: string, fraction: number | null, detail: string) => void = () => {};

function setProgress(label: string, fraction: number | null, detail = ""): void {
  progressSink(label, fraction, detail);
}

function showError(message: string): void {
  const box = $("error-box");
  box.textContent = message;
  box.classList.remove("hidden");
}

function clearError(): void {
  $("error-box").classList.add("hidden");
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

/**
 * Auto-detect was causing each parallel chunk to independently choose a script.
 * Recognize the first chunk before starting the rest; once it strongly confirms
 * Bengali speech, pass that hint to every following chunk. Explicit user
 * language selections are never overridden.
 */
async function transcribePieces<T>(
  parts: T[],
  s: Settings,
  work: (part: T, chosen: Settings) => Promise<PieceResult>,
  label = "Transcribing…",
): Promise<PieceResult[]> {
  const total = parts.length;
  const update = (done: number) =>
    setProgress(label, done / Math.max(total, 1), total > 1 ? `${done} of ${total} parts` : "");

  if (s.language !== "Auto detect / mixed language" || total < 2) {
    return runPool(parts.map((part) => () => work(part, s)), update);
  }

  const first = await work(parts[0], s);
  update(1);
  let completed = 1;
  let lockedLanguage = inferBanglaLanguage(first.transcript);

  // If the recording starts with silence, inspect the next spoken piece
  // rather than letting every other piece independently guess its language.
  const initial: PieceResult[] = [first];
  if (!lockedLanguage && !first.transcript.trim() && total > 2) {
    const second = await work(parts[1], s);
    initial.push(second);
    completed = 2;
    update(completed);
    lockedLanguage = inferBanglaLanguage(second.transcript);
  }

  const chosen = lockedLanguage ? { ...s, language: lockedLanguage } : s;
  const remaining = await runPool(
    parts.slice(completed).map((part) => () => work(part, chosen)),
    (done) => update(completed + done),
  );
  return [...initial, ...remaining];
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
): Promise<Result> {
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
  if (!result.transcript.trim()) return result;
  try {
    const saved = await postJson("/api/history", { ...result, segments: result.segments });
    result.historyId = saved.id;
  } catch (error) {
    console.warn("Could not save to history", error);
  }
  return result;
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

function releaseJob(job: string): void {
  fetch(`/api/media/release?job=${job}`, { method: "POST", keepalive: true }).catch(() => {});
}

async function transcribeJob(job: string, s: Settings, meta: { sourceType: string; sourceRef?: string; fallbackTitle: string }): Promise<Result> {
  try {
    return await transcribeJobInner(job, s, meta);
  } finally {
    releaseJob(job);
  }
}

async function transcribeJobInner(job: string, s: Settings, meta: { sourceType: string; sourceRef?: string; fallbackTitle: string }): Promise<Result> {
  const state = await waitForJob(job, "Preparing");
  setProgress("Transcribing…", 0, `0 of ${state.parts.length} parts`);
  const results = await transcribePieces(state.parts, s, async (part, chosen): Promise<PieceResult> => {
    const payload = await withRetry(() => postJson("/api/transcribe", { source: "job", job, part: part.index, duration: part.duration, ...chosen }));
    return { offset: part.offset, duration: part.duration, transcript: payload.transcript || "", segments: payload.segments || [] };
  });
  return finish(results, { title: state.title || meta.fallbackTitle, sourceType: meta.sourceType, sourceRef: meta.sourceRef, duration: state.duration }, s);
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

async function transcribeFile(file: File, s: Settings): Promise<Result> {
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
    return transcribeJob(job, s, { ...meta, fallbackTitle: meta.title });
  }
  const duration = samples.length / 16000;
  const pieces = splitIntoPieces(samples, PIECE_SECONDS);
  samples = null;
  setProgress("Transcribing…", 0, `0 of ${pieces.length} parts`);
  const results = await transcribePieces(pieces, s, transcribeWav);
  return finish(results, { ...meta, duration }, s);
}

async function transcribeLink(url: string, s: Settings): Promise<Result> {
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
      const results = await transcribePieces(ranges, s, async (range, chosen): Promise<PieceResult> => {
        const payload = await withRetry(() => postJson("/api/transcribe", { source: "youtube", url: info.url, ...range, ...chosen }), 2);
        const start = range.start ?? 0;
        return { offset: start, duration: (range.end ?? duration ?? 0) - start, transcript: payload.transcript || "", segments: payload.segments || [] };
      }, "Transcribing YouTube video…");
      return await finish(results, { title: info.title, sourceType: "youtube", sourceRef: info.url, duration }, s);
    } catch (error) {
      console.info("Direct YouTube transcription failed; downloading instead.", error);
      setProgress("Downloading the video instead…", null);
      const job = await postJson("/api/media/link", { url, forceDownload: true });
      return transcribeJob(job.job, s, { sourceType: "youtube", sourceRef: url, fallbackTitle: info.title });
    }
  }
  return transcribeJob(info.job, s, { sourceType: "link", sourceRef: url, fallbackTitle: "Linked media" });
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
    let detectedLiveLanguage: string | null = null;
    liveResults = [];
    livePending = [];
    recorder = new LiveRecorder((piece) => {
      const chosen = detectedLiveLanguage ? { ...liveSettings, language: detectedLiveLanguage } : liveSettings;
      const task = withRetry(() => transcribeWav(piece, chosen))
        .then((result) => {
          if (liveSettings.language === "Auto detect / mixed language" && !detectedLiveLanguage) {
            detectedLiveLanguage = inferBanglaLanguage(result.transcript);
          }
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
    refreshButtons();
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
  refreshButtons();
  const s = settings();
  const stamp = new Date().toLocaleString();
  const result = await finish(liveResults, { title: `Live voice ${stamp}`, sourceType: "live", duration: active.elapsed, mode: s.mode === "smart" ? "smart" : "verbatim" }, s);
  viewResult(result);
  if (!result.transcript.trim()) showError("No speech was found in this recording.");
}

// ---------- Batch queue ----------

interface QueueItem {
  id: number;
  kind: "file" | "link";
  name: string;
  file?: File;
  url?: string;
  settings: Settings;
  state: "queued" | "running" | "done" | "failed";
  label: string;
  fraction: number | null;
  detail: string;
  error?: string;
  result?: Result;
}

const queue: QueueItem[] = [];
let queueRunning = false;
let nextId = 1;
let pendingFiles: File[] = [];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function viewResult(result: Result): void {
  showResult(result);
  document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function refreshButtons(): void {
  ($("upload-go") as HTMLButtonElement).disabled = pendingFiles.length === 0 || !!recorder;
  ($("link-go") as HTMLButtonElement).disabled = !!recorder;
  ($("live-go") as HTMLButtonElement).disabled = queueRunning && !recorder;
}

function itemHtml(item: QueueItem): string {
  const stateText =
    item.state === "queued" ? "Waiting" : item.state === "running" ? `${item.label}${item.detail ? ` · ${item.detail}` : ""}` : item.state === "done" ? "Done" : item.error || "Failed";
  const actions: string[] = [];
  if (item.state === "done") actions.push(`<button class="btn small" data-act="view" data-id="${item.id}" type="button">View</button>`);
  if (item.state === "failed") actions.push(`<button class="btn ghost small" data-act="retry" data-id="${item.id}" type="button">Retry</button>`);
  if (item.state !== "running") actions.push(`<button class="btn ghost small" data-act="remove" data-id="${item.id}" type="button">Remove</button>`);
  const bar = item.state === "running" ? `<div class="progress"><div style="width:${Math.round(Math.max(0.03, item.fraction ?? 0.05) * 100)}%"></div></div>` : "";
  return `<div class="q-head"><span class="q-name">${escapeHtml(item.name)}</span><div class="q-actions">${actions.join("")}</div></div>
    <div class="q-state ${item.state === "done" ? "done" : item.state === "failed" ? "failed" : ""}">${escapeHtml(stateText)}</div>${bar}`;
}

function renderQueue(): void {
  const list = $("queue-list") as HTMLElement;
  $("queue-card").classList.toggle("hidden", queue.length === 0);
  const present = new Set<string>();
  for (const item of queue) {
    const key = `q-${item.id}`;
    present.add(key);
    let node = document.getElementById(key);
    if (!node) {
      node = document.createElement("div");
      node.id = key;
      list.appendChild(node);
    }
    node.className = `q-item${item.state === "running" ? " active" : ""}`;
    node.innerHTML = itemHtml(item);
  }
  Array.from(list.children).forEach((child) => {
    if (!present.has(child.id)) child.remove();
  });
  const done = queue.filter((i) => i.state === "done").length;
  const failed = queue.filter((i) => i.state === "failed").length;
  $("queue-summary").textContent = `${done} of ${queue.length} done${failed ? `, ${failed} failed` : ""}${queueRunning ? ", working…" : ""}`;
  $("queue-zip").classList.toggle("hidden", done < 2);
  $("queue-clear").classList.toggle("hidden", !queue.some((i) => i.state === "done" || i.state === "failed"));
  refreshButtons();
}

async function runQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  renderQueue();
  try {
    let item: QueueItem | undefined;
    while ((item = queue.find((i) => i.state === "queued"))) {
      const current = item;
      current.state = "running";
      current.label = "Starting…";
      current.fraction = null;
      current.detail = "";
      progressSink = (label, fraction, detail) => {
        current.label = label;
        current.fraction = fraction;
        current.detail = detail;
        renderQueue();
      };
      renderQueue();
      try {
        const result = current.kind === "file" ? await transcribeFile(current.file!, current.settings) : await transcribeLink(current.url!, current.settings);
        if (!result.transcript.trim()) {
          current.state = "failed";
          current.error = "No speech was found in this media.";
        } else {
          current.state = "done";
          current.result = result;
          if (queue.length === 1) viewResult(result);
        }
      } catch (error) {
        current.state = "failed";
        current.error = error instanceof Error ? error.message : String(error);
      }
      current.file = current.state === "done" ? undefined : current.file;
      renderQueue();
    }
  } finally {
    queueRunning = false;
    progressSink = () => {};
    renderQueue();
  }
}

function enqueue(entries: { kind: "file" | "link"; name: string; file?: File; url?: string }[]): void {
  clearError();
  const s = settings();
  for (const entry of entries) queue.push({ id: nextId++, ...entry, settings: s, state: "queued", label: "", fraction: null, detail: "" });
  renderQueue();
  void runQueue();
}

function downloadAll(): void {
  const files: Record<string, string | Uint8Array> = {};
  const used = new Set<string>();
  for (const item of queue) {
    const result = item.result;
    if (item.state !== "done" || !result) continue;
    let base = safeName(result.title);
    for (let n = 2; used.has(base); n++) base = `${safeName(result.title)}_${n}`;
    used.add(base);
    const timed = speakerTranscript(result.segments);
    const extras: [string, string][] = Object.entries(result.extras).map(([k, v]) => [k.startsWith("translate:") ? `Translation (${k.split(":")[1]})` : k, v]);
    files[`${base}/${base}.txt`] = result.transcript;
    files[`${base}/${base}.srt`] = toSrt(result.segments);
    files[`${base}/${base}.vtt`] = toVtt(result.segments);
    files[`${base}/${base}_timestamped.txt`] = timed;
    files[`${base}/${base}.docx`] = makeDocx(result.title, [["Transcript", result.transcript], ["Timestamped transcript", result.mode === "detailed" ? timed : ""], ...extras]);
  }
  if (Object.keys(files).length) download("transcripts.zip", makeZip(files), "application/zip");
}

function chooseFiles(list: FileList | File[] | undefined | null): void {
  const files = Array.from(list || []);
  if (!files.length) return;
  pendingFiles = files;
  const total = files.reduce((sum, f) => sum + f.size, 0) / 1048576;
  $("file-label").textContent = files.length === 1 ? `${files[0].name} (${total.toFixed(1)} MB)` : `${files.length} files selected (${total.toFixed(1)} MB)`;
  refreshButtons();
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
  input.addEventListener("change", () => chooseFiles(input.files));
  const zone = $("dropzone");
  zone.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    zone.classList.remove("drag");
    chooseFiles(e.dataTransfer?.files);
  });
  $("upload-go").addEventListener("click", () => {
    if (!pendingFiles.length) return;
    const files = pendingFiles;
    pendingFiles = [];
    input.value = "";
    $("file-label").textContent = "Drop audio or video files here, or click to choose (you can pick many)";
    enqueue(files.map((file) => ({ kind: "file" as const, name: file.name, file })));
  });
  $("link-go").addEventListener("click", () => {
    const box = $("link") as HTMLTextAreaElement;
    const urls = Array.from(new Set(box.value.split(/\s+/).map((u) => u.trim()).filter(Boolean)));
    if (!urls.length) return showError("Please paste at least one link first.");
    const bad = urls.filter((u) => !/^https?:\/\//i.test(u));
    if (bad.length) return showError(`These do not look like links (they must start with http:// or https://): ${bad.slice(0, 3).join(", ")}`);
    box.value = "";
    enqueue(urls.map((url) => ({ kind: "link" as const, name: url, url })));
  });
  $("queue-list").addEventListener("click", (e: Event) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    if (!button) return;
    const item = queue.find((i) => i.id === Number(button.dataset.id));
    if (!item) return;
    if (button.dataset.act === "view" && item.result) viewResult(item.result);
    if (button.dataset.act === "remove" && item.state !== "running") queue.splice(queue.indexOf(item), 1);
    if (button.dataset.act === "retry" && item.state === "failed" && (item.file || item.url)) {
      item.state = "queued";
      item.error = undefined;
      void runQueue();
    }
    renderQueue();
  });
  $("queue-zip").addEventListener("click", downloadAll);
  $("queue-clear").addEventListener("click", () => {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].state === "done" || queue[i].state === "failed") queue.splice(i, 1);
    renderQueue();
  });
  $("live-go").addEventListener("click", () => toggleLive());
  window.addEventListener("beforeunload", (event) => {
    if (queueRunning || recorder) event.preventDefault();
  });
  refreshButtons();
}

export type { Segment };
