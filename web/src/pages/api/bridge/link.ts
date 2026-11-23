import type { APIRoute } from "astro";
import { handler, json } from "../../../lib/http";
import { linkChoices, linkDevice } from "../../../lib/bridge";

/**
 * A fresh PC links to a computer that is already on the website. No login: the team PIN is the proof.
 * Without "key" it returns the list of computers; with "key" the PC takes that computer's place.
 */
export const POST: APIRoute = handler(async (context) => {
  const body: any = await context.request.json().catch(() => ({}));
  const pin = String(body.pin || "");
  if (body.key) return json(await linkDevice(pin, String(body.key)));
  return json({ computers: await linkChoices(pin) });
});
