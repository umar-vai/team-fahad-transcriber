/** Automation page: one team's Bridge PCs, Google Drive automation and transcripts. */
import { icon } from "../lib/icons";

interface Boot {
  team: { id: string; name: string; kind: string; canManage: boolean; role: string; isDefault: boolean };
  tab: string;
  modes: [string, string][];
  languages: string[];
  connected: boolean;
  problem: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (n: unknown) => Number(n || 0).toLocaleString();
const toast = (message: string, kind?: "error") => (window as any).toast?.(message, kind);
const dateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const when = (ms: number | null) => (ms ? dateTime.format(new Date(ms)) : "");
const ago = (ms: number | null) => {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const stat = (label: string, value: unknown, tone = "") => `<div class="stat ${tone}"><span>${esc(label)}</span><strong>${num(value)}</strong></div>`;
const empty = (iconName: string, title: string, text: string, extra = "") =>
  `<div class="empty"><span class="empty-icon">${icon(iconName, "lg")}</span><h3>${esc(title)}</h3><p>${text}</p>${extra}</div>`;

let boot: Boot;

async function call(path: string, method = "GET", body?: unknown) {
  const sep = path.includes("?") ? "&" : "?";
  const response = await fetch(`${path}${sep}workspace=${encodeURIComponent(boot.team.id)}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

function flash(kind: "ok" | "bad", message: string) {
  const box = $(kind === "ok" ? "flash-ok" : "flash-bad");
  box.querySelector("span")!.textContent = message;
  box.classList.toggle("hidden", !message);
}

// ---------- Tabs ----------

const loaded = new Set<string>();
function showTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>("#auto-tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  const url = new URL(location.href);
  url.searchParams.set("team", boot.team.id);
  url.searchParams.set("tab", name);
  url.searchParams.delete("connected");
  url.searchParams.delete("error");
  history.replaceState(null, "", url);
  if (loaded.has(name)) return;
  loaded.add(name);
  if (name === "bridge") loadBridge();
  if (name === "drive") loadDrive();
  if (name === "transcripts") loadTranscripts(true);
}

// ---------- Bridge PCs ----------

let openPc = "";

function pcState(d: any): { online: boolean; html: string } {
  const online = Boolean(d.last_seen_at && Date.now() - d.last_seen_at < 150_000);
  const html = !online ? `<span class="pill bad">Offline</span>`
    : d.current_file ? `<span class="pill work">Transcribing</span>`
    : d.queue_size ? `<span class="pill warn">${num(d.queue_size)} waiting</span>`
    : `<span class="pill good">Online</span>`;
  return { online, html };
}

function renderBridge(data: any) {
  $("bridge-mode").innerHTML = boot.modes.map(([v, l]) => `<option value="${esc(v)}"${v === data.settings.mode ? " selected" : ""}>${esc(l)}</option>`).join("");
  $("bridge-language").innerHTML = boot.languages.map((n) => `<option${n === data.settings.language ? " selected" : ""}>${esc(n)}</option>`).join("");
  $("pin-state").textContent = data.pinSet ? "set (saving replaces it)" : "not set yet";
  const devices: any[] = data.devices || [];
  const online = devices.filter((d) => pcState(d).online).length;
  $("bridge-stats").innerHTML = devices.length
    ? [
        `<div class="stat"><span>PCs online</span><strong>${num(online)}<span class="muted" style="font-size:15px;font-weight:500"> / ${num(devices.length)}</span></strong></div>`,
        stat("Transcribed today", devices.reduce((t, d) => t + Number(d.done_today || 0), 0), "good"),
        stat("Waiting", devices.reduce((t, d) => t + Number(d.queue_size || 0), 0)),
        stat("Failed (all time)", devices.reduce((t, d) => t + Number(d.failed || 0), 0), devices.some((d) => d.failed) ? "bad" : ""),
      ].join("")
    : "";
  $("bridge-updated").textContent = `Updated ${dateTime.format(new Date())}`;
  $("bridge-pcs").innerHTML = devices.length
    ? devices.map((d) => {
        const state = pcState(d);
        return `<div class="pc-card clickable${d.id === openPc ? " selected" : ""}" data-open="${esc(d.id)}" tabindex="0" role="button" aria-label="Details of ${esc(d.name)}">
          <div class="pc-head"><strong>${esc(d.name)}</strong>${state.html}</div>
          <div class="pc-big"><b>${num(d.done_today)}</b><span>transcribed today</span></div>
          <div class="pc-nums">
            <span><b>${num(d.done)}</b>total</span>
            <span><b>${num(d.queue_size)}</b>waiting</span>
            <span class="${d.failed ? "bad" : ""}"><b>${num(d.failed)}</b>failed</span>
          </div>
          <div class="pc-meta">
            ${d.current_file ? `<span class="truncate" title="${esc(d.current_file)}">Now: ${esc(d.current_file)}</span>` : ""}
            ${d.last_error ? `<span class="bad-text truncate" title="${esc(d.last_error)}">${esc(d.last_error)}</span>` : ""}
            <span>Seen ${ago(d.last_seen_at)}${d.version ? ` · v${esc(d.version)}` : ""}</span>
          </div>
        </div>`;
      }).join("")
    : `<div class="card" style="grid-column:1/-1">${empty("monitor", "No PC yet", boot.team.canManage
        ? "Give a PC a name below and press Get pairing code, then type the code in the Bridge app on that PC."
        : "A manager of this team can connect PCs.")}</div>`;
}

function renderPcDetail(data: any) {
  const d = data.device, t = data.totals;
  const state = pcState(d);
  const box = $("pc-detail");
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="card-head">
      <div class="card-title"><span class="icon-box">${icon("monitor")}</span><div><h3>${esc(d.name)}</h3><p>Seen ${ago(d.last_seen_at)}${d.version ? ` · app v${esc(d.version)}` : ""}</p></div></div>
      <div class="row">${state.html}
        ${d.sheet_url ? `<a class="btn ghost small" href="${esc(d.sheet_url)}" target="_blank" rel="noopener">${icon("sheet")}Sheet tab</a>` : ""}
        ${boot.team.canManage ? `<button class="btn danger small" type="button" data-remove="${esc(d.id)}" data-name="${esc(d.name)}">${icon("trash")}Remove</button>` : ""}
        <button class="btn quiet small icon-only" type="button" data-close="1" aria-label="Close">${icon("x")}</button></div>
    </div>
    <div class="card-body stack">
      <div class="stats">${stat("Transcribed", t.done, "good")}${stat("Waiting", d.queue_size)}${stat("Failed", t.failed, t.failed ? "bad" : "")}${stat("Words", t.words)}</div>
      <dl class="kv">
        ${d.watch_folder ? `<dt>Folder</dt><dd>${esc(d.watch_folder)}</dd>` : ""}
        <dt>Google Sheet</dt><dd>${d.sheet_enabled ? (d.sheet_url ? "On" : "On (the tab is made with the first file)") : "Switched off in the app"}</dd>
        ${d.current_file ? `<dt>Now</dt><dd>${esc(d.current_file)}</dd>` : ""}
        ${d.last_error ? `<dt>Last error</dt><dd class="bad-text">${esc(d.last_error)}</dd>` : ""}
      </dl>
      <div class="grid-2">
        <div class="card flush"><div class="card-head"><h3>Per day</h3></div><div class="table-wrap" style="max-height:340px;overflow:auto"><table class="table">
          <thead><tr><th>Day</th><th class="r">Done</th><th class="r">Failed</th><th class="r">Words</th></tr></thead><tbody>
          ${data.days.length ? data.days.map((x: any) => `<tr><td>${esc(x.day)}</td><td class="r num">${num(x.done)}</td><td class="r num ${x.failed ? "bad-text" : ""}">${num(x.failed)}</td><td class="r num">${num(x.words)}</td></tr>`).join("") : `<tr><td colspan="4" class="muted">No file yet.</td></tr>`}
        </tbody></table></div></div>
        <div class="card flush"><div class="card-head"><h3>Latest files</h3><span class="muted small-text">${data.files.length} shown</span></div><div class="table-wrap" style="max-height:340px;overflow:auto"><table class="table">
          <thead><tr><th>File</th><th>Status</th><th class="r">Words</th></tr></thead><tbody>
          ${data.files.length ? data.files.map((f: any) => `<tr><td><div class="truncate" style="max-width:280px" title="${esc(f.name)}">${f.history_id && f.status === "done" ? `<a href="/history/${esc(f.history_id)}">${esc(f.name)}</a>` : esc(f.name)}</div><div class="muted small-text">${esc(f.file_day)} · ${esc(when(f.created_at))}</div>${f.error ? `<div class="bad-text small-text">${esc(f.error)}</div>` : ""}</td>
            <td><span class="pill ${f.status === "done" ? "good" : "bad"}">${f.status === "done" ? "Done" : "Failed"}</span></td><td class="r num">${num(f.words)}</td></tr>`).join("") : `<tr><td colspan="3" class="muted">No file yet.</td></tr>`}
        </tbody></table></div></div>
      </div>
    </div>`;
}

async function loadPc() {
  if (!openPc) {
    $("pc-detail").classList.add("hidden");
    return;
  }
  try {
    renderPcDetail(await call(`/api/bridge/devices?id=${encodeURIComponent(openPc)}`));
  } catch (error) {
    openPc = "";
    $("pc-detail").classList.add("hidden");
    toast((error as Error).message, "error");
  }
}

async function loadBridge() {
  try {
    renderBridge(await call("/api/bridge/devices"));
    await loadPc();
  } catch (error) {
    $("bridge-pcs").innerHTML = `<p class="notice error">${esc((error as Error).message)}</p>`;
  }
}

function initBridge() {
  const open = async (id: string) => {
    openPc = id === openPc ? "" : id;
    await loadBridge();
    if (openPc) $("pc-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  $("bridge-pcs").addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".pc-card[data-open]");
    if (card) open(card.dataset.open || "");
  });
  $("bridge-pcs").addEventListener("keydown", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".pc-card[data-open]");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      open(card.dataset.open || "");
    }
  });
  $("pc-detail").addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("button[data-close]")) {
      openPc = "";
      $("pc-detail").classList.add("hidden");
      loadBridge();
      return;
    }
    const remove = target.closest<HTMLElement>("button[data-remove]");
    if (!remove || !confirm(`Remove ${remove.dataset.name}? It stops sending files until it is paired again. Its transcripts stay.`)) return;
    try {
      await call(`/api/bridge/devices?id=${encodeURIComponent(remove.dataset.remove || "")}`, "DELETE");
      openPc = "";
      toast(`${remove.dataset.name} was removed.`);
      await loadBridge();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });
  $("bridge-add").addEventListener("click", async () => {
    const input = $<HTMLInputElement>("bridge-name");
    const name = input.value.trim();
    const box = $("pairing");
    try {
      const { code, expiresAt } = await call("/api/bridge/devices", "POST", { name });
      box.className = "notice info";
      box.innerHTML = `<div class="stack tight"><span>Pairing code for <b>${esc(name)}</b>. Type it in the Bridge app within ${Math.round((expiresAt - Date.now()) / 60000)} minutes. It works once.</span><span class="pairing-code">${esc(code.slice(0, 4))}-${esc(code.slice(4))}</span></div>`;
      input.value = "";
    } catch (error) {
      box.className = "notice error";
      box.textContent = (error as Error).message;
    }
  });
  $("bridge-pin-save").addEventListener("click", async () => {
    const input = $<HTMLInputElement>("bridge-pin");
    try {
      await call("/api/bridge/devices", "PATCH", { pin: input.value });
      input.value = "";
      toast("PIN saved. Type it in the Bridge app when linking a PC.");
      await loadBridge();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });
  for (const field of ["mode", "language"] as const) {
    $(`bridge-${field}`).addEventListener("change", async (e) => {
      try {
        await call("/api/bridge/devices", "PATCH", { [field]: (e.target as HTMLSelectElement).value });
        toast("Saved. PCs pick up the change within a minute.");
      } catch (error) {
        toast((error as Error).message, "error");
      }
    });
  }
  // Live status while the page is open and visible.
  setInterval(() => {
    if (!document.hidden && !$("bridge-pcs").closest("[data-panel]")!.classList.contains("hidden")) loadBridge();
  }, 20_000);
}

