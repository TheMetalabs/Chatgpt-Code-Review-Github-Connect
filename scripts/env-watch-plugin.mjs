/**
 * Keep the dev server from restarting when a `.env` file is written.
 *
 * Vite watches the env files of the resolved `envDir` (`.env`, `.env.local`,
 * `.env.<mode>`, `.env.<mode>.local`) and restarts the whole dev server when one
 * changes (`handleHMRUpdate`: "<file> changed, restarting server..."). Ashlar
 * writes `.env` at runtime — Settings save, GitHub secrets, bridge token
 * (`writeEnvPatch` in src/lib/dotenv-file.server.ts) — and already applies the
 * new values to `process.env` and the live state in-process. A restart there
 * re-evaluates every server module, which wipes Harbor's in-memory review queue
 * and running jobs on every Settings save.
 *
 * The plugin adds those env files to `server.watch.ignored`, so chokidar never
 * reports them and Vite never restarts for them. Every other file (source HMR,
 * full reloads, `vite.config.ts` and its imports) is watched exactly as before.
 * The list comes from Vite's own resolved `mode` and `envDir`, the same inputs
 * Vite uses to pick the files it restarts for.
 *
 * Trade-off: values Vite itself reads from those files at startup —
 * `server.allowedHosts` (ASHLAR_PUBLIC_HOST / ASHLAR_ALLOWED_HOSTS via
 * `loadEnv` in vite.config.ts) and the `VITE_*` client env — now change only
 * on a process restart (`pm2 restart`), not on an edit of `.env`.
 */
import { join, resolve } from "node:path";

/** Vite's `getEnvFilesForMode`: the env files Vite loads and restarts on. */
export function envFilesForMode(mode, envDir) {
  if (envDir === false || !envDir) return [];
  return [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`].map((file) => resolve(join(envDir, file)));
}

export function envWatchIgnorePlugin() {
  /** Filled in `configResolved`, before the dev server creates its watcher. */
  let envFiles = new Set();
  return {
    name: "ashlar:ignore-env-file-restart",
    apply: "serve",
    config() {
      return {
        server: {
          watch: {
            // Vite appends user `ignored` entries to its defaults; chokidar (anymatch)
            // accepts a predicate, which also covers the explicitly added env paths.
            ignored: [(path) => envFiles.has(resolve(path))],
          },
        },
      };
    },
    configResolved(config) {
      envFiles = new Set(envFilesForMode(config.mode, config.envDir));
    },
  };
}
