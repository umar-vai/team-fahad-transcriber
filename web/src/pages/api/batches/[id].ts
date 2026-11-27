import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { batchAccess } from "../../../lib/workspaces";

const ID = /^[0-9a-f-]{36}$/;

/** The batch and the owner id its Durable Object checks. Team batches are open to the team's members. */
async function open(context: Parameters<APIRoute>[0], manage: boolean) {
  const user = requireUser(context);
  const id = String(context.params.id || "");
  if (!ID.test(id)) throw new HttpError(404, "Batch not found.");
  const access = await batchAccess(user, id);
  if (!access) throw new HttpError(404, "Batch not found.");
  if (manage && !access.canManage) throw new HttpError(403, "Only a manager of this team can do this.");
  return { stub: env.BATCH_RUNNER.getByName(id), ownerId: access.ownerId, workspaceId: access.workspaceId, canManage: access.canManage };
}

/** Live progress, read from the batch's Durable Object. */
export const GET: APIRoute = handler(async (context) => {
  const { stub, ownerId, workspaceId, canManage } = await open(context, false);
  const status = await stub.status(ownerId);
  if (!status) throw new HttpError(404, "Batch not found.");
  return json({ ...status, workspaceId, canManage });
});

/** {action: "cancel"} stops the batch; {action: "resume"} retries failed videos and missing exports. */
export const POST: APIRoute = handler(async (context) => {
  const body: any = await context.request.json().catch(() => ({}));
  const { stub, ownerId } = await open(context, true);
  let ok = false;
  if (body.action === "cancel") ok = await stub.cancel(ownerId);
  else if (body.action === "resume") ok = await stub.resume(ownerId);
  else throw new HttpError(400, "Unknown action.");
  if (!ok) throw new HttpError(404, "Batch not found.");
  return json({ ok: true });
});
