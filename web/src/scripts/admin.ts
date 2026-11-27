/** Admin page: teams, their features and their members. */
import { icon } from "../lib/icons";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (n: unknown) => Number(n || 0).toLocaleString();
const toast = (message: string, kind?: "error") => (window as any).toast?.(message, kind);
const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

let data: any = null;
let selected = new URLSearchParams(location.search).get("team") || "";

async function call(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}

const team = () => data?.workspaces.find((w: any) => w.id === selected);

function renderList() {
  const teams: any[] = data.workspaces;
  $("team-count").textContent = `${teams.length}`;
  $("admin-stats").innerHTML = [
    ["Teams", teams.filter((t) => t.kind === "team").length],
    ["Customers", teams.filter((t) => t.kind === "customer").length],
    ["Team members", new Set(teams.flatMap((t) => t.members.map((m: any) => m.email))).size],
    ["People signed in", data.users],
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${num(value)}</strong></div>`).join("");
  $("team-list").innerHTML = teams.map((t) => `
    <button class="team-row" type="button" role="option" data-team="${esc(t.id)}" aria-selected="${t.id === selected}">
      <span class="team-avatar" style="width:34px;height:34px;font-size:14px">${esc(t.name.trim()[0] || "?")}</span>
      <span class="tr-main"><strong>${esc(t.name)}</strong><span>${t.members.length} member${t.members.length === 1 ? "" : "s"} · ${num(t.counts.transcripts)} transcripts</span></span>
      <span class="badge ${t.kind === "customer" ? "info" : "accent"}">${t.kind === "customer" ? "Customer" : "Team"}</span>
    </button>`).join("");
}

function renderDetail() {
  const t = team();
  const box = $("team-detail");
  if (!t) {
    box.innerHTML = `<section class="card"><div class="empty"><span class="empty-icon">${icon("users", "lg")}</span><h3>Choose a team</h3><p>Pick a team on the left to manage its members and features.</p></div></section>`;
    return;
  }
  box.innerHTML = `
    <section class="card flush">
      <div class="card-head">
        <div class="card-title"><span class="team-avatar">${esc(t.name.trim()[0] || "?")}</span><div><h2>${esc(t.name)}</h2><p>Created ${esc(date.format(new Date(t.createdAt)))}${t.isDefault ? " · original team" : ""}</p></div></div>
        <div class="row">
          <a class="btn ghost small" href="/auto?team=${encodeURIComponent(t.id)}">${icon("bolt")}Open Automation</a>
          ${t.isDefault ? "" : `<button class="btn danger small" type="button" data-act="delete">${icon("trash")}Delete</button>`}
        </div>
      </div>
      <div class="card-body stack">
        <div class="stats">
          <div class="stat"><span>Members</span><strong>${num(t.members.length)}</strong></div>
          <div class="stat"><span>Bridge PCs</span><strong>${num(t.counts.pcs)}</strong></div>
          <div class="stat"><span>Drive accounts</span><strong>${num(t.counts.drive_accounts)}</strong></div>
          <div class="stat"><span>Transcripts</span><strong>${num(t.counts.transcripts)}</strong></div>
        </div>
        <div class="grid-2">
          <div class="input-group"><label>Name<input type="text" data-field="name" value="${esc(t.name)}" maxlength="80" /></label><button class="btn ghost" type="button" data-act="rename">Save</button></div>
          <label>Kind<select data-field="kind"><option value="team"${t.kind === "team" ? " selected" : ""}>Our team</option><option value="customer"${t.kind === "customer" ? " selected" : ""}>Customer</option></select></label>
        </div>
      </div>
    </section>

    <section class="card stack">
      <div><h3>Features</h3><p class="muted small-text">What this team gets on its Automation page.</p></div>
      <div class="grid-2">
        <label class="switch"><span>Bridge PCs<small>PCs send new recordings for live transcription</small></span><input type="checkbox" data-feature="bridge"${t.features.bridge ? " checked" : ""} /></label>
        <label class="switch"><span>Google Drive automation<small>Nightly transcription of the team's Drive</small></span><input type="checkbox" data-feature="drive"${t.features.drive ? " checked" : ""} /></label>
      </div>
      <div class="input-group">
        <label>Team spreadsheet <span class="hint">${t.isDefault ? "empty: the shared team spreadsheet" : "the team's own Google Sheet, shared with the service account"}</span>
          <input type="text" data-field="spreadsheet" value="${esc(t.spreadsheet)}" placeholder="https://docs.google.com/spreadsheets/d/..." /></label>
        <button class="btn ghost" type="button" data-act="sheet">Save</button>
      </div>
      ${t.isDefault ? "" : `<p class="field-hint">This team never writes into another team's spreadsheet or Notion.</p>`}
    </section>

    <section class="card flush">
      <div class="card-head"><div><h3>Members</h3><p>Managers can pair PCs, connect Drive and change settings. Viewers can only look.</p></div></div>
      <div class="card-body" style="border-bottom:1px solid var(--line)">
        <form class="input-group" id="member-form">
          <label>Add people <span class="hint">one or more Gmail addresses, separated by commas</span><input type="text" name="email" placeholder="name@gmail.com, other@gmail.com" required /></label>
          <label style="flex:0 0 140px">Role<select name="role"><option value="viewer">Viewer</option><option value="manager">Manager</option></select></label>
          <button class="btn" type="submit">${icon("plus")}Add</button>
        </form>
      </div>
      <div>
        ${t.members.length ? t.members.map((m: any) => `
          <div class="member" data-email="${esc(m.email)}">
            <span class="avatar">${m.picture ? `<img src="${esc(m.picture)}" alt="" referrerpolicy="no-referrer" />` : esc((m.name || m.email)[0])}</span>
            <span class="m-main"><strong>${esc(m.name || m.email)}</strong><span>${esc(m.email)} · ${m.lastLoginAt ? `last seen ${esc(date.format(new Date(m.lastLoginAt)))}` : "has not signed in yet"}</span></span>
            <select data-role aria-label="Role of ${esc(m.email)}"><option value="viewer"${m.role === "viewer" ? " selected" : ""}>Viewer</option><option value="manager"${m.role === "manager" ? " selected" : ""}>Manager</option></select>
            <button class="btn quiet small icon-only" type="button" data-remove aria-label="Remove ${esc(m.email)}">${icon("x")}</button>
          </div>`).join("") : `<div class="empty"><span class="empty-icon">${icon("users", "lg")}</span><h3>No members yet</h3><p>Add the Gmail addresses of the people who should see this team. Admins (${esc(data.admins.join(", "))}) always see every team.</p></div>`}
      </div>
    </section>`;
}

async function reload() {
  data = await call("/api/admin/workspaces");
  if (!team()) selected = data.workspaces[0]?.id || "";
  renderList();
  renderDetail();
}

function select(id: string) {
  selected = id;
  const url = new URL(location.href);
  url.searchParams.set("team", id);
  history.replaceState(null, "", url);
  renderList();
  renderDetail();
}

export function initAdmin(): void {
  $("team-list").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-team]");
    if (row) select(row.dataset.team || "");
  });
  const detail = $("team-detail");
  const patch = async (body: any, message = "Saved.") => {
    try {
      await call("/api/admin/workspaces", "PATCH", { id: selected, ...body });
      toast(message);
      await reload();
    } catch (error) {
      toast((error as Error).message, "error");
      await reload();
    }
  };
  detail.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    const field = (name: string) => (detail.querySelector(`[data-field="${name}"]`) as HTMLInputElement).value;
    if (act === "rename") await patch({ name: field("name") }, "Team renamed.");
    if (act === "sheet") await patch({ spreadsheet: field("spreadsheet") }, "Spreadsheet saved.");
    if (act === "delete") {
      const t = team();
      if (!t || !confirm(`Delete ${t.name}? Its members lose access. This only works when it has no PCs and no Drive accounts.`)) return;
      try {
        await call(`/api/admin/workspaces?id=${encodeURIComponent(selected)}`, "DELETE");
        toast(`${t.name} was deleted.`);
        selected = "";
        await reload();
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }
    const remove = target.closest<HTMLElement>("[data-remove]");
    if (remove) {
      const email = remove.closest<HTMLElement>("[data-email]")?.dataset.email || "";
      if (!confirm(`Remove ${email} from ${team()?.name}?`)) return;
      try {
        await call(`/api/admin/members?workspace=${encodeURIComponent(selected)}&email=${encodeURIComponent(email)}`, "DELETE");
        toast(`${email} was removed.`);
        await reload();
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }
  });
  detail.addEventListener("change", async (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    if (target.dataset.feature) await patch({ [target.dataset.feature]: (target as HTMLInputElement).checked });
    if (target.dataset.field === "kind") await patch({ kind: target.value });
    if (target.hasAttribute("data-role")) {
      const email = target.closest<HTMLElement>("[data-email]")?.dataset.email || "";
      try {
        await call("/api/admin/members", "PATCH", { workspace: selected, email, role: target.value });
        toast("Role changed.");
        await reload();
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }
  });
  detail.addEventListener("submit", async (e) => {
    const form = e.target as HTMLFormElement;
    if (form.id !== "member-form") return;
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    try {
      const result = await call("/api/admin/members", "POST", { workspace: selected, ...body });
      toast(`${result.added} ${result.added === 1 ? "person" : "people"} added.`);
      await reload();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });
  const dialog = $<HTMLDialogElement>("team-dialog");
  $("new-team").addEventListener("click", () => dialog.showModal());
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "create") return;
    const form = $<HTMLFormElement>("team-form");
    const body = Object.fromEntries(new FormData(form));
    form.reset();
    try {
      const { id } = await call("/api/admin/workspaces", "POST", body);
      toast("Team created. Now add its members.");
      selected = id;
      await reload();
      select(id);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });
  reload().catch((error) => ($("team-list").innerHTML = `<p class="notice error" style="margin:16px">${esc(error.message)}</p>`));
}
