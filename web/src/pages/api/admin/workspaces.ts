import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json } from "../../../lib/http";
import { adminEmails, getWorkspace, listWorkspaces, requireAdmin, slugId } from "../../../lib/workspaces";
import { checkSpreadsheetAccess, spreadsheetId } from "../../../lib/sheets";

const KINDS = ["team", "customer"];

/** Every team with its members and how much it holds (Admin page). */
export const GET: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const workspaces = await listWorkspaces();
  const members = (await env.DB.prepare(
    `SELECT m.workspace_id, m.email, m.role, m.added_at, u.name, u.picture, u.last_login_at
       FROM workspace_members m LEFT JOIN users u ON LOWER(u.email) = m.email ORDER BY m.added_at`,
  ).all<any>()).results;
  const counts = (await env.DB.prepare(
    `SELECT w.id,
       (SELECT COUNT(*) FROM drive_accounts a WHERE a.workspace_id = w.id) AS drive_accounts,
       (SELECT COUNT(*) FROM bridge_devices d WHERE d.workspace_id = w.id AND d.kind = 'team') AS pcs,
       (SELECT COUNT(*) FROM transcriptions t WHERE t.workspace_id = w.id) AS transcripts
     FROM workspaces w`,
  ).all<any>()).results;
  const countOf = new Map(counts.map((c) => [c.id, c]));
  const users = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n || 0;
  return json({
    admins: adminEmails(),
    users,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      kind: w.kind,
      isDefault: Boolean(w.is_default),
      features: { drive: Boolean(w.feature_drive), bridge: Boolean(w.feature_bridge) },
      spreadsheet: w.spreadsheet || "",
      createdAt: w.created_at,
      counts: countOf.get(w.id) || { drive_accounts: 0, pcs: 0, transcripts: 0 },
      members: members.filter((m) => m.workspace_id === w.id).map((m) => ({
        email: m.email, role: m.role, addedAt: m.added_at, name: m.name || null, picture: m.picture || null, lastLoginAt: m.last_login_at || null,
      })),
    })),
  });
});

/** Create a team: an in-house team or a paying customer with its own independent Auto page. */
export const POST: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const body: any = await context.request.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "Give the team a name.");
  const kind = KINDS.includes(body.kind) ? body.kind : "team";
  const id = slugId(name);
  await env.DB.prepare("INSERT INTO workspaces (id, name, kind, created_at) VALUES (?, ?, ?, ?)").bind(id, name, kind, Date.now()).run();
  return json({ id });
});

/** Rename a team, change its kind, its features or its spreadsheet. */
export const PATCH: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const body: any = await context.request.json().catch(() => ({}));
  const workspace = await getWorkspace(String(body.id || ""));
  if (!workspace) throw new HttpError(404, "This team does not exist.");
  const set = (column: string, value: string | number | null) =>
    env.DB.prepare(`UPDATE workspaces SET ${column} = ? WHERE id = ?`).bind(value, workspace.id).run();
  if (body.name !== undefined) {
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) throw new HttpError(400, "Give the team a name.");
    await set("name", name);
  }
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) throw new HttpError(400, "Choose Team or Customer.");
    await set("kind", body.kind);
  }
  if (body.drive !== undefined) await set("feature_drive", body.drive ? 1 : 0);
  if (body.bridge !== undefined) await set("feature_bridge", body.bridge ? 1 : 0);
  if (body.spreadsheet !== undefined) {
    const raw = String(body.spreadsheet || "").trim();
    if (raw && !spreadsheetId(raw)) throw new HttpError(400, "That is not a Google Sheets link (docs.google.com/spreadsheets/d/...).");
    if (raw) {
      await checkSpreadsheetAccess(raw).catch((error) => {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      });
    }
    await set("spreadsheet", raw || null);
  }
  return json({ ok: true });
});

/** Delete an empty team. A team that still has Drive accounts or PCs must be emptied first. */
export const DELETE: APIRoute = handler(async (context) => {
  requireAdmin(context);
  const workspace = await getWorkspace(context.url.searchParams.get("id") || "");
  if (!workspace) throw new HttpError(404, "This team does not exist.");
  if (workspace.is_default) throw new HttpError(400, "The original team cannot be deleted.");
  const busy = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM drive_accounts WHERE workspace_id = ?1) + (SELECT COUNT(*) FROM bridge_devices WHERE workspace_id = ?1) AS n`,
  ).bind(workspace.id).first<{ n: number }>();
  if (Number(busy?.n || 0) > 0) throw new HttpError(400, "Disconnect this team's Drive accounts and remove its PCs first.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspace.id),
  ]);
  return json({ ok: true });
});
