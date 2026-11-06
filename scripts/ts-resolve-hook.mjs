// Node module hook for scripts that import app sources directly (scripts/replay-local-pipeline.mjs): the
// app's server modules use extensionless relative imports ("./types"), which Vite resolves and Node does
// not. A relative specifier with no extension is tried as ".ts", then "/index.ts". Nothing else changes.
import { register } from "node:module";

if (import.meta.url && !globalThis.__ashlarTsResolve) {
  globalThis.__ashlarTsResolve = true;
  register(new URL(import.meta.url), { data: { hook: true } });
}

export async function resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
    for (const suffix of [".ts", "/index.ts"]) {
      try {
        return await next(specifier + suffix, context);
      } catch {
        /* try the next form */
      }
    }
  }
  return next(specifier, context);
}
