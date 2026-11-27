import { defineMiddleware } from "astro:middleware";
import { currentUser } from "./lib/auth";
import { hasAutoAccess, isAdmin } from "./lib/workspaces";

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = null;
  context.locals.isAdmin = false;
  context.locals.autoAccess = false;
  try {
    const user = await currentUser(context.cookies);
    context.locals.user = user;
    if (user) {
      context.locals.isAdmin = isAdmin(user);
      // Only pages need this (for the navigation); API routes check access themselves.
      if (!context.url.pathname.startsWith("/api/")) context.locals.autoAccess = await hasAutoAccess(user);
    }
  } catch (error) {
    console.error("session lookup failed", error);
  }
  const response = await next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
});
