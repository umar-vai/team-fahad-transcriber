import {
  clock, download, makeDocx, makeZip, safeName, speakerTranscript, toSrt, toVtt,
  type Result,
} from "./format";

const MODE_LABELS: Record<string, string> = {
  smart: "Smart clean",
  detailed: "Subtitles + speakers",
  verbatim: "Exact verbatim",
  shayari: "Shayari transcribe",
  live: "Live voice",
};
const AI_LABELS: Record<string, string> = {
  summary: "Summary",
  explain: "Explanation",
  content: "Creator content pack",
};

let current: Result | null = null;
const $ = (id: string): any => document.getElementById(id);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function speakerClass(name: string | null | undefined, order: Map<string, number>): string {
  if (!name) return "";
  if (!order.has(name)) order.set(name, order.size);
  return `spk spk-${order.get(name)! % 5}`;
}

function renderTranscript(query = ""): void {
  if (!current) return;
  const view = $("transcript-view");
  const text = current.transcript || "(No speech found)";
  if (!query.trim()) {
    view.textContent = text;
    return;
  }
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  view.innerHTML = escapeHtml(text).replace(pattern, (m) => `<mark>${m}</mark>`);
}

function renderSegments(): void {
  if (!current) return;
  const order = new Map<string, number>();
  const view = $("segments-view");
  view.innerHTML = current.segments.length
    ? current.segments
        .map(
          (s) =>
            `<div class="segment"><time>${clock(s.start)}</time><div>${
              s.speaker ? `<span class="${speakerClass(s.speaker, order)}">${escapeHtml(s.speaker)}</span>` : ""
            }${escapeHtml(s.text)}</div></div>`,
        )
        .join("")
    : `<p class="muted">No subtitle lines.</p>`;
}

function renderAiOutput(): void {
  if (!current) return;
  const box = $("ai-output");
  box.innerHTML = "";
  for (const [key, text] of Object.entries(current.extras)) {
    const label = key.startsWith("translate:") ? `Translation (${key.split(":")[1]})` : AI_LABELS[key] || key;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">${escapeHtml(label)}</h3>
      <div class="row"><button class="btn ghost small" data-copy type="button">Copy</button><button class="btn ghost small" data-save type="button">TXT</button></div></div>
      <div class="transcript"></div>`;
    card.querySelector(".transcript")!.textContent = text;
    card.querySelector("[data-copy]")!.addEventListener("click", () => navigator.clipboard.writeText(text));
    card.querySelector("[data-save]")!.addEventListener("click", () =>
      download(`${safeName(current!.title)}_${key.replace(":", "_")}.txt`, text, "text/plain;charset=utf-8"),
    );
    box.appendChild(card);
  }
}

export function showResult(result: Result): void {
  current = result;
  $("results").classList.remove("hidden");
  $("result-title").textContent = result.title;
  const chips = [MODE_LABELS[result.mode] || result.mode, result.language];
  if (result.duration) chips.push(clock(result.duration));
  chips.push(`${(result.transcript.match(/\S+/g) || []).length} words`);
  $("result-chips").innerHTML = chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join("");
  const note = $("result-note");
  if (result.estimatedTimes && result.segments.length) {
    note.textContent = "Subtitle times are estimated from the text. Use the \"Subtitles + speakers\" mode for timed subtitles.";
    note.classList.remove("hidden");
  } else note.classList.add("hidden");
  setHistoryId(result.historyId);
  renderTranscript(($("find") as HTMLInputElement).value);
  renderSegments();
  renderAiOutput();
}

export function setHistoryId(id?: string): void {
  if (!current) return;
  current.historyId = id;
  const link = $("history-link") as HTMLAnchorElement;
  if (id) {
    link.href = `/history/${id}`;
    link.classList.remove("hidden");
  } else link.classList.add("hidden");
}

function selectTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>("#results [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll<HTMLElement>("#results [data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
}

async function runAi(task: string, button: HTMLButtonElement): Promise<void> {
  if (!current) return;
  const target = ($("translate-target") as HTMLSelectElement).value;
  const key = task === "translate" ? `translate:${target}` : task;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Working…";
  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task, target,
        transcript: current.mode === "detailed" ? speakerTranscript(current.segments) || current.transcript : current.transcript,
        hasTimestamps: current.mode === "detailed" && current.segments.length > 0,
      }),
    });
    const payload = (await response.json()) as any;
    if (!response.ok) throw new Error(payload.error || "AI tool failed.");
    current.extras = { ...current.extras, [key]: payload.text };
    renderAiOutput();
    if (current.historyId) {
      fetch(`/api/history/${current.historyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extras: { [key]: payload.text } }),
      }).catch(() => {});
    }
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function downloadAs(kind: string): void {
  if (!current) return;
  const base = safeName(current.title);
  const timed = speakerTranscript(current.segments);
  if (kind === "txt") download(`${base}.txt`, current.transcript, "text/plain;charset=utf-8");
  if (kind === "srt") download(`${base}.srt`, toSrt(current.segments), "application/x-subrip;charset=utf-8");
  if (kind === "vtt") download(`${base}.vtt`, toVtt(current.segments), "text/vtt;charset=utf-8");
  if (kind === "speakers") download(`${base}_timestamped.txt`, timed, "text/plain;charset=utf-8");
  const extras: [string, string][] = Object.entries(current.extras).map(([k, v]) => [
    k.startsWith("translate:") ? `Translation (${k.split(":")[1]})` : AI_LABELS[k] || k, v,
  ]);
  const docx = () => makeDocx(current!.title, [["Transcript", current!.transcript], ["Timestamped transcript", current!.mode === "detailed" ? timed : ""], ...extras]);
  if (kind === "docx") download(`${base}.docx`, docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  if (kind === "zip") {
    const files: Record<string, string | Uint8Array> = {
      [`${base}.txt`]: current.transcript,
      [`${base}.srt`]: toSrt(current.segments),
      [`${base}.vtt`]: toVtt(current.segments),
      [`${base}_timestamped.txt`]: timed,
      [`${base}.docx`]: docx(),
    };
    for (const [k, v] of Object.entries(current.extras)) files[`${base}_${k.replace(":", "_")}.txt`] = v;
    download(`${base}.zip`, makeZip(files), "application/zip");
  }
}

export function initResults(): void {
  document.querySelectorAll<HTMLButtonElement>("#results [data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab!)));
  document.querySelectorAll<HTMLButtonElement>("#results [data-ai]").forEach((b) => b.addEventListener("click", () => runAi(b.dataset.ai!, b)));
  document.querySelectorAll<HTMLButtonElement>("#results [data-dl]").forEach((b) => b.addEventListener("click", () => downloadAs(b.dataset.dl!)));
  $("find").addEventListener("input", (e: Event) => renderTranscript((e.target as HTMLInputElement).value));
  $("copy-btn").addEventListener("click", async () => {
    if (!current) return;
    await navigator.clipboard.writeText(current.transcript);
    $("copy-btn").textContent = "Copied";
    setTimeout(() => ($("copy-btn").textContent = "Copy text"), 1500);
  });
}
