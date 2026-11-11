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
  sleepAfter = "5m";

  // Cloudflare's default idle handler sends SIGTERM. The Python HTTP server
  // runs as PID 1 in the container and can remain alive after that signal,
  // leaving all max_instances slots permanently occupied. Forcefully reclaim
  // the container on idle; active jobs poll /status every two seconds.
  override async onActivityExpired(): Promise<void> {
    await this.destroy();
  }

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
    // Explicit cleanup when a job finishes. Never silently swallow release failures.
    if (rest === "/release") {
      try {
        await container.destroy();
        return Response.json({ ok: true });
      } catch (error) {
        console.error("Could not release media container:", error);
        return Response.json({ error: "Could not release media resources." }, { status: 502 });
      }
    }

    try {
      const response = await container.fetch(new Request(target, request));
      // A failed /link request has no job ID on the client, so it otherwise
      // leaks a container until the inactivity timeout.
      if (rest === "/link" && !response.ok) {
        await container.destroy().catch((error) => console.error("Failed link cleanup:", error));
      }
      return response;
    } catch (error) {
      if (rest === "/link") {
        await container.destroy().catch((cleanupError) => console.error("Failed link cleanup:", cleanupError));
      }
      if (/maximum number of running container instances exceeded/i.test(String(error))) {
        return Response.json(
          { error: "The media processors are currently at capacity. Please retry shortly." },
          { status: 503 },
        );
      }
      console.error("Media container request failed:", error);
      return Response.json(
        { error: "The media processor could not start. Please retry." },
        { status: 502 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
