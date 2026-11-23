import type { APIRoute } from "astro";
import { handler, json } from "../../../lib/http";
import { redeemPairingCode } from "../../../lib/bridge";

/** The bridge app swaps a pairing code for its device token. No login: the code is the proof. */
export const POST: APIRoute = handler(async (context) => {
  const body: any = await context.request.json().catch(() => ({}));
  return json(await redeemPairingCode(String(body.code || "")));
});
