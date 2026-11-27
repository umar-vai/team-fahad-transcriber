import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json } from "../../../lib/http";
import { requireAdmin } from "../../../lib/workspaces";
import { CURRENCIES, getPlan, listPlans, monthStart, slugPlanId, type Plan } from "../../../lib/plans";

/** Every plan, who is on which plan, and everyone who signed in (Pricing page). */
export const GET: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const plans = await listPlans();
  const assignments = (await env.DB.prepare(
    `SELECT p.email, p.plan_id, p.expires_at, p.note, p.assigned_by, p.assigned_at, u.name, u.picture, u.last_login_at
       FROM user_plans p LEFT JOIN users u ON LOWER(u.email) = p.email ORDER BY p.assigned_at DESC`,
  ).all<any>()).results;
  const users = (await env.DB.prepare(
    `SELECT u.id, LOWER(u.email) AS email, u.name, u.picture, u.last_login_at,
       (SELECT COALESCE(SUM(t.duration), 0) FROM transcriptions t WHERE t.user_id = u.id AND t.workspace_id IS NULL AND t.created_at >= ?) AS seconds
       FROM users u ORDER BY u.last_login_at DESC LIMIT 1000`,
  ).bind(monthStart()).all<any>()).results;
  return json({
    currencies: CURRENCIES,
    plans,
    assignments,
    users: users.map((u) => ({ email: u.email, name: u.name, picture: u.picture, lastLoginAt: u.last_login_at, minutes: Math.round((u.seconds || 0) / 60) })),
  });
});

function numberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a positive number or empty.`);
  return n;
}

/** Reads and checks the editable fields of a plan from a request body. */
function planFields(body: any, current?: Plan) {
  const pick = (key: string) => (key in body ? body[key] : (current as any)?.[key]);
  const name = String(pick("name") ?? "").trim().slice(0, 40);
  if (!name) throw new HttpError(400, "Give the plan a name.");
  const currency = String(pick("currency") || "BDT").toUpperCase();
  if (!CURRENCIES[currency]) throw new HttpError(400, "Choose a currency from the list.");
  const minutes = numberOrNull(pick("minutes_month"), "Minutes a month");
  const maxFile = numberOrNull(pick("max_file_minutes"), "Longest file");
  return {
    name,
    tagline: String(pick("tagline") ?? "").trim().slice(0, 120) || null,
    price_monthly: numberOrNull(pick("price_monthly"), "Monthly price"),
    price_yearly: numberOrNull(pick("price_yearly"), "Yearly price"),
    currency,
    minutes_month: minutes === null ? null : Math.round(minutes),
    max_file_minutes: maxFile === null ? null : Math.round(maxFile),
    features: String(pick("features") ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20).map((l) => l.slice(0, 120)).join("\n"),
    cta_label: String(pick("cta_label") ?? "").trim().slice(0, 30) || null,
    highlighted: pick("highlighted") ? 1 : 0,
    is_public: pick("is_public") ? 1 : 0,
    sort: Math.round(Number(pick("sort")) || 0),
  };
}

/** Create a plan. */
export const POST: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const body: any = await context.request.json().catch(() => ({}));
  const fields = planFields({ is_public: true, ...body });
  const id = slugPlanId(fields.name);
  const now = Date.now();
  const last = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS s FROM plans").first<{ s: number }>();
  await env.DB.prepare(
    `INSERT INTO plans (id, name, tagline, price_monthly, price_yearly, currency, minutes_month, max_file_minutes, features, cta_label, highlighted, is_public, is_default, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).bind(id, fields.name, fields.tagline, fields.price_monthly, fields.price_yearly, fields.currency, fields.minutes_month, fields.max_file_minutes,
    fields.features, fields.cta_label, fields.highlighted, fields.is_public, "sort" in body ? fields.sort : (last?.s || 0) + 10, now, now).run();
  if (fields.highlighted) await env.DB.prepare("UPDATE plans SET highlighted = 0 WHERE id != ?").bind(id).run();
  return json({ ok: true, id });
});

/** Change a plan. "default: true" makes it the plan of everyone without their own plan. */
export const PATCH: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const body: any = await context.request.json().catch(() => ({}));
  const plan = await getPlan(String(body.id || ""));
  if (!plan) throw new HttpError(404, "This plan does not exist.");
  const f = planFields(body, plan);
  const statements = [
    env.DB.prepare(
      `UPDATE plans SET name = ?, tagline = ?, price_monthly = ?, price_yearly = ?, currency = ?, minutes_month = ?, max_file_minutes = ?,
         features = ?, cta_label = ?, highlighted = ?, is_public = ?, sort = ?, updated_at = ? WHERE id = ?`,
    ).bind(f.name, f.tagline, f.price_monthly, f.price_yearly, f.currency, f.minutes_month, f.max_file_minutes, f.features, f.cta_label,
      f.highlighted, f.is_public, f.sort, Date.now(), plan.id),
  ];
  // Only one plan is "Most popular" and only one is the default.
  if (f.highlighted) statements.push(env.DB.prepare("UPDATE plans SET highlighted = 0 WHERE id != ?").bind(plan.id));
  if (body.default === true) {
    statements.push(env.DB.prepare("UPDATE plans SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").bind(plan.id));
  }
  await env.DB.batch(statements);
  return json({ ok: true });
});

/** Delete a plan. Its people move back to the default plan. The default plan cannot be deleted. */
export const DELETE: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const plan = await getPlan(context.url.searchParams.get("id") || "");
  if (!plan) throw new HttpError(404, "This plan does not exist.");
  if (plan.is_default) throw new HttpError(400, "This is the default plan. Make another plan the default first.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_plans WHERE plan_id = ?").bind(plan.id),
    env.DB.prepare("DELETE FROM plans WHERE id = ?").bind(plan.id),
  ]);
  return json({ ok: true });
});
