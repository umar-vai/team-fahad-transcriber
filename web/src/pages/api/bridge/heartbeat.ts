import type { APIRoute } from "astro";
import { handler, json } from "../../../lib/http";
import { authDevice, bridgeSettings, knownFingerprints, recordHeartbeat } from "../../../lib/bridge";

/**
 * Every minute from each PC: what it is doing. The reply carries the current settings and tells the PC
 * which of the fingerprints it asks about are already finished on the server.
 */
export const POST: APIRoute = handler(async (context) => {
  const device = await authDevice(context.request);
  const body: any = await context.request.json().catch(() => ({}));
  await recordHeartbeat(device, { version: body.version, folder: body.folder, queue: body.queue, current: body.current, error: body.error });
  return json({ ok: true, name: device.name, settings: await bridgeSettings(), known: await knownFingerprints(device, body.check), serverTime: Date.now() });
});
