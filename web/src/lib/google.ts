/**
 * Google service account access for the team workspace (Sheets, and Drive folder listing).
 *
 * Secrets:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the whole JSON key file of a service account
 * The Google Cloud project of that account needs the Google Sheets API and Google Drive API enabled.
 */
import { env } from "cloudflare:workers";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

let cachedToken: { token: string; until: number } | null = null;
let cachedKey: { pem: string; key: CryptoKey } | null = null;

export function serviceAccount(): ServiceAccount | null {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  // The key file as pasted, or base64 of it.
  for (const text of [raw, () => atob(raw.trim())]) {
    try {
      const parsed = JSON.parse(typeof text === "function" ? text() : text);
      if (parsed?.client_email && parsed?.private_key) return parsed as ServiceAccount;
    } catch {}
  }
  console.error("GOOGLE_SERVICE_ACCOUNT_JSON is not a valid service account key file.");
  return null;
}

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signingKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key;
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  cachedKey = { pem, key };
  return key;
}

/** OAuth access token for the service account (cached until shortly before it expires). */
export async function googleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.token;
  const account = serviceAccount();
  if (!account) throw new Error("Google service account is not configured (GOOGLE_SERVICE_ACCOUNT_JSON).");
  const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: GOOGLE_SCOPES, aud: tokenUri, iat: now, exp: now + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(account.private_key), new TextEncoder().encode(`${header}.${claims}`));
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${base64url(signature)}` }),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google service account sign-in failed: ${payload.error_description || payload.error || response.status}`);
  }
  cachedToken = { token: payload.access_token, until: Date.now() + (Number(payload.expires_in) || 3600) * 1000 - 120_000 };
  return cachedToken.token;
}

/** JSON request to a Google API with the service account token. */
export async function googleApi(url: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: init.method || (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${await googleAccessToken()}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let payload: any = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: { message: text.slice(0, 300) } };
    }
    if (response.ok) return payload;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
      continue;
    }
    const error = new Error(String(payload?.error?.message || `Google API error ${response.status}`));
    (error as any).status = response.status;
    throw error;
  }
}
