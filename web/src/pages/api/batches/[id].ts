import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json, requireUser } from "../../../lib/http";

const ID = /^[0-9a-f-]{36}$/;

function runner(id: string | undefined) {
  if (!id || !ID.test(id)) throw new HttpError(404, "Batch not found.");
  return env.BATCH_RUNNER.getByName(id);
}

/** Live progress, read from the batch's Durable Object (no D1 reads). */
export const GET: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const status = await runner(context.params.id).status(user.id);
  if (!status) throw new HttpError(404, "Batch not found.");
  return json(status);
});

/** {action: "cancel"} stops the batch; {action: "resume"} retries failed videos and missing exports. */
export const POST: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  const stub = runner(context.params.id);
  let ok = false;
  if (body.action === "cancel") ok = await stub.cancel(user.id);
  else if (body.action === "resume") ok = await stub.resume(user.id);
  else throw new HttpError(400, "Unknown action.");
  if (!ok) throw new HttpError(404, "Batch not found.");
  return json({ ok: true });
});
