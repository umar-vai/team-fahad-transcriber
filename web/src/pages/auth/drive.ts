import type { APIRoute } from "astro";
import { driveConnectUrl, googleConfigured } from "../../lib/auth";

/** Start connecting the Drive account that holds the Computers folders. Needs a signed-in user. */
export const GET: APIRoute = ({ url, cookies, redirect, locals }) => {
  if (!locals.user) return redirect("/login?next=/auto", 302);
  if (!googleConfigured()) return redirect("/login?error=setup", 302);
  return redirect(driveConnectUrl(url.origin, cookies), 302);
};
