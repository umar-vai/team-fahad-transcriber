import type { APIRoute } from "astro";
import { handler, json, requireUser } from "../../../lib/http";
import { checkJobId, mediaFetch } from "../../../lib/media";

export const GET: APIRoute = handler(async (context) => {
  requireUser(context);
  const job = checkJobId(context.url.searchParams.get("job"));
  const response = await mediaFetch(job, "/status");
  const payload = await response.json().catch(() => ({ status: "error", error: "Media helper did not answer." }));
  return json(payload);
});
