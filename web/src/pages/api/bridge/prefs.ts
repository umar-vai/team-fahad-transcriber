import type { APIRoute } from "astro";
import { handler, json } from "../../../lib/http";
import { authDevice, deviceView, leaveDevice, saveDevicePrefs } from "../../../lib/bridge";

/** The app changes its own settings (sheet switch of a team PC, style and language of a personal PC). */
export const POST: APIRoute = handler(async (context) => {
  const device = await authDevice(context.request);
  const body: any = await context.request.json().catch(() => ({}));
  await saveDevicePrefs(device, { sheet: body.sheet, mode: body.mode, language: body.language });
  const fresh = await authDevice(context.request);
  return json({ ok: true, ...(await deviceView(fresh)) });
});

/** The app is reset. A personal PC removes itself from the website. */
export const DELETE: APIRoute = handler(async (context) => {
  await leaveDevice(await authDevice(context.request));
  return json({ ok: true });
});