// ---------- Google Drive ----------

type JobTab = "all" | "progress" | "finished" | "failed";
let allJobs: any[] = [];
let jobTab: JobTab = "all";
let jobPc = "";

const phase = (j: any): Exclude<JobTab, "all"> => (j.status === "queued" || j.status === "running" ? "progress" : Number(j.failed_count || 0) > 0 ? "failed" : "finished");
const inTab = (j: any, t: JobTab) => t === "all" || (t === "failed" ? Number(j.failed_count || 0) > 0 : phase(j) === t);

function renderDrive(data: any) {
  const rows: any[] = data.stats || [];
  const accounts: any[] = data.accounts || [];
  const noAccount = !accounts.length;
  $("drive-empty").classList.toggle("hidden", !noAccount);
  if (noAccount) {
    $("drive-empty").innerHTML = empty("cloud", "No Drive account connected", boot.team.canManage
      ? "Connect the Google account whose Drive holds the recordings. It only gets read-only access."
      : "A manager of this team can connect a Drive account.",
      boot.team.canManage ? `<a class="btn small" href="/auth/drive?team=${encodeURIComponent(boot.team.id)}">${icon("plus")}Connect Drive</a>` : "");
  }
  for (const id of ["drive-stats", "drive-computers-wrap", "drive-jobs-wrap"]) $(id).classList.toggle("hidden", noAccount);
  document.querySelectorAll<HTMLElement>("#drive-run, #drive-retry, #drive-dash").forEach((b) => b.toggleAttribute("disabled", noAccount));

  const sum = (key: string) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  $("drive-stats").innerHTML = [
    stat("Computers", rows.length),
    stat("Recordings picked up", sum("picked_up")),
    stat("Transcribed", sum("done"), "good"),
    stat("Waiting", sum("waiting"), sum("waiting") ? "warn" : ""),
    stat("Failed", sum("failed"), sum("failed") ? "bad" : ""),
    stat("Transcribed today", sum("done_today")),
  ].join("");
  $("drive-today").textContent = data.today ? `Today: ${data.today}` : "";
  $("drive-computers").innerHTML = rows.length
    ? rows.map((row) => {
        const total = Number(row.picked_up || 0), ok = Number(row.done || 0), bad = Number(row.failed || 0), left = Number(row.waiting || 0);
        const pct = total ? Math.round((ok / total) * 100) : 0;
        const state = row.scan_error ? `<span class="pill bad">Drive error</span>`
          : row.open_jobs ? `<span class="pill work">Transcribing</span>`
          : left ? `<span class="pill warn">${num(left)} waiting</span>`
          : `<span class="pill good">All done</span>`;
        return `<div class="pc-card">
          <div class="pc-head"><strong title="${esc(row.name)}">${esc(row.name)}</strong>${state}</div>
          <div class="pc-big"><b>${num(ok)}</b><span>of ${num(total)} transcribed</span></div>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="pc-nums"><span><b>${num(left)}</b>waiting</span><span class="${bad ? "bad" : ""}"><b>${num(bad)}</b>failed</span><span><b>${num(row.done_today)}</b>today</span></div>
          <div class="pc-meta">
            ${row.scan_error ? `<span class="bad-text">${esc(row.scan_error)}</span>` : ""}
            ${row.last_scan_at ? `<span>Last scan ${esc(when(row.last_scan_at))}</span>` : ""}
          </div>
        </div>`;
      }).join("")
    : `<div class="card" style="grid-column:1/-1">${empty("monitor", "No computers found yet", "Computers appear after the first scan. Press Scan now, or wait for tonight's run.")}</div>`;
  allJobs = data.jobs || [];
  renderJobs();
  renderAccounts(data);
}

