/** Admin Pricing page: edit plans and choose which plan each person is on. */
import { icon } from "../lib/icons";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const toast = (message: string, kind?: "error") => (window as any).toast?.(message, kind);
const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

let data: any = null;
let filter = "";

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

function price(amount: number | null, currency: string): string {
  if (amount === null || amount === undefined) return "Custom";
  const symbol = data.currencies[currency]?.symbol ?? `${currency} `;
  return `${symbol}${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

const minutes = (m: number | null) => (m === null || m === undefined ? "Unlimited" : `${Number(m).toLocaleString()} min`);
const defaultPlan = () => data.plans.find((p: any) => p.is_default) || null;
const planById = (id: string) => data.plans.find((p: any) => p.id === id) || null;

/** Everyone on the people table: signed-in users plus assigned emails that never signed in. */
function people() {
  const byEmail = new Map<string, any>();
  for (const u of data.users) byEmail.set(u.email, { ...u, assignment: null });
  for (const a of data.assignments) {
    const row = byEmail.get(a.email) || { email: a.email, name: a.name, picture: a.picture, lastLoginAt: a.last_login_at, minutes: 0 };
    byEmail.set(a.email, { ...row, assignment: a });
  }
  return [...byEmail.values()];
}

function currentPlan(person: any) {
  const a = person.assignment;
  if (a && (!a.expires_at || a.expires_at > Date.now())) return planById(a.plan_id);
  return defaultPlan();
}

function render() {
  const all = people();
  const paid = all.filter((p) => { const plan = currentPlan(p); return plan && (plan.price_monthly ?? 1) > 0; }).length;
  $("plan-stats").innerHTML = [
    ["Plans", data.plans.length],
    ["On the home page", data.plans.filter((p: any) => p.is_public).length],
    ["People", all.length],
    ["On a paid plan", paid],
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${Number(value).toLocaleString()}</strong></div>`).join("");

  $("plan-list").innerHTML = data.plans.map((p: any) => {
    const count = all.filter((person) => currentPlan(person)?.id === p.id).length;
    const features = String(p.features || "").split("\n").filter(Boolean);
    return `
    <article class="plan-admin${p.highlighted ? " featured" : ""}">
      <div class="row between" style="align-items:flex-start">
        <div><h3>${esc(p.name)}</h3><p class="muted small-text">${esc(p.tagline || "")}</p></div>
        <div class="chips">
          ${p.is_default ? '<span class="badge accent">Default</span>' : ""}
          ${p.highlighted ? '<span class="badge info">Most popular</span>' : ""}
          ${p.is_public ? "" : '<span class="badge warn">Hidden</span>'}
        </div>
      </div>
      <div class="plan-admin-price"><strong>${esc(price(p.price_monthly, p.currency))}</strong>${p.price_monthly === null ? "" : "<span>/month</span>"}</div>
      <p class="small-text muted">${p.minutes_month === null ? "Unlimited minutes" : `${esc(minutes(p.minutes_month))} a month`}${p.price_yearly ? ` · ${esc(price(p.price_yearly, p.currency))} a year` : ""}</p>
      <ul class="plan-admin-features">${features.slice(0, 4).map((f) => `<li>${icon("check", "sm")}${esc(f)}</li>`).join("")}${features.length > 4 ? `<li class="muted">+${features.length - 4} more</li>` : ""}</ul>
      <div class="plan-admin-foot">
        <span class="small-text muted">${count} ${count === 1 ? "person" : "people"}</span>
        <div class="row" style="gap:6px;justify-content:flex-end">
          ${p.is_default ? "" : `<button class="btn quiet small" type="button" data-default="${esc(p.id)}" title="Everyone without their own plan gets this plan">Make default</button>`}
          <button class="btn ghost small" type="button" data-edit="${esc(p.id)}">${icon("settings")}Edit</button>
          ${p.is_default ? "" : `<button class="btn danger small icon-only" type="button" data-delete="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">${icon("trash")}</button>`}
        </div>
      </div>
    </article>`;
  }).join("") || '<p class="muted">No plans yet. Press "New plan".</p>';

  const options = (selected: string | null) =>
    data.plans.map((p: any) => `<option value="${esc(p.id)}"${p.id === selected ? " selected" : ""}>${esc(p.name)}${p.is_default ? " (default)" : ""}</option>`).join("");
  $("assign-plan").innerHTML = options(data.plans.find((p: any) => !p.is_default)?.id || null);

  const q = filter.toLowerCase();
  const rows = all.filter((p) => !q || p.email.includes(q) || String(p.name || "").toLowerCase().includes(q));
  const body = ($("people-table") as HTMLTableElement).tBodies[0];
  body.innerHTML = rows.map((person) => {
    const plan = currentPlan(person);
    const a = person.assignment;
    const expired = a?.expires_at && a.expires_at <= Date.now();
    const quota = plan?.minutes_month ?? null;
    const used = person.minutes || 0;
    const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;
    return `
    <tr>
      <td>
        <div class="row" style="gap:10px;flex-wrap:nowrap">
          <span class="avatar">${person.picture ? `<img src="${esc(person.picture)}" alt="" referrerpolicy="no-referrer" />` : esc((person.name || person.email)[0])}</span>
          <span style="display:grid;min-width:0"><strong class="truncate">${esc(person.name || person.email)}</strong><span class="muted small-text truncate">${esc(person.email)}${person.lastLoginAt ? "" : " · not signed in yet"}</span>${a?.note ? `<span class="muted small-text truncate">${esc(a.note)}</span>` : ""}</span>
        </div>
      </td>
      <td>
        <select data-person="${esc(person.email)}" aria-label="Plan of ${esc(person.email)}" style="min-width:150px">
          ${a ? "" : `<option value="" selected>${esc(defaultPlan()?.name || "Default")} (default)</option>`}
          ${options(a && !expired ? a.plan_id : null)}
        </select>
        ${expired ? '<div class="small-text" style="color:var(--warn)">Plan ended, back on default</div>' : ""}
      </td>
      <td style="min-width:150px">
        <div class="small-text num">${used.toLocaleString()} / ${esc(minutes(quota))}</div>
        ${quota ? `<div class="progress" style="height:5px;margin-top:4px"><div style="width:${pct}%;${pct >= 100 ? "background:var(--bad)" : ""}"></div></div>` : ""}
      </td>
      <td class="small-text">${a?.expires_at ? esc(date.format(new Date(a.expires_at))) : '<span class="muted">Never</span>'}</td>
      <td class="r">${a ? `<button class="btn quiet small" type="button" data-unassign="${esc(person.email)}" title="Back to the default plan">Reset</button>` : ""}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="5" class="muted">Nobody matches.</td></tr>';
}

async function load() {
  data = await call("/api/admin/plans");
  render();
}

function openPlan(plan: any | null) {
  const dialog = $("plan-dialog") as HTMLDialogElement;
  const form = $("plan-form") as HTMLFormElement;
  $("plan-dialog-title").textContent = plan ? `Edit ${plan.name}` : "New plan";
  $("plan-currency").innerHTML = Object.entries(data.currencies).map(([code, c]: [string, any]) => `<option value="${code}">${esc(c.label)}</option>`).join("");
  const values: Record<string, any> = plan || { currency: data.plans[0]?.currency || "BDT", is_public: 1, highlighted: 0, sort: "" };
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    if (el.type === "checkbox") el.checked = Boolean(values[el.name]);
    else el.value = values[el.name] === null || values[el.name] === undefined ? "" : String(values[el.name]);
  }
  dialog.showModal();
}

async function savePlan(form: HTMLFormElement) {
  const body: Record<string, any> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    body[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  if (body.id) await call("/api/admin/plans", "PATCH", body);
  else {
    delete body.id;
    if (body.sort === "") delete body.sort;
    await call("/api/admin/plans", "POST", body);
  }
  toast("Plan saved");
  await load();
}

export function initPricingAdmin() {
  load().catch((error) => toast(error.message, "error"));

  $("new-plan").addEventListener("click", () => openPlan(null));
  const dialog = $("plan-dialog") as HTMLDialogElement;
  const form = $("plan-form") as HTMLFormElement;
  form.addEventListener("submit", async (event) => {
    if ((event.submitter as HTMLButtonElement | null)?.value !== "save") return;
    event.preventDefault();
    try {
      await savePlan(form);
      dialog.close();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });

  $("plan-list").addEventListener("click", async (event) => {
    const target = (event.target as HTMLElement).closest("button");
    if (!target) return;
    try {
      if (target.dataset.edit) openPlan(planById(target.dataset.edit));
      if (target.dataset.default) {
        const plan = planById(target.dataset.default);
        if (!confirm(`Make ${plan.name} the default plan? Everyone without their own plan will be on it.`)) return;
        await call("/api/admin/plans", "PATCH", { id: plan.id, default: true });
        toast(`${plan.name} is now the default plan`);
        await load();
      }
      if (target.dataset.delete) {
        const plan = planById(target.dataset.delete);
        if (!confirm(`Delete the ${plan.name} plan? People on it go back to the default plan.`)) return;
        await call(`/api/admin/plans?id=${encodeURIComponent(plan.id)}`, "DELETE");
        toast("Plan deleted");
        await load();
      }
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });

  $("assign-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.target as HTMLFormElement;
    const values = Object.fromEntries(new FormData(formEl));
    try {
      const result = await call("/api/admin/plan-users", "POST", values);
      toast(`Plan given to ${result.added} ${result.added === 1 ? "person" : "people"}`);
      formEl.reset();
      await load();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });

  $("people-table").addEventListener("change", async (event) => {
    const select = event.target as HTMLSelectElement;
    const email = select.dataset.person;
    if (!email) return;
    try {
      if (select.value) await call("/api/admin/plan-users", "POST", { email, plan: select.value });
      else await call(`/api/admin/plan-users?email=${encodeURIComponent(email)}`, "DELETE");
      toast("Plan changed");
      await load();
    } catch (error) {
      toast((error as Error).message, "error");
      render();
    }
  });

  $("people-table").addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-unassign]");
    if (!button) return;
    try {
      await call(`/api/admin/plan-users?email=${encodeURIComponent(button.dataset.unassign!)}`, "DELETE");
      toast("Back on the default plan");
      await load();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  });

  $("people-search").addEventListener("input", (event) => {
    filter = (event.target as HTMLInputElement).value.trim();
    render();
  });
}
