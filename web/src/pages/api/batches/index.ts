import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { LANGUAGES } from "../../../lib/gemini";
import { handler, HttpError, json, requireUser } from "../../../lib/http";
import { driveFolderId, driveFolderUrl, listDriveFolder } from "../../../lib/drive";
import { BATCH_MODES, type BatchConfig, type BatchMode } from "../../../batch/runner";

/** Folder batches of the signed-in user (one small D1 query). */
export const GET: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const rows = await env.DB.prepare(
    `SELECT id, folder_name, folder_url, mode, total, done_count, failed_count, status, notion_url, sheet_url, created_at, finished_at
       FROM batches WHERE user_id = ? AND workspace_id IS NULL ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(user.id)
    .all();
  return json({ items: rows.results });
});

/** Start transcribing every video in a public Google Drive folder. */
export const POST: APIRoute = handler(async (context) => {
  const user = requireUser(context);
  const body: any = await context.request.json().catch(() => ({}));
  const folderId = driveFolderId(String(body.url || ""));
  if (!folderId) throw new HttpError(400, "Please paste a Google Drive folder link (drive.google.com/drive/folders/...).");
  const mode = String(body.mode || "smart") as BatchMode;
  if (!(mode in BATCH_MODES)) throw new HttpError(400, "Choose Smart clean or Subtitles (timed).");
  const language = String(body.language || "Bangla (Bangladesh)");
  if (!LANGUAGES[language]) throw new HttpError(400, "Unknown language.");
  const vocab = String(body.vocab || "")
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 100);

  const folder = await listDriveFolder(folderId);
  if (!folder.files.length) {
    throw new HttpError(400, `No video or audio files were found in "${folder.name}". Check that the folder is shared as "Anyone with the link".`);
  }

  const id = crypto.randomUUID();
  const config: BatchConfig = {
    id,
    userId: user.id,
    folderId,
    folderName: folder.name,
    folderUrl: driveFolderUrl(folderId),
    mode,
    language,
    vocab,
    appUrl: context.url.origin,
    createdAt: Date.now(),
    total: folder.files.length,
  };
  await env.DB.prepare(
    `INSERT INTO batches (id, user_id, folder_id, folder_name, folder_url, mode, language, total, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  )
    .bind(id, user.id, folderId, folder.name.slice(0, 300), config.folderUrl, mode, language, config.total, config.createdAt)
    .run();
  await env.BATCH_RUNNER.getByName(id, { locationHint: "enam" }).start(config, folder.files.map((f) => ({ id: f.id, path: f.path, name: f.name })));
  return json({ id, folderName: folder.name, total: folder.files.length, listedWith: folder.method });
});
