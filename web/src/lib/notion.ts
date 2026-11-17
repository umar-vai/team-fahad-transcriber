/**
 * Notion export for Drive folder batches.
 *
 * Layout in the team workspace:
 *   <parent page> (NOTION_PARENT_PAGE_ID, shared with the integration)
 *     └─ 📁 <Drive folder name>              one page per folder batch
 *          ├─ info box: Drive link, number of videos, output style, date
 *          └─ table "Transcripts"            one row per video (No., Title, Duration, Status, Drive file, Words, Date)
 *               └─ 🎬 <video title>           open a row to read its full transcript
 *
 * Secrets: NOTION_TOKEN (internal integration secret), NOTION_PARENT_PAGE_ID (page link or id).
 */
import { env } from "cloudflare:workers";
import { clock, type Segment } from "./segments";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const TEXT_LIMIT = 2000;
const BLOCKS_PER_REQUEST = 100;
const BYTES_PER_REQUEST = 350_000;

export interface NotionFolder {
  pageId: string;
  pageUrl: string;
  /** Null when the table could not be created; transcripts are then plain sub-pages. */
  databaseId: string | null;
}

export function notionPageId(raw: string | undefined): string | null {
  const value = String(raw || "").trim();
  const hex = value.replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#].*)?$/i) || value.replace(/-/g, "").match(/([0-9a-f]{32})/i);
  if (!hex) return null;
  const h = hex[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function notionConfigured(): boolean {
  return Boolean(env.NOTION_TOKEN && notionPageId(env.NOTION_PARENT_PAGE_ID));
}

async function notion(path: string, method: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${env.NOTION_API_BASE || API}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.NOTION_TOKEN}`,
        "notion-version": VERSION,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: any = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      const wait = Number(response.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30_000)));
      continue;
    }
    throw new Error(`Notion: ${payload?.message || `error ${response.status}`}`);
  }
}

// ---------- Blocks ----------

type RichText = { type: "text"; text: { content: string; link?: { url: string } | null }; annotations?: Record<string, unknown> };

function richText(content: string, annotations?: Record<string, unknown>, link?: string): RichText[] {
  const out: RichText[] = [];
  for (let i = 0; i < content.length; i += TEXT_LIMIT) {
    const piece: RichText = { type: "text", text: { content: content.slice(i, i + TEXT_LIMIT) } };
    if (link) piece.text.link = { url: link };
    if (annotations) piece.annotations = annotations;
    out.push(piece);
  }
  return out;
}

function paragraph(rich: RichText[]) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: rich.slice(0, 100) } };
}

/** Transcript body: paragraphs for clean text, one timed line per subtitle for the timed style. */
export function transcriptBlocks(transcript: string, segments: Segment[], timed: boolean): any[] {
  if (timed && segments.length) {
    return segments.map((s) =>
      paragraph([
        ...richText(`[${clock(s.start)}] `, { color: "gray", code: true }),
        ...(s.speaker ? richText(`${s.speaker}: `, { bold: true }) : []),
        ...richText(s.text),
      ]),
    );
  }
  const blocks: any[] = [];
  for (const para of transcript.split(/\n\s*\n|\n/)) {
    const text = para.trim();
    if (!text) continue;
    // A paragraph may hold 100 text pieces of 2000 characters; split longer ones into more paragraphs.
    for (let i = 0; i < text.length; i += TEXT_LIMIT * 100) blocks.push(paragraph(richText(text.slice(i, i + TEXT_LIMIT * 100))));
  }
  return blocks;
}

function chunkBlocks(blocks: any[]): any[][] {
  const chunks: any[][] = [];
  let current: any[] = [];
  let bytes = 0;
  for (const block of blocks) {
    const size = JSON.stringify(block).length * 2;
    if (current.length && (current.length >= BLOCKS_PER_REQUEST || bytes + size > BYTES_PER_REQUEST)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(block);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// ---------- Folder page and transcript pages ----------

export async function createNotionFolder(info: {
  folderName: string;
  folderUrl: string;
  fileCount: number;
  modeLabel: string;
  appUrl: string;
  /** A permanent per-computer page: no video count, and the table gets a Date column. */
  ongoing?: boolean;
}): Promise<NotionFolder> {
  const parent = notionPageId(env.NOTION_PARENT_PAGE_ID)!;
  const date = new Date().toISOString().slice(0, 10);
  const page = await notion("pages", "POST", {
    parent: { page_id: parent },
    icon: { type: "emoji", emoji: "📁" },
    properties: { title: { title: richText(info.folderName.slice(0, 200)) } },
    children: [
      {
        object: "block",
        type: "callout",
        callout: {
          icon: { type: "emoji", emoji: "🎬" },
          color: "gray_background",
          rich_text: [
            ...richText("Google Drive folder", { bold: true }, info.folderUrl),
            ...richText(info.ongoing
              ? `  ·  transcribed automatically every night  ·  ${info.modeLabel}  ·  `
              : `  ·  ${info.fileCount} videos  ·  ${info.modeLabel}  ·  ${date}  ·  `),
            ...richText("Open in Team Fahad Transcriber", undefined, info.appUrl),
          ],
        },
      },
    ],
  });
  let databaseId: string | null = null;
  try {
    const database = await notion("databases", "POST", {
      parent: { type: "page_id", page_id: page.id },
      is_inline: true,
      icon: { type: "emoji", emoji: "📝" },
      title: richText("Transcripts"),
      properties: {
        Title: { title: {} },
        "No.": { number: { format: "number" } },
        Duration: { rich_text: {} },
        Status: { select: { options: [{ name: "Done", color: "green" }, { name: "Failed", color: "red" }] } },
        Style: { select: { options: [{ name: "Smart clean", color: "blue" }, { name: "Subtitles (timed)", color: "purple" }] } },
        Words: { number: { format: "number" } },
        "Drive file": { url: {} },
        ...(info.ongoing ? { Date: { date: {} } } : {}),
      },
    });
    databaseId = database.id;
  } catch (error) {
    console.warn("Notion table could not be created; using sub-pages instead.", error);
  }
  return { pageId: page.id, pageUrl: page.url, databaseId };
}

export async function addNotionTranscript(
  folder: NotionFolder,
  item: {
    index: number;
    title: string;
    duration: number | null;
    styleLabel: string;
    status: "Done" | "Failed";
    driveUrl: string;
    words: number;
    blocks: any[];
    /** YYYY-MM-DD, filled in the Date column of per-computer tables. */
    date?: string;
  },
): Promise<{ id: string; url: string }> {
  // The first chunk goes with the new page; the rest is appended in more requests.
  const [first = [], ...rest] = chunkBlocks(item.blocks);
  const pageBody = {
    icon: { type: "emoji", emoji: item.status === "Done" ? "🎬" : "⚠️" },
    children: first,
  };
  let page: any;
  if (folder.databaseId) {
    page = await notion("pages", "POST", {
      ...pageBody,
      parent: { database_id: folder.databaseId },
      properties: {
        Title: { title: richText(item.title.slice(0, 200)) },
        "No.": { number: item.index },
        Duration: { rich_text: item.duration ? richText(clock(item.duration)) : [] },
        Status: { select: { name: item.status } },
        Style: { select: { name: item.styleLabel } },
        Words: { number: item.words },
        "Drive file": { url: item.driveUrl },
        ...(item.date ? { Date: { date: { start: item.date } } } : {}),
      },
    });
  } else {
    page = await notion("pages", "POST", {
      ...pageBody,
      parent: { page_id: folder.pageId },
      properties: { title: { title: richText(`${item.index}. ${item.title}`.slice(0, 200)) } },
    });
  }
  for (const chunk of rest) await notion(`blocks/${page.id}/children`, "PATCH", { children: chunk });
  return { id: page.id, url: page.url };
}

/** Remove an old page (a "Failed" row that was later transcribed successfully). */
export async function archiveNotionPage(pageId: string): Promise<void> {
  await notion(`pages/${pageId}`, "PATCH", { archived: true });
}

/** Add a closing note to the folder page when the batch finishes. */
export async function finishNotionFolder(folder: NotionFolder, summary: string): Promise<void> {
  await notion(`blocks/${folder.pageId}/children`, "PATCH", {
    children: [{ object: "block", type: "callout", callout: { icon: { type: "emoji", emoji: "✅" }, color: "green_background", rich_text: richText(summary) } }],
  });
}
