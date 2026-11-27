import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json } from "../../../lib/http";
import { getWorkspace, requireAdmin } from "../../../lib/workspaces";

const ROLES = ["manager", "viewer"];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Add people to a team (one or many emails), or change their role when they are already in it. */
export const POST: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const body: any = await context.request.json().catch(() => ({}));
  const workspace = await getWorkspace(String(body.workspace || ""));
  if (!workspace) throw new HttpError(404, "This team does not exist.");
  const role = ROLES.includes(body.role) ? body.role : "viewer";
  const emails = [...new Set(String(body.email || "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new HttpError(400, "Type at least one email address.");
  const bad = emails.filter((e) => !EMAIL.test(e));
  if (bad.length) throw new HttpError(400, `Not an email address: ${bad.join(", ")}`);
  if (emails.length > 50) throw new HttpError(400, "Add at most 50 people at once.");
  const now = Date.now();
  await env.DB.batch(emails.map((email) =>
    env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, email, role, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET role = excluded.role`,
    ).bind(workspace.id, email, role, now),
  ));
  return json({ ok: true, added: emails.length });
});

/** Change one person's role. */
export const PATCH: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const body: any = await context.request.json().catch(() => ({}));
  if (!ROLES.includes(body.role)) throw new HttpError(400, "Choose Manager or Viewer.");
  const result = await env.DB.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND email = ?")
    .bind(body.role, String(body.workspace || ""), String(body.email || "").toLowerCase())
    .run();
  if (!result.meta?.changes) throw new HttpError(404, "This person is not in the team.");
  return json({ ok: true });
});

/** Take someone out of a team. Their own personal transcripts are not touched. */
export const DELETE: APIRoute = handler(async (context) => {
  requireAdmin(context);
  await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND email = ?")
    .bind(context.url.searchParams.get("workspace") || "", (context.url.searchParams.get("email") || "").toLowerCase())
    .run();
  return json({ ok: true });
});
