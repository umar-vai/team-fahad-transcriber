import type { APIRoute } from "astro";
import { devLogin } from "../../lib/auth";

/** Local development only (DEV_LOGIN=1 on localhost): sign in as any email without Google. */
export const POST: APIRoute = async ({ url, cookies, request, redirect }) => {
  const form = await request.formData().catch(() => null);
  const next = String(form?.get("next") || "/");
  try {
    await devLogin(url, cookies, String(form?.get("email") || ""));
    return redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/", 303);
  } catch (error) {
    return redirect(`/login?error=${encodeURIComponent(error instanceof Error ? error.message : "Sign-in failed.")}`, 303);
  }
};
