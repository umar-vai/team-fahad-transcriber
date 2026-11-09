// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://transcribe.abdullahfahad.com",
  output: "server",
  // Login sessions live in D1, so Astro's KV-backed sessions are not needed.
  session: false,
  adapter: cloudflare({ imageService: "passthrough" }),
  security: { checkOrigin: true },
});
