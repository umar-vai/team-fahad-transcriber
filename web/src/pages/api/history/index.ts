import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, HttpError, json, requireUser } from "../../../lib/http";

export const GET: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const q = (context.url.searchParams.get("q") || "").trim();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = await env.DB.prepare(
    `SELECT id, title, source_type, source_ref, mode, language, duration, created_at,
            substr(transcript, 1, 220) AS preview
       FROM transcriptions
      WHERE user_id = ? AND (? = '' OR title LIKE ? OR transcript LIKE ?)
      ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(user.id, q, like, like)
    .all();
  return json({ items: rows.results });
});

export const POST: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  const transcript = String(body.transcript || "");
  if (!transcript.trim()) throw new HttpError(400, "Nothing to save.");
  if (transcript.length > 1_500_000) throw new HttpError(413, "Transcript too large to save.");
  const segments = Array.isArray(body.segments) ? body.segments.slice(0, 20000) : [];
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO transcriptions (id, user_id, title, source_type, source_ref, mode, language, duration, transcript, segments_json, extras_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      String(body.title || "Untitled").slice(0, 200),
      String(body.sourceType || "upload").slice(0, 20),
      body.sourceRef ? String(body.sourceRef).slice(0, 1000) : null,
      String(body.mode || "smart").slice(0, 20),
      String(body.language || "").slice(0, 60),
      Number(body.duration) || null,
      transcript,
      JSON.stringify(segments),
      JSON.stringify({}),
      Date.now(),
    )
    .run();
  return json({ id });
});
