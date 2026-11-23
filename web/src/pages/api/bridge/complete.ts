import type { APIRoute } from "astro";
import { handler, json } from "../../../lib/http";
import { authDevice, completeFile, failFile } from "../../../lib/bridge";

/** All pieces of a file are transcribed (JSON with the pieces), or the file cannot be used ({failed:true, error}). */
export const POST: APIRoute = handler(async (context) => {
  const device = await authDevice(context.request);
  const body: any = await context.request.json().catch(() => ({}));
  if (body.failed) return json(await failFile(device, body, Number(body.duration) || 0));
  return json(await completeFile(device, body));
});
