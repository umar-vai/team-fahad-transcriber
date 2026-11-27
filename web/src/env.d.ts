/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user: import("./lib/auth").User | null;
    /** The signed-in person is an admin (manages every team). */
    isAdmin: boolean;
    /** The signed-in person may open the Auto page (admin, or member of a team). */
    autoAccess: boolean;
  }
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BATCH_RUNNER: DurableObjectNamespace<import("./batch/runner").BatchRunner>;
    /** Forwards Gemini requests from North America when Gemini refuses the server's location. */
    GEMINI_RELAY?: DurableObjectNamespace<import("./lib/geminirelay").GeminiRelay>;
    APP_NAME: string;
    /** Optional: shown on the public About page under Contact. */
    CONTACT_EMAIL?: string;
    CONTACT_PHONE?: string;
    ALLOWED_EMAILS?: string;
    /** Comma separated admin emails (they manage every team). Empty: the built-in owner accounts. */
    ADMIN_EMAILS?: string;
    /** Local development only: "1" shows a sign-in form without Google on localhost. */
    DEV_LOGIN?: string;
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
