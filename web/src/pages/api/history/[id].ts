import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { transcriptAccess } from "../../../lib/workspaces";

async function load(context: Parameters<APIRoute>[0], edit: boolean) {
  const user = requireUser(context);
  const found = await transcriptAccess(user, String(context.params.id || ""));
  if (!found) throw new HttpError(404, "Not found.");
  if (edit && !found.canEdit) throw new HttpError(403, "Only a manager of this team can change team transcripts.");
  return found.row;
}

export const GET: APIRoute = handler(async (context) => json(await load(context, false)));

/** Update the title or transcript, or store AI tool results (summary, translations...). */
export const PATCH: APIRoute = handler(async (context) => {
  const body: any = await context.request.json().catch(() => ({}));
  // Saving AI results (summary, translation) is allowed for everyone who can open the transcript.
  const changesText = (typeof body.title === "string" && body.title.trim()) || (typeof body.transcript === "string" && body.transcript.trim());
  const row = await load(context, Boolean(changesText));
  const id = row.id;
  if (typeof body.title === "string" && body.title.trim()) {
    await env.DB.prepare("UPDATE transcriptions SET title = ? WHERE id = ?").bind(body.title.trim().slice(0, 200), id).run();
  }
  if (typeof body.transcript === "string" && body.transcript.trim()) {
    if (body.transcript.length > 1_500_000) throw new HttpError(413, "Transcript too large to save.");
    // Shayari mode saves the pronunciation first and adds the Bangla meaning when it arrives.
    await env.DB.prepare("UPDATE transcriptions SET transcript = ? WHERE id = ?").bind(body.transcript, id).run();
  }
  if (body.extras && typeof body.extras === "object") {
    const extras = { ...JSON.parse(row.extras_json || "{}") };
    for (const [key, value] of Object.entries(body.extras)) {
      if (/^[\w:-]{1,40}$/.test(key) && typeof value === "string") extras[key] = value.slice(0, 300_000);
    }
    await env.DB.prepare("UPDATE transcriptions SET extras_json = ? WHERE id = ?").bind(JSON.stringify(extras), id).run();
  }
  return json({ ok: true });
});

export const DELETE: APIRoute = handler(async (context) => {
  const row = await load(context, true);
  await env.DB.prepare("DELETE FROM transcriptions WHERE id = ?").bind(row.id).run();
  return json({ ok: true });
});
