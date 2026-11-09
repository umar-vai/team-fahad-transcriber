// Fallback deploy helper: embeds dist/client files into the Worker so it can be
// deployed without the static asset upload step (used when that upload is blocked).
// Normal deploys (`npm run deploy`, GitHub Actions) do not need this.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../dist/", import.meta.url).pathname;
const client = join(root, "client");
const types = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain" };

const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (!name.startsWith(".") && name !== "_headers") {
      const ext = name.slice(name.lastIndexOf("."));
      files["/" + relative(client, path)] = { type: types[ext] || "application/octet-stream", b64: readFileSync(path).toString("base64") };
    }
  }
})(client);

writeFileSync(join(root, "server", "inline-entry.mjs"), `import astro from "./entry.mjs";
const FILES = ${JSON.stringify(files)};
const cache = new Map();
function serve(request) {
  const path = new URL(request.url).pathname;
  const file = FILES[path];
  if (!file) return new Response("Not found", { status: 404 });
  let body = cache.get(path);
  if (!body) { body = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0)); cache.set(path, body); }
  const immutable = path.startsWith("/_astro/");
  return new Response(body, { headers: { "content-type": file.type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600" } });
}
const ASSETS = { fetch: (input) => serve(input instanceof Request ? input : new Request(input)) };
export default {
  async fetch(request, env, ctx) {
    if (FILES[new URL(request.url).pathname]) return serve(request);
    return astro.fetch(request, { ...env, ASSETS }, ctx);
  },
};
`);

const config = JSON.parse(readFileSync(join(root, "server", "wrangler.json"), "utf8"));
delete config.assets;
config.main = "inline-entry.mjs";
writeFileSync(join(root, "server", "wrangler.inline.json"), JSON.stringify(config, null, 2));
console.log(`Embedded ${Object.keys(files).length} static files.`);
