import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json } from "../../../lib/http";
import { bridgeSettings, createPairingCode, linkPinIsSet, saveBridgeSettings, setLinkPin } from "../../../lib/bridge";
import { dayOf } from "../../../lib/autodrive";
import { requireWorkspace } from "../../../lib/workspaces";

function requireBridge(access: { workspace: { feature_bridge: number } }) {
  if (!access.workspace.feature_bridge) throw new HttpError(403, "Bridge PCs are not switched on for this team.");
}

/** One PC of the team in detail: live state, totals, numbers per day and its latest files. */
async function pcDetail(workspaceId: string, id: string) {
  const device = await env.DB.prepare(
    `SELECT id, name, created_at, last_seen_at, version, watch_folder, queue_size, current_file, last_error, sheet_json, sheet_enabled
       FROM bridge_devices WHERE id = ? AND kind = 'team' AND workspace_id = ?`,
  ).bind(id, workspaceId).first<any>();
  if (!device) throw new HttpError(404, "This PC was removed.");
  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(status = 'done'), 0) AS done, COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(CASE WHEN status = 'done' THEN words ELSE 0 END), 0) AS words
       FROM bridge_files WHERE device_id = ?`,
  ).bind(id).first<any>();
  const days = await env.DB.prepare(
    `SELECT file_day AS day, COALESCE(SUM(status = 'done'), 0) AS done, COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(CASE WHEN status = 'done' THEN words ELSE 0 END), 0) AS words
       FROM bridge_files WHERE device_id = ? GROUP BY file_day ORDER BY file_day DESC LIMIT 30`,
  ).bind(id).all<any>();
  const files = await env.DB.prepare(
    `SELECT name, file_day, status, words, error, created_at, row_no, history_id FROM bridge_files WHERE device_id = ? ORDER BY created_at DESC LIMIT 300`,
  ).bind(id).all<any>();
  return {
    device: { ...device, sheet_url: device.sheet_json ? JSON.parse(device.sheet_json).url : null, sheet_json: undefined, sheet_enabled: Boolean(device.sheet_enabled) },
    totals,
    days: days.results,
    files: files.results,
  };
}

/** The team's PCs, their live state and today's numbers. With ?id= one PC in detail. */
export const GET: APIRoute = handler(async (context) => {
  const access = await requireWorkspace(context);
  requireBridge(access);
  const workspaceId = access.workspace.id;
  const wanted = context.url.searchParams.get("id");
  if (wanted) return json(await pcDetail(workspaceId, wanted));
  const today = dayOf(Date.now());
  const devices = await env.DB.prepare(
    `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.version, d.watch_folder, d.queue_size, d.current_file, d.last_error,
       (SELECT COUNT(*) FROM bridge_files f WHERE f.device_id = d.id AND f.status = 'done') AS done,
       (SELECT COUNT(*) FROM bridge_files f WHERE f.device_id = d.id AND f.status = 'failed') AS failed,
       (SELECT COUNT(*) FROM bridge_files f WHERE f.device_id = d.id AND f.status = 'done' AND f.file_day = ?1) AS done_today,
       d.sheet_json
       FROM bridge_devices d WHERE d.kind = 'team' AND d.workspace_id = ?2 ORDER BY d.name COLLATE NOCASE`,
  )
    .bind(today, workspaceId)
    .all<any>();
  return json({
    today,
    canManage: access.canManage,
    settings: await bridgeSettings(workspaceId),
    pinSet: await linkPinIsSet(workspaceId),
    devices: devices.results.map((d) => ({ ...d, sheet_url: d.sheet_json ? JSON.parse(d.sheet_json).url : null, sheet_json: undefined })),
  });
});

/** Make a pairing code for a new PC of the team. */
export const POST: APIRoute = handler(async (context) => {
  const access = await requireWorkspace(context, { manage: true });
  requireBridge(access);
  const body: any = await context.request.json().catch(() => ({}));
  return json(await createPairingCode(access.user.id, access.workspace.id, String(body.name || "")));
});

/** Output style and language for the team's PCs, and the team PIN for linking a PC. */
export const PATCH: APIRoute = handler(async (context) => {
  const access = await requireWorkspace(context, { manage: true });
  requireBridge(access);
  const body: any = await context.request.json().catch(() => ({}));
  if (body.pin !== undefined) await setLinkPin(access.workspace.id, access.user.id, String(body.pin));
  await saveBridgeSettings(access.workspace.id, {
    mode: body.mode === undefined ? undefined : String(body.mode),
    language: body.language === undefined ? undefined : String(body.language),
  });
  return json({ ok: true });
});

/** Remove a team PC: its token stops working at once. Its transcripts and sheet rows stay. */
export const DELETE: APIRoute = handler(async (context) => {
  const access = await requireWorkspace(context, { manage: true });
  const id = context.url.searchParams.get("id") || "";
  if (!id) throw new HttpError(400, "Missing PC id.");
  const removed = await env.DB.prepare("DELETE FROM bridge_devices WHERE id = ? AND kind = 'team' AND workspace_id = ?").bind(id, access.workspace.id).run();
  if (!removed.meta?.changes) throw new HttpError(404, "This PC was already removed.");
  return json({ ok: true });
});
