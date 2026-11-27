import type { APIRoute } from "astro";
import { driveConnectUrl, googleConfigured } from "../../lib/auth";
import { accessTo } from "../../lib/workspaces";

/** Start connecting a Google Drive account to a team (?team=). Only that team's managers and admins may do this. */
export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
  const team = url.searchParams.get("team") || "";
  if (!locals.user) return redirect(`/login?next=${encodeURIComponent(`/auto?team=${team}`)}`, 302);
  if (!googleConfigured()) return redirect("/login?error=setup", 302);
  const access = await accessTo(locals.user, team);
  if (!access?.canManage) return redirect(`/auto?error=${encodeURIComponent("Only a manager of this team can connect a Drive account.")}`, 302);
  return redirect(driveConnectUrl(url.origin, cookies, team), 302);
};
