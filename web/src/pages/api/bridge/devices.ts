import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { bridgeSettings, createPairingCode, linkPinIsSet, saveBridgeSettings, setLinkPin } from "../../../lib/bridge";
import { dayOf } from "../../../lib/autodrive";

/** The PCs, their live state and today's numbers (Auto page). */
export const GET: APIRoute = handler(async (context) => {
  requireUser(context);
  const today = dayOf(Date.now());
  const devices = await env.DB.prepare(
    `SELECT d.id, d.name, d.created_at, d.last_seen_at, d.version, d.watch_folder, d.queue_size, d.current_file, d.last_error,
       (SELECT COUNT(*) FROM bridge_files f WHERE f.device_id = d.id AND f.status = 'done') AS done,
       (SELECT COUNT(*) FROM bridge_files f WHERE f.device_id = d.id AND f.status = 'failed') AS failed,
       (SELECT COUNT(*) FROM bridge_files f WHERE f.device_id = d.id AND f.status = 'done' AND f.file_day = ?1) AS done_today,
       d.sheet_json
       FROM bridge_devices d ORDER BY d.name COLLATE NOCASE`,
  )
    .bind(today)
    .all<any>();
  return json({
    today,
    settings: await bridgeSettings(),
    pinSet: await linkPinIsSet(),
    devices: devices.results.map((d) => ({ ...d, sheet_url: d.sheet_json ? JSON.parse(d.sheet_json).url : null, sheet_json: undefined })),
  });
});

/** Make a pairing code for a new PC. */
export const POST: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  return json(await createPairingCode(user.id, String(body.name || "")));
});

/** Output style and language for all bridge PCs, and the team PIN for linking a PC. */
export const PATCH: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  if (body.pin !== undefined) await setLinkPin(user.id, String(body.pin));
  await saveBridgeSettings({ mode: body.mode === undefined ? undefined : String(body.mode), language: body.language === undefined ? undefined : String(body.language) });
  return json({ ok: true });
});

/** Remove a PC: its token stops working at once. Its transcripts and sheet rows stay. */
export const DELETE: APIRoute = handler(async (context) => {
  requireUser(context);
  const id = context.url.searchParams.get("id") || "";
  if (!id) throw new HttpError(400, "Missing PC id.");
  // History rows must survive: only the device and its file ledger go.
  await env.DB.prepare("DELETE FROM bridge_devices WHERE id = ?").bind(id).run();
  return json({ ok: true });
});
