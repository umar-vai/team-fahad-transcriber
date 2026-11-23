import type { APIRoute } from "astro";
import { handler, json, requireUser } from "../../../lib/http";
import { approveLogin, loginRequestInfo, pollLogin, startLogin } from "../../../lib/bridge";

/**
 * "Sign in with Google" from the app.
 *   start   (the app, no login)   -> a secret requestId for the app and a short code for the person
 *   poll    (the app, no login)   -> pending, or the PC's token once the person approved
 *   info    (website, signed in)  -> which computer asks for this code
 *   approve (website, signed in)  -> the signed-in person allows that computer
 */
export const POST: APIRoute = handler(async (context) => {
  const body: any = await context.request.json().catch(() => ({}));
  switch (String(body.action)) {
    case "start":
      return json(await startLogin(String(body.name || "")));
    case "poll":
      return json(await pollLogin(String(body.requestId || "")));
    case "info": {
      requireUser(context);
      return json({ request: await loginRequestInfo(String(body.code || "")) });
    }
    case "approve": {
      const user = requireUser(context);
      return json({ ok: true, ...(await approveLogin(user.id, String(body.code || ""))) });
    }
    default:
      return json({ error: "Unknown action." }, 400);
  }
});