function renderJobs() {
  const scoped = allJobs.filter((j) => !jobPc || j.computer_name === jobPc);
  const tabs: [JobTab, string][] = [["all", "All"], ["progress", "In progress"], ["finished", "Finished"], ["failed", "With failures"]];
  $("job-tabs").innerHTML = tabs
    .map(([key, label]) => `<button type="button" role="tab" data-tab="${key}" aria-selected="${jobTab === key}">${label}<span class="count">${scoped.filter((j) => inTab(j, key)).length}</span></button>`)
    .join("");
  const names = [...new Set(allJobs.map((j) => String(j.computer_name)))].sort((x, y) => x.localeCompare(y));
  $("job-pc").innerHTML = `<option value="">All computers</option>` + names.map((n) => `<option value="${esc(n)}"${n === jobPc ? " selected" : ""}>${esc(n)}</option>`).join("");
  const shown = scoped.filter((j) => inTab(j, jobTab));
  $("job-list").innerHTML = shown.length
    ? shown.map((j) => {
        const total = Number(j.files || 0), ok = Number(j.done_count || 0), bad = Number(j.failed_count || 0);
        const p = phase(j);
        const pill = j.status === "queued" ? `<span class="pill warn">Waiting for a slot</span>`
          : j.status === "running" ? `<span class="pill work">Transcribing</span>`
          : bad ? `<span class="pill bad">${num(bad)} failed</span>`
          : `<span class="pill good">Finished</span>`;
        const pct = total ? Math.round((ok / total) * 100) : 0;
        return `<div class="job ${bad ? "has-bad" : p === "finished" ? "is-done" : "is-run"}">
          <div class="job-top"><div><strong>${esc(j.computer_name)}</strong> <span class="muted small-text">${esc(j.day)}</span></div>${pill}</div>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="job-nums"><span><b>${num(total)}</b> files</span><span><b>${num(ok)}</b> done</span>${bad ? `<span class="bad-text"><b>${num(bad)}</b> failed</span>` : ""}${j.attempts ? `<span>retried ${num(j.attempts)}×</span>` : ""}</div>
          <div class="links">
            ${j.batch_id ? `<a class="btn ghost small" href="/batches/${esc(j.batch_id)}">Details</a>` : ""}
            ${j.sheet_url ? `<a class="btn ghost small" href="${esc(j.sheet_url)}" target="_blank" rel="noopener">${icon("sheet")}Sheet</a>` : ""}
            ${j.notion_url ? `<a class="btn ghost small" href="${esc(j.notion_url)}" target="_blank" rel="noopener">Notion</a>` : ""}
          </div>
        </div>`;
      }).join("")
    : `<p class="muted">No jobs here.</p>`;
}

