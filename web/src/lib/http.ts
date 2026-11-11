import type { APIContext } from "astro";
import { GeminiError, TranscriptionQualityError, UserFacingError } from "./gemini";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function requireUser(context: APIContext) {
  const user = context.locals.user;
  if (!user) throw new HttpError(401, "Please sign in first.");
  return user;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wrap an API handler so errors become clear JSON messages. */
export function handler(fn: (context: APIContext) => Promise<Response>) {
  return async (context: APIContext) => {
    try {
      return await fn(context);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof TranscriptionQualityError) return json({ error: error.message }, 422);
      if (error instanceof UserFacingError) return json({ error: error.message }, 502);
      if (error instanceof GeminiError) return json({ error: error.message }, 502);
      console.error(error);
      return json({ error: "Something went wrong on the server. Please try again." }, 500);
    }
  };
}
