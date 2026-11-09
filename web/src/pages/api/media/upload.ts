import type { APIRoute } from "astro";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { checkJobId, mediaFetch } from "../../../lib/media";

/** Large files the browser cannot decode are sent here in pieces of up to 50 MB. */
export const POST: APIRoute = handler(async (context) => {
  requireUser(context);
  const params = context.url.searchParams;
  const job = checkJobId(params.get("job"));
  const part = Number(params.get("part") || 0);
  if (!Number.isInteger(part) || part < 0 || part > 400) throw new HttpError(400, "Invalid upload part.");
  const final = params.get("final") === "1" ? "1" : "0";
  const name = (params.get("name") || "upload.bin").slice(0, 120);
  const length = Number(context.request.headers.get("content-length") || 0);
  if (length > 60 * 1024 * 1024) throw new HttpError(413, "Upload piece too large.");
  const response = await mediaFetch(job, `/upload?part=${part}&final=${final}&name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...(length ? { "content-length": String(length) } : {}) },
    body: context.request.body,
  });
  if (!response.ok) throw new HttpError(502, "Upload to the media helper failed.");
  return json({ ok: true });
});
