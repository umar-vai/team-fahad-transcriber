import { Container } from "@cloudflare/containers";

interface Env {
  MEDIA_CONTAINER: DurableObjectNamespace<MediaContainer>;
  FACEBOOK_COOKIES?: string;
  YTDLP_COOKIES?: string;
  YOUTUBE_COOKIES?: string;
}

/**
 * One container per transcription job. It downloads links or receives large
 * uploads, converts them to small MP3 and splits them into 5 minute parts.
 */
export class MediaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = {};
    for (const name of ["FACEBOOK_COOKIES", "YTDLP_COOKIES", "YOUTUBE_COOKIES"] as const) {
      if (env[name]) vars[name] = String(env[name]);
    }
    this.envVars = vars;
  }
}

/**
 * Only reachable through the service binding from the main web Worker
 * (no public route and workers.dev is off).
 * Path format: /job/<job-id>/<container path>
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/job\/([A-Za-z0-9-]{8,64})(\/.*)$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    const [, jobId, rest] = match;
    const target = new URL(rest + url.search, "http://container");
    const container = env.MEDIA_CONTAINER.getByName(jobId);
    return container.fetch(new Request(target, request));
  },
} satisfies ExportedHandler<Env>;