function renderAccounts(data: any) {
  const accounts: any[] = data.accounts || [];
  const manage = boot.team.canManage;
  const dis = manage ? "" : " disabled";
  const select = (field: string, values: [string, string][], current: string) =>
    `<select data-field="${field}"${dis}>${values.map(([v, l]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  $("drive-accounts").innerHTML = accounts.length
    ? accounts.map((a) => `
      <section class="card flush" data-account="${esc(a.id)}">
        <div class="card-head">
          <div class="card-title"><span class="icon-box">${icon("cloud")}</span><div><h3>${esc(a.email)}</h3><p>${a.enabled ? "Nightly transcription on" : "Paused"}</p></div></div>
          <div class="row">
            ${a.sheetUrl ? `<a class="btn ghost small" href="${esc(a.sheetUrl)}" target="_blank" rel="noopener">${icon("sheet")}Open sheet</a>` : ""}
            ${manage ? `<button class="btn ghost small" type="button" data-act="check">Check folders</button><button class="btn danger small" type="button" data-act="disconnect">Disconnect</button>` : ""}
          </div>
        </div>
        <div class="card-body stack">
          <div class="grid-2">
            <label class="switch"><span>Nightly transcription<small>Scan this Drive every night at 11:50 PM</small></span><input type="checkbox" data-field="enabled"${a.enabled ? " checked" : ""}${dis} /></label>
            ${data.notionAllowed ? `<label class="switch"><span>Also save to Notion<small>Off: Google Sheets only</small></span><input type="checkbox" data-field="notion"${a.notion ? " checked" : ""}${dis} /></label>` : ""}
          </div>
          <div class="grid-2">
            <label>Output style ${select("mode", boot.modes, a.mode)}</label>
            <label>Language ${select("language", boot.languages.map((n) => [n, n]), a.language)}</label>
          </div>
          ${manage ? `
          <div class="input-group">
            <label>Spreadsheet link <span class="hint">${data.teamSheet ? "empty: the team's spreadsheet" : "required for Google Sheets"}</span>
              <input type="text" data-field="spreadsheet" value="${esc(a.spreadsheet)}" placeholder="https://docs.google.com/spreadsheets/d/..." /></label>
            <button class="btn ghost" type="button" data-act="save-sheet">Save</button>
          </div>
          <div class="input-group">
            <label>Extra folders to scan <span class="hint">links or ids, for folders inside other folders or shared with this account</span>
              <input type="text" data-field="extraFolders" value="${esc(a.extraFolders)}" placeholder="https://drive.google.com/drive/folders/..." /></label>
            <button class="btn ghost" type="button" data-act="save-folders">Save</button>
          </div>
          <p class="field-hint">Share the spreadsheet with the service account as Editor.</p>` : ""}
          <p class="small-text muted" data-note></p>
        </div>
      </section>`).join("")
    : "";
}

async function loadDrive(check = "") {
  try {
    const data = await call(check ? `/api/auto?check=1&account=${encodeURIComponent(check)}` : "/api/auto");
    renderDrive(data);
    if (check) {
      const note = document.querySelector<HTMLElement>(`[data-account="${CSS.escape(check)}"] [data-note]`);
      if (note) {
        note.textContent = data.driveError
          ? `Drive error: ${data.driveError}`
          : data.computers?.length
            ? `Found ${data.computers.length} folders: ${data.computers.map((c: any) => c.name).join(", ")}`
            : "No folders were found. If the folder is inside another folder, paste its link under Extra folders.";
      }
    }
  } catch (error) {
    $("drive-empty").classList.remove("hidden");
    $("drive-empty").innerHTML = `<p class="notice error">${esc((error as Error).message)}</p>`;
  }
}

function initDrive() {
  $("job-tabs").addEventListener("click", (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.tab as JobTab | undefined;
    if (key) {
      jobTab = key;
      renderJobs();
    }
  });
  $("job-pc").addEventListener("change", (e) => {
    jobPc = (e.target as HTMLSelectElement).value;
    renderJobs();
  });
  $("drive-accounts").addEventListener("click", async (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-account]");
    if (!button || !card) return;
    const id = card.dataset.account || "";
    const note = card.querySelector<HTMLElement>("[data-note]")!;
    const value = (field: string) => (card.querySelector(`input[data-field="${field}"]`) as HTMLInputElement).value;
    button.disabled = true;
    try {
      switch (button.dataset.act) {
        case "check":
          note.textContent = "Checking Drive…";
          await loadDrive(id);
          break;
        case "save-sheet":
          await call("/api/auto", "PATCH", { account: id, spreadsheet: value("spreadsheet") });
          toast("Spreadsheet saved.");
          await loadDrive();
          break;
        case "save-folders":
          await call("/api/auto", "PATCH", { account: id, extraFolders: value("extraFolders") });
          toast("Folders saved. They are scanned the next time the scan runs.");
          await loadDrive();
          break;
        case "disconnect":
          if (!confirm("Disconnect this Drive account? Finished transcripts stay, waiting files are dropped.")) break;
          await call(`/api/auto?account=${encodeURIComponent(id)}`, "DELETE");
          toast("Drive account disconnected.");
          await loadDrive();
          break;
      }
    } catch (error) {
      note.textContent = (error as Error).message;
      note.classList.add("bad-text");
    } finally {
      button.disabled = false;
    }
  });
  $("drive-accounts").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement | HTMLSelectElement;
    const card = input.closest<HTMLElement>("[data-account]");
    const field = input.dataset.field;
    if (!card || !field || !["enabled", "notion", "mode", "language"].includes(field)) return;
    const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
    try {
      await call("/api/auto", "PATCH", { account: card.dataset.account, [field]: value });
      toast("Saved.");
    } catch (error) {
      toast((error as Error).message, "error");
      loadDrive();
    }
  });
  const action = (id: string, busy: string, run: () => Promise<string>) =>
    $(id).addEventListener("click", async () => {
      const button = $<HTMLButtonElement>(id);
      const label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span>${busy}`;
      try {
        flash("ok", await run());
      } catch (error) {
        flash("bad", (error as Error).message);
      } finally {
        button.disabled = false;
        button.innerHTML = label;
      }
    });
  action("drive-run", "Scanning…", async () => {
    const result = await call("/api/auto", "POST");
    await loadDrive();
    return result.computers.map((c: any) => `${c.name}: ${c.newFiles < 0 ? `could not read (${c.error || "error"})` : `${c.newFiles} new of ${c.totalFiles}`}`).join(" · ") || "No computers found.";
  });
  action("drive-retry", "Restarting…", async () => {
    const result = await call("/api/auto?retry=1", "POST");
    await loadDrive();
    return result.jobs
      ? `${result.started} job(s) restarted now. The other ${Math.max(0, result.jobs - result.started)} follow automatically as slots free up. Broken files are skipped.`
      : "No job has failed files or rows missing from the sheet.";
  });
  action("drive-dash", "Updating…", async () => {
    const result = await call("/api/auto?dashboard=1", "POST");
    window.open(result.url, "_blank", "noopener");
    return "Sheet dashboard updated.";
  });
}

