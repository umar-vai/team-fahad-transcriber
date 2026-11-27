import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json, requireUser } from "../../../lib/http";

const ID = /^[0-9a-f-]{36}$/;

/** Progress of a server-side link job. */
export const GET: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const id = String(context.params.id || "");
  if (!ID.test(id)) throw new HttpError(404, "Job not found.");
  const status = await env.LINK_JOB.getByName(id).status(user.id);
  if (!status) throw new HttpError(404, "Job not found.");
  return json(status);
});
