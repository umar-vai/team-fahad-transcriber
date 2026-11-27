import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json } from "../../../lib/http";
import { requireAdmin } from "../../../lib/workspaces";
import { getPlan } from "../../../lib/plans";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Put people (one or many emails) on a plan, with an optional end date and note. */
export const POST: APIRoute = handler(async (context) => {
  const admin = requireAdmin(context);
  const body: any = await context.request.json().catch(() => ({}));
  const plan = await getPlan(String(body.plan || ""));
  if (!plan) throw new HttpError(404, "Choose a plan.");
  const emails = [...new Set(String(body.email || "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new HttpError(400, "Type at least one email address.");
  const bad = emails.filter((e) => !EMAIL.test(e));
  if (bad.length) throw new HttpError(400, `Not an email address: ${bad.join(", ")}`);
  if (emails.length > 100) throw new HttpError(400, "Add at most 100 people at once.");
  let expires: number | null = null;
  if (body.expiresAt) {
    expires = Date.parse(String(body.expiresAt));
    if (!Number.isFinite(expires)) throw new HttpError(400, "The end date is not a valid date.");
  }
  const note = String(body.note || "").trim().slice(0, 200) || null;
  const now = Date.now();
  await env.DB.batch(emails.map((email) =>
    env.DB.prepare(
      `INSERT INTO user_plans (email, plan_id, expires_at, note, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET plan_id = excluded.plan_id, expires_at = excluded.expires_at, note = excluded.note,
         assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at`,
    ).bind(email, plan.id, expires, note, admin.email.toLowerCase(), now),
  ));
  return json({ ok: true, added: emails.length });
});

/** Take someone off their plan: they go back to the default plan. */
export const DELETE: APIRoute = handler(async (context) => {
  requireAdmin(context);
  await env.DB.prepare("DELETE FROM user_plans WHERE email = ?").bind((context.url.searchParams.get("email") || "").toLowerCase()).run();
  return json({ ok: true });
});
