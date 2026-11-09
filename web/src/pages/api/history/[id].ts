import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json, requireUser } from "../../../lib/http";

export const GET: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const row = await env.DB.prepare("SELECT * FROM transcriptions WHERE id = ? AND user_id = ?")
    .bind(context.params.id, user.id)
    .first();
  if (!row) throw new HttpError(404, "Not found.");
  return json(row);
});

/** Update the title or store AI tool results (summary, translations...). */
export const PATCH: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  const row = await env.DB.prepare("SELECT extras_json FROM transcriptions WHERE id = ? AND user_id = ?")
    .bind(context.params.id, user.id)
    .first<{ extras_json: string | null }>();
  if (!row) throw new HttpError(404, "Not found.");
  if (typeof body.title === "string" && body.title.trim()) {
    await env.DB.prepare("UPDATE transcriptions SET title = ? WHERE id = ? AND user_id = ?")
      .bind(body.title.trim().slice(0, 200), context.params.id, user.id)
      .run();
  }
  if (body.extras && typeof body.extras === "object") {
    const extras = { ...JSON.parse(row.extras_json || "{}") };
    for (const [key, value] of Object.entries(body.extras)) {
      if (/^[\w:-]{1,40}$/.test(key) && typeof value === "string") extras[key] = value.slice(0, 300_000);
    }
    await env.DB.prepare("UPDATE transcriptions SET extras_json = ? WHERE id = ? AND user_id = ?")
      .bind(JSON.stringify(extras), context.params.id, user.id)
      .run();
  }
  return json({ ok: true });
});

export const DELETE: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  await env.DB.prepare("DELETE FROM transcriptions WHERE id = ? AND user_id = ?").bind(context.params.id, user.id).run();
  return json({ ok: true });
});
