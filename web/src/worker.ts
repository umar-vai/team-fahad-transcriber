/**
 * Worker entry: the Astro site, the BatchRunner Durable Object that transcribes
 * Google Drive folders in the background, and the cron jobs of the nightly Drive automation.
 */
import { handle } from "@astrojs/cloudflare/handler";
import { NIGHTLY_CRON, nightlyRun, pumpJobs } from "./lib/autodrive";

export { BatchRunner } from "./batch/runner";

export default {
  fetch: handle,
  async scheduled(controller, _env, ctx) {
    // 23:50 Bangladesh time: find the day's new files and queue them. Every 5 minutes: keep the queue moving.
    const work = controller.cron === NIGHTLY_CRON ? nightlyRun() : pumpJobs();
    ctx.waitUntil(work.catch((error) => console.error(`Scheduled run (${controller.cron}) failed:`, error)));
  },
} satisfies ExportedHandler<Env>;
