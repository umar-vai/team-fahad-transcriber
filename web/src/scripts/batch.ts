/** Live progress page for one Google Drive folder batch. */
import { clock, download, makeDocx, makeZip, safeName, speakerTranscript, toSrt, toVtt } from "./format";

interface Item {
  index: number;
  name: string;
  title: string;
  status: "queued" | "preparing" | "ready" | "transcribing" | "saving" | "done" | "failed";
  detail: string | null;
  error: string | null;
  parts: number;
  partsDone: number;
  duration: number | null;
  words: number | null;
  historyId: string | null;
  notionUrl: string | null;
  exportError: string | null;
}

interface Batch {
  id: string;
  folderName: string;
  folderUrl: string;
  mode: "smart" | "detailed";
  language: string;
  createdAt: number;
  status: "running" | "done" | "cancelled";
  notion: { configured: boolean; url: string | null; error: string | null };
  sheet: { configured: boolean; url: string | null; error: string | null };
  items: Item[];
}

const POLL_MS = 4000;
const $ = (id: string): any => document.getElementById(id);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function showError(message: string | null): void {
  const box = $("b-error");
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
}

function itemState(item: Item): { text: string; cls: string; fraction: number | null } {
  switch (item.status) {
    case "queued":
      return { text: item.detail || "Waiting", cls: "", fraction: null };
    case "preparing":
    case "ready":
      return { text: item.detail || "Downloading", cls: "", fraction: 0.05 };
    case "transcribing": {
      const fraction = item.parts ? 0.1 + 0.85 * (item.partsDone / item.parts) : 0.1;
      const waiting = /waiting|retrying/i.test(item.detail || "");
      return { text: item.detail || "Transcribing", cls: waiting ? "waiting" : "", fraction };
    }
    case "saving":
      return { text: "Saving to History, Notion and Sheets", cls: "", fraction: 0.97 };
    case "done": {
      const facts = [item.duration ? clock(item.duration) : "", item.words ? `${item.words.toLocaleString()} words` : ""].filter(Boolean).join(" · ");
      return { text: `Done${facts ? ` · ${facts}` : ""}${item.exportError ? ` · Export problem: ${item.exportError}` : ""}`, cls: item.exportError ? "waiting" : "done", fraction: null };
    }
    case "failed":
      return { text: item.error || "Failed", cls: "failed", fraction: null };
  }
}

function itemHtml(item: Item, running: boolean): string {
  const state = itemState(item);
  const active = running && !["queued", "done", "failed"].includes(item.status);
  const actions: string[] = [];
  if (item.historyId) actions.push(`<a class="btn small" href="/history/${item.historyId}">View</a>`);
  if (item.notionUrl && item.status === "done") actions.push(`<a class="btn ghost small" href="${escapeHtml(item.notionUrl)}" target="_blank" rel="noopener">Notion</a>`);
  const bar = active && state.fraction !== null ? `<div class="progress"><div style="width:${Math.round(state.fraction * 100)}%"></div></div>` : "";
  return `<div class="q-item${active ? " active" : ""}">
    <div class="q-head"><span class="q-name"><span class="q-num">${item.index}.</span>${escapeHtml(item.name)}</span><div class="q-actions">${actions.join("")}</div></div>
    <div class="q-state ${state.cls}">${escapeHtml(state.text)}</div>${bar}</div>`;
}

function linkHtml(label: string, url: string): string {
  return `<a class="btn ghost small" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`;
}

let current: Batch | null = null;

