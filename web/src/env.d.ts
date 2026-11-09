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
    APP_NAME: string;
    ALLOWED_EMAILS?: string;
    GEMINI_API_KEYS?: string;
    GEMINI_API_KEY?: string;
    GEMINI_MODEL?: string;
    GEMINI_API_BASE?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
  }
}
interface Env extends Cloudflare.Env {}
