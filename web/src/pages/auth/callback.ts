import type { APIRoute } from "astro";
import { completeDriveConnect, completeGoogleLogin, isDriveCallback } from "../../lib/auth";

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  if (isDriveCallback(url, cookies)) {
    try {
      await completeDriveConnect(url, cookies);
      return redirect("/auto?connected=1", 302);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Drive connect failed.";
      return redirect(`/auto?error=${encodeURIComponent(message)}`, 302);
    }
  }
  try {
    const next = await completeGoogleLogin(url, cookies);
    return redirect(next, 302);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign-in failed.";
    return redirect(`/login?error=${encodeURIComponent(message)}`, 302);
  }
};