function render(batch: Batch): void {
  current = batch;
  const items = batch.items;
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const running = batch.status === "running";
  document.title = `${batch.folderName} · Team Fahad Transcriber`;
  $("b-title").textContent = `📁 ${batch.folderName}`;
  const statusText = running ? "Running" : batch.status === "done" ? "Finished" : "Stopped";
  $("b-chips").innerHTML = [
    `<span class="chip" style="color:${running ? "var(--accent-2)" : batch.status === "done" ? "var(--good)" : "var(--muted)"}">${statusText}</span>`,
    `<span class="chip">${batch.mode === "detailed" ? "Subtitles (timed)" : "Smart clean"}</span>`,
    `<span class="chip">${escapeHtml(batch.language)}</span>`,
  ].join("");
  $("s-done").textContent = String(done);
  $("s-failed").textContent = String(failed);
  $("s-left").textContent = String(items.length - done - failed);
  $("s-total").textContent = String(items.length);
  const active = items.find((i) => !["queued", "done", "failed"].includes(i.status));
  const partial = active ? itemState(active).fraction || 0 : 0;
  ($("b-bar") as HTMLDivElement).style.width = `${Math.round(((done + failed + (running ? partial : 0)) / Math.max(items.length, 1)) * 100)}%`;

  const links = [linkHtml("Google Drive folder", batch.folderUrl)];
  if (batch.notion.url) links.push(linkHtml("Notion page", batch.notion.url));
  if (batch.sheet.url) links.push(linkHtml("Google Sheet tab", batch.sheet.url));
  $("b-links").innerHTML = links.join("");
  const notes: string[] = [];
  if (!batch.notion.configured) notes.push("Notion is not connected yet, so transcripts are only saved to History.");
  else if (batch.notion.error) notes.push(`Notion problem: ${batch.notion.error}`);
  if (!batch.sheet.configured) notes.push("Google Sheets is not connected yet.");
  else if (batch.sheet.error) notes.push(`Google Sheets problem: ${batch.sheet.error}`);
  if (running) notes.push("This runs on the server. You can close this page and come back any time.");
  $("b-note").textContent = notes.join(" ");

  $("b-items").innerHTML = items.map((item) => itemHtml(item, running)).join("");
  $("b-stop").classList.toggle("hidden", !running);
  const canResume = !running && (failed > 0 || batch.status === "cancelled" || items.some((i) => i.exportError));
  $("b-resume").classList.toggle("hidden", !canResume);
  $("b-resume").textContent = batch.status === "cancelled" ? "Continue" : "Retry failed";
  $("b-zip").classList.toggle("hidden", done === 0);
}

async function load(id: string): Promise<Batch | null> {
  const response = await fetch(`/api/batches/${id}`);
  if (response.status === 401) {
    location.href = `/login?next=/batches/${id}`;
    return null;
  }
  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
  return payload as Batch;
}

async function action(id: string, name: "cancel" | "resume"): Promise<void> {
  const response = await fetch(`/api/batches/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: name }),
  });
  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
}

async function downloadAll(button: HTMLButtonElement): Promise<void> {
  if (!current) return;
  const items = current.items.filter((i) => i.status === "done" && i.historyId);
  const files: Record<string, string | Uint8Array> = {};
  const used = new Set<string>();
  button.disabled = true;
  try {
    for (const [n, item] of items.entries()) {
      button.textContent = `Preparing ${n + 1} of ${items.length}…`;
      const response = await fetch(`/api/history/${item.historyId}`);
      if (!response.ok) continue;
      const row: any = await response.json();
      const segments = JSON.parse(row.segments_json || "[]");
      let base = `${String(item.index).padStart(2, "0")}_${safeName(item.title)}`;
      for (let k = 2; used.has(base); k++) base = `${base}_${k}`;
      used.add(base);
      const timed = current.mode === "detailed" && segments.length;
      files[`${base}.txt`] = timed ? speakerTranscript(segments) : row.transcript;
      if (timed) {
        files[`${base}.srt`] = toSrt(segments);
        files[`${base}.vtt`] = toVtt(segments);
      }
      files[`${base}.docx`] = makeDocx(item.title, [["Transcript", timed ? speakerTranscript(segments) : row.transcript]]);
    }
    if (Object.keys(files).length) download(`${safeName(current.folderName)}.zip`, makeZip(files), "application/zip");
  } finally {
    button.disabled = false;
    button.textContent = "Download all (ZIP)";
  }
}

export function initBatchPage(): void {
  const id = String($("batch").dataset.id || "");
  let timer = 0;
  const refresh = async () => {
    window.clearTimeout(timer);
    try {
      const batch = await load(id);
      if (!batch) return;
      showError(null);
      render(batch);
      // Poll only while it runs and the page is visible.
      if (batch.status === "running" && document.visibilityState === "visible") timer = window.setTimeout(refresh, POLL_MS);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
      timer = window.setTimeout(refresh, POLL_MS * 3);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!current || current.status === "running")) void refresh();
  });
  $("b-stop").addEventListener("click", async () => {
    if (!confirm("Stop this folder? Finished videos stay saved. You can continue later.")) return;
    try {
      await action(id, "cancel");
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
    void refresh();
  });
  $("b-resume").addEventListener("click", async () => {
    try {
      await action(id, "resume");
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
    void refresh();
  });
  $("b-zip").addEventListener("click", (e: Event) => downloadAll(e.currentTarget as HTMLButtonElement));
  void refresh();
}
