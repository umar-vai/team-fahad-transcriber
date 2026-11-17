/**
 * Worker entry: the Astro site plus the BatchRunner Durable Object
 * that transcribes Google Drive folders in the background.
 */
import { handle } from "@astrojs/cloudflare/handler";

export { BatchRunner } from "./batch/runner";

export default { fetch: handle } satisfies ExportedHandler<Env>;
