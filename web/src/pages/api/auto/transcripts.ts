import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handler, json } from "../../../lib/http";
import { requireWorkspace } from "../../../lib/workspaces";

/** The team's transcripts (nightly Drive jobs and team Bridge PCs), newest first, with an optional search. */
export const GET: APIRoute = handler(async (context) => {
  const access = await requireWorkspace(context);
  const q = (context.url.searchParams.get("q") || "").trim().slice(0, 200);
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const before = Number(context.url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
  const rows = await env.DB.prepare(
    `SELECT id, title, source_type, source_ref, mode, language, duration, created_at, substr(transcript, 1, 200) AS preview
       FROM transcriptions
      WHERE workspace_id = ? AND created_at < ? AND (? = '' OR title LIKE ? OR source_ref LIKE ? OR transcript LIKE ?)
      ORDER BY created_at DESC LIMIT 60`,
  )
    .bind(access.workspace.id, before, q, like, like, like)
    .all<any>();
  return json({ items: rows.results, more: rows.results.length === 60 });
});
