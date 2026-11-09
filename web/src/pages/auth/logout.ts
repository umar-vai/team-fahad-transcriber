import type { APIRoute } from "astro";
import { logout } from "../../lib/auth";

export const POST: APIRoute = async ({ cookies, redirect }) => {
  await logout(cookies);
  return redirect("/login", 303);
};
