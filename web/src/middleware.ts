import { defineMiddleware } from "astro:middleware";
import { currentUser } from "./lib/auth";

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = null;
  try {
    context.locals.user = await currentUser(context.cookies);
  } catch (error) {
    console.error("session lookup failed", error);
  }
  const response = await next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
});
