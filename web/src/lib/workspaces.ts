/**
 * Teams (workspaces) and who may use them.
 *
 * - Admins (ADMIN_EMAILS, or the built-in owner accounts) see and manage every team on the Admin page.
 * - Everyone else sees the Auto page only for the teams an admin added them to, as manager or viewer.
 * - People in no team never see the Auto page: they only transcribe for themselves.
 */
import { env } from "cloudflare:workers";
import type { APIContext } from "astro";
import { HttpError } from "./http";
import type { User } from "./auth";

/** The owners of the app. ADMIN_EMAILS (comma separated) replaces this list when set. */
const DEFAULT_ADMINS = ["umaar.ibn.sulaiman@gmail.com", "teamfahad86@gmail.com"];

export type Role = "manager" | "viewer";
export type WorkspaceKind = "team" | "customer";

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  is_default: number;
  feature_drive: number;
  feature_bridge: number;
  spreadsheet: string | null;
  bridge_mode: string;
  bridge_language: string;
  link_pin_hash: string | null;
  link_user_id: string | null;
  created_at: number;
}

/** A team as one person may use it. */
export interface Access {
  workspace: Workspace;
  /** "admin" can do everything a manager can, in every team. */
  role: Role | "admin";
  canManage: boolean;
}

/** Means "this account has no spreadsheet": stops the fallback to the shared team spreadsheet. */
export const NO_SHEET = "none";

export function adminEmails(): string[] {
  const configured = String(env.ADMIN_EMAILS || "")
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ADMINS;
}

export function isAdmin(user: Pick<User, "email"> | null | undefined): boolean {
  return Boolean(user && adminEmails().includes(user.email.toLowerCase()));
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return (await env.DB.prepare("SELECT * FROM workspaces ORDER BY is_default DESC, name COLLATE NOCASE").all<Workspace>()).results;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  if (!id) return null;
  return env.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<Workspace>();
}

/** Every team this person may open, with their role in it. */
export async function accessibleWorkspaces(user: User | null | undefined): Promise<Access[]> {
  if (!user) return [];
  if (isAdmin(user)) return (await listWorkspaces()).map((workspace) => ({ workspace, role: "admin" as const, canManage: true }));
  const rows = await env.DB.prepare(
    `SELECT w.*, m.role AS member_role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.email = ? ORDER BY w.is_default DESC, w.name COLLATE NOCASE`,
  )
    .bind(user.email.toLowerCase())
    .all<Workspace & { member_role: Role }>();
  return rows.results.map(({ member_role, ...workspace }) => ({
    workspace,
    role: member_role === "manager" ? "manager" : "viewer",
    canManage: member_role === "manager",
  }));
}

/** True when this person may see the Auto page at all (an admin, or a member of at least one team). */
export async function hasAutoAccess(user: User | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const row = await env.DB.prepare("SELECT 1 AS x FROM workspace_members WHERE email = ? LIMIT 1").bind(user.email.toLowerCase()).first();
  return Boolean(row);
}

/** One team as this person may use it, or null when they are not allowed in. */
export async function accessTo(user: User | null | undefined, workspaceId: string): Promise<Access | null> {
  if (!user || !workspaceId) return null;
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;
  if (isAdmin(user)) return { workspace, role: "admin", canManage: true };
  const member = await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?")
    .bind(workspaceId, user.email.toLowerCase())
    .first<{ role: Role }>();
  if (!member) return null;
  return { workspace, role: member.role === "manager" ? "manager" : "viewer", canManage: member.role === "manager" };
}

/**
 * The team an API request is about (?workspace= or body.workspace), checked against the signed-in person.
 * manage: the request changes something, so viewers are refused.
 */
export async function requireWorkspace(context: APIContext, options: { manage?: boolean; id?: string } = {}): Promise<Access & { user: User }> {
  const user = context.locals.user;
  if (!user) throw new HttpError(401, "Please sign in first.");
  const id = options.id ?? context.url.searchParams.get("workspace") ?? "";
  if (!id) throw new HttpError(400, "Choose a team first.");
  const access = await accessTo(user, id);
  if (!access) throw new HttpError(403, "You do not have access to this team. Ask an admin to add you.");
  if (options.manage && !access.canManage) throw new HttpError(403, "Only a manager of this team can change this.");
  return { ...access, user };
}

export function requireAdmin(context: APIContext): User {
  const user = context.locals.user;
  if (!user) throw new HttpError(401, "Please sign in first.");
  if (!isAdmin(user)) throw new HttpError(403, "Only an admin can do this.");
  return user;
}

/**
 * The spreadsheet a Drive account of this team writes to: its own link, else the team's link, else (only for the
 * original team) the shared team spreadsheet. Other teams never fall back to the shared one.
 */
export function effectiveSpreadsheet(own: string | null | undefined, workspace: Pick<Workspace, "spreadsheet" | "is_default"> | null): string | null {
  const mine = String(own || "").trim();
  if (mine) return mine;
  const team = String(workspace?.spreadsheet || "").trim();
  if (team) return team;
  return workspace?.is_default ? null : NO_SHEET;
}

/** Only the original team may write to the shared Notion page. */
export function notionAllowed(workspace: Pick<Workspace, "is_default"> | null): boolean {
  return Boolean(workspace?.is_default);
}

export function slugId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "team";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/**
 * May this person open a saved transcript? Personal transcripts: only their owner. Team transcripts (Auto page):
 * the team's members (managers and admins may also rename or delete them).
 */
export async function transcriptAccess(user: User | null | undefined, id: string): Promise<{ row: any; canEdit: boolean; workspace: Workspace | null } | null> {
  if (!user || !id) return null;
  const row = await env.DB.prepare("SELECT * FROM transcriptions WHERE id = ?").bind(id).first<any>();
  if (!row) return null;
  if (!row.workspace_id) return row.user_id === user.id ? { row, canEdit: true, workspace: null } : null;
  const access = await accessTo(user, row.workspace_id);
  return access ? { row, canEdit: access.canManage, workspace: access.workspace } : null;
}

/** May this person see a folder batch? Personal batches: only their owner. Nightly Auto batches: the team. */
export async function batchAccess(user: User | null | undefined, id: string): Promise<{ ownerId: string; canManage: boolean; workspaceId: string | null } | null> {
  if (!user || !id) return null;
  const row = await env.DB.prepare("SELECT user_id, workspace_id FROM batches WHERE id = ?").bind(id).first<{ user_id: string; workspace_id: string | null }>();
  if (!row) return null;
  if (!row.workspace_id) return row.user_id === user.id ? { ownerId: row.user_id, canManage: true, workspaceId: null } : null;
  const access = await accessTo(user, row.workspace_id);
  return access ? { ownerId: row.user_id, canManage: access.canManage, workspaceId: row.workspace_id } : null;
}