// ---------- Transcripts ----------

const SOURCE_ICON: Record<string, string> = { drive: "cloud", bridge: "monitor" };
let txQuery = "";
let txBefore = 0;

async function loadTranscripts(reset: boolean) {
  const list = $("tx-list");
  if (reset) {
    txBefore = 0;
    list.innerHTML = `<p class="muted" style="padding:20px">Loading…</p>`;
  }
  try {
    const data = await call(`/api/auto/transcripts?q=${encodeURIComponent(txQuery)}${txBefore ? `&before=${txBefore}` : ""}`);
    const items: any[] = data.items || [];
    const html = items.map((t) => `<a class="list-item" href="/history/${esc(t.id)}">
        <span class="li-icon">${icon(SOURCE_ICON[t.source_type] || "file")}</span>
        <span class="li-main"><span class="li-title">${esc(t.title)}</span><span class="li-sub">${esc(t.source_ref || "")}</span></span>
        <span class="li-meta"><span class="chip">${t.source_type === "bridge" ? "Bridge PC" : t.source_type === "drive" ? "Drive" : esc(t.source_type)}</span><span>${esc(when(t.created_at))}</span></span>
      </a>`).join("");
    if (reset) list.innerHTML = html || empty("text", txQuery ? "Nothing matches" : "No team transcripts yet", txQuery ? "Try other words." : "Transcripts from this team's PCs and Drive accounts show up here.");
    else list.insertAdjacentHTML("beforeend", html);
    if (items.length) txBefore = items[items.length - 1].created_at;
    $("tx-more").classList.toggle("hidden", !data.more);
  } catch (error) {
    list.innerHTML = `<p class="notice error" style="margin:16px">${esc((error as Error).message)}</p>`;
  }
}

function initTranscripts() {
  let timer = 0;
  const form = $<HTMLFormElement>("tx-search");
  const input = form.querySelector("input")!;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    txQuery = input.value.trim();
    loadTranscripts(true);
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      txQuery = input.value.trim();
      loadTranscripts(true);
    }, 350);
  });
  $("tx-more").addEventListener("click", () => loadTranscripts(false));
}

// ---------- Start ----------

export function initAuto(): void {
  const raw = document.getElementById("auto-boot")?.textContent;
  if (!raw || raw === "null") return;
  boot = JSON.parse(raw);
  if (!boot.team.canManage) document.querySelectorAll<HTMLElement>(".manage-only").forEach((el) => el.classList.add("hidden"));
  if (boot.connected) flash("ok", "Google Drive connected. Press Scan now to look for recordings.");
  if (boot.problem) flash("bad", boot.problem);
  $("team-select")?.addEventListener("change", (e) => {
    location.href = `/auto?team=${encodeURIComponent((e.target as HTMLSelectElement).value)}`;
  });
  document.querySelectorAll<HTMLButtonElement>("#auto-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab || "")));
  initBridge();
  initDrive();
  initTranscripts();
  showTab(boot.tab);
}
