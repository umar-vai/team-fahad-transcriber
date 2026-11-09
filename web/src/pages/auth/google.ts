import type { APIRoute } from "astro";
import { googleConfigured, googleLoginUrl } from "../../lib/auth";

export const GET: APIRoute = ({ url, cookies, redirect }) => {
  if (!googleConfigured()) return redirect("/login?error=setup", 302);
  return redirect(googleLoginUrl(url.origin, cookies, url.searchParams.get("next") || "/"), 302);
};
