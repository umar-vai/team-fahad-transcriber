/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user: import("./lib/auth").User | null;
  }
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MEDIA: Fetcher;
    BATCH_RUNNER: DurableObjectNamespace<import("./batch/runner").BatchRunner>;
    APP_NAME: string;
    ALLOWED_EMAILS?: string;
    GEMINI_API_KEYS?: string;
    GEMINI_API_KEY?: string;
    GEMINI_MODEL?: string;
    GEMINI_API_BASE?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    NOTION_TOKEN?: string;
    NOTION_PARENT_PAGE_ID?: string;
    /** Overridable for local tests only. */
    NOTION_API_BASE?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON?: string;
    SHEETS_SPREADSHEET_ID?: string;
    /** Overridable for local tests only. */
    SHEETS_API_BASE?: string;
    GOOGLE_DRIVE_API_KEY?: string;
    /** Optional: comma separated Drive folder ids to treat as computers (fallback or extras). */
    DRIVE_COMPUTER_FOLDER_IDS?: string;
    /** Overridable for local tests only. */
    DRIVE_API_BASE?: string;
  }
}
interface Env extends Cloudflare.Env {}
