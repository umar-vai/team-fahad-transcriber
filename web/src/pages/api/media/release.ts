import type { APIRoute } from "astro";
import { handler, json, requireUser } from "../../../lib/http";
import { checkJobId, mediaFetch } from "../../../lib/media";

/** Stop a finished job's container right away so its slot is free for the next one. */
export const POST: APIRoute = handler(async (context) => {
  requireUser(context);
  const job = checkJobId(context.url.searchParams.get("job"));
  await mediaFetch(job, "/release", { method: "POST" }).catch(() => {});
  return json({ ok: true });
});
