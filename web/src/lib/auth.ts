/** Google sign-in and D1-backed login sessions. */
import { env } from "cloudflare:workers";
import type { AstroCookies } from "astro";

export const SESSION_COOKIE = "tf_session";
const STATE_COOKIE = "tf_oauth_state";
const SESSION_DAYS = 30;

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function googleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(origin: string): string {
  return `${origin}/auth/callback`;
}

/** Build the Google consent URL and remember the state in a short-lived cookie. */
export function googleLoginUrl(origin: string, cookies: AstroCookies, returnTo: string): string {
  const state = randomToken(24);
  const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  cookies.set(STATE_COOKIE, `${state}|${safeReturn}`, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: String(env.GOOGLE_CLIENT_ID),
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function allowedEmail(email: string): boolean {
  const list = String(env.ALLOWED_EMAILS || "")
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return true;
  const lower = email.toLowerCase();
  return list.some((entry) => (entry.startsWith("@") ? lower.endsWith(entry) : lower === entry));
}

/** Finish Google sign-in: check state, exchange the code, upsert the user, start a session. */
export async function completeGoogleLogin(url: URL, cookies: AstroCookies): Promise<string> {
  const saved = cookies.get(STATE_COOKIE)?.value || "";
  cookies.delete(STATE_COOKIE, { path: "/" });
  const [savedState, returnTo] = saved.split("|");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) throw new Error(`Google sign-in was cancelled (${url.searchParams.get("error")}).`);
  if (!code || !state || !savedState || state !== savedState) throw new Error("Sign-in expired. Please try again.");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: String(env.GOOGLE_CLIENT_ID),
      client_secret: String(env.GOOGLE_CLIENT_SECRET),
      redirect_uri: redirectUri(url.origin),
      grant_type: "authorization_code",
    }),
  });
  const tokens: any = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.access_token) {
    throw new Error(`Google sign-in failed: ${tokens.error_description || tokens.error || tokenResponse.status}`);
  }
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile: any = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile.sub || !profile.email) throw new Error("Could not read your Google profile.");
  if (profile.email_verified === false) throw new Error("Your Google email address is not verified.");
  if (!allowedEmail(profile.email)) throw new Error(`${profile.email} is not allowed to use this app.`);

  const now = Date.now();
  const db = env.DB;
  const existing = await db.prepare("SELECT id FROM users WHERE google_sub = ?").bind(profile.sub).first<{ id: string }>();
  const userId = existing?.id || crypto.randomUUID();
  if (existing) {
    await db
      .prepare("UPDATE users SET email = ?, name = ?, picture = ?, last_login_at = ? WHERE id = ?")
      .bind(profile.email, profile.name || null, profile.picture || null, now, userId)
      .run();
  } else {
    await db
      .prepare("INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(userId, profile.sub, profile.email, profile.name || null, profile.picture || null, now, now)
      .run();
  }

  const token = randomToken();
  const expires = now + SESSION_DAYS * 86400_000;
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, now),
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), userId, now, expires),
  ]);
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86400,
  });
  return returnTo || "/";
}

export async function currentUser(cookies: AstroCookies): Promise<User | null> {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<User>();
  return row || null;
}

export async function logout(cookies: AstroCookies): Promise<void> {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  cookies.delete(SESSION_COOKIE, { path: "/" });
}
