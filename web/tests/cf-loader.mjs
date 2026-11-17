// Node module hooks for tests: "cloudflare:workers" becomes a small stub, and
// extensionless relative imports (as Vite allows) resolve to their .ts file.
import { register } from "node:module";

const stub = new URL("./stubs/cloudflare-workers.mjs", import.meta.url).href;
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(stub)}, shortCircuit: true };
        if (/^\\.{1,2}\\//.test(specifier) && !/\\.[a-z]+$/i.test(specifier)) {
          try { return await next(specifier + ".ts", context); } catch {}
        }
        return next(specifier, context);
      }`),
);
