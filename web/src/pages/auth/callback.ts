import type { APIRoute } from "astro";
import { completeGoogleLogin } from "../../lib/auth";

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  try {
    const next = await completeGoogleLogin(url, cookies);
    return redirect(next, 302);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign-in failed.";
    return redirect(`/login?error=${encodeURIComponent(message)}`, 302);
  }
};
