import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envFilesForMode, envWatchIgnorePlugin } from "./env-watch-plugin.mjs";
import { projectRoot } from "./with-app-env.mjs";

const ROOT = projectRoot();

/** Run the plugin's hooks the way Vite does and return the watcher predicate. */
function ignoredFor(resolved) {
  const plugin = envWatchIgnorePlugin();
  const ignored = plugin.config().server.watch.ignored;
  plugin.configResolved(resolved);
  assert.equal(ignored.length, 1);
  return ignored[0];
}

test("matches Vite's env file list for the mode", () => {
  assert.deepEqual(envFilesForMode("development", "/srv/app"), [
    "/srv/app/.env",
    "/srv/app/.env.local",
    "/srv/app/.env.development",
    "/srv/app/.env.development.local",
  ]);
  assert.deepEqual(envFilesForMode("development", false), []);
});

test("the watcher ignores the resolved env files and nothing else", () => {
  const ignored = ignoredFor({ mode: "development", envDir: "/srv/app" });
  for (const f of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    assert.equal(ignored(`/srv/app/${f}`), true, f);
  }
  for (const f of ["vite.config.ts", "src/lib/harbor.server.ts", "src/routes/index.tsx", ".env.example", ".env.production"]) {
    assert.equal(ignored(`/srv/app/${f}`), false, f);
  }
  assert.equal(ignored("/srv/other/.env"), false);
  assert.equal(ignoredFor({ mode: "development", envDir: false })("/srv/app/.env"), false);
});

/**
 * Child process: start the real dev server from vite.config.ts with a temp envDir and cacheDir
 * (the developer's .env and node_modules/.vite are never written), write the env files Vite
 * restarts on, and report what happened. A child, not this worker: `import "vite"` loads rolldown
 * native bindings that SIGSEGV under qemu-user (see check-auth-invariant.test.mjs).
 */
const PROBE = `
import { createServer } from "vite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [envDir, cacheDir] = process.argv.slice(1);
const logs = [];
const logger = {
  hasWarned: false,
  info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), warnOnce: (m) => logs.push(String(m)),
  error: (m) => logs.push(String(m)), clearScreen() {}, hasErrorLogged: () => false,
};
const server = await createServer({
  configFile: join(process.cwd(), "vite.config.ts"),
  envDir, cacheDir, customLogger: logger, clearScreen: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen();
let restarts = 0;
const restart = server.restart.bind(server);
server.restart = (...a) => { restarts++; return restart(...a); };
const httpServer = server.httpServer;
await new Promise((r) => setTimeout(r, 500));
writeFileSync(join(envDir, ".env"), "ASHLAR_REVIEW_LOCAL=true\\n");
writeFileSync(join(envDir, ".env.local"), "ASHLAR_LOCAL_LEASE_CAPACITY=2\\n");
await new Promise((r) => setTimeout(r, 1500));
const watched = server.watcher.getWatched();
const out = {
  restarts,
  restartLogs: logs.filter((l) => l.includes("restarting server") || l.includes("server restarted")),
  sameHttpServer: server.httpServer === httpServer && httpServer.listening,
  srcWatched: (watched[join(process.cwd(), "src")] ?? []).includes("lib"),
};
await server.close();
process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
process.exit(0);
`;

test("the project's dev server does not restart when .env is written", { timeout: 120_000 }, async (t) => {
  const envDir = mkdtempSync(join(tmpdir(), "ashlar-envdir-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "ashlar-vite-cache-"));
  writeFileSync(join(envDir, ".env"), "ASHLAR_REVIEW_LOCAL=false\n");
  // The TanStack router plugin may regenerate this tracked file on start; put it back.
  const routeTree = join(ROOT, "src/routeTree.gen.ts");
  const routeTreeBefore = readFileSync(routeTree, "utf8");
  let child;
  try {
    child = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ["--input-type=module", "-e", PROBE, envDir, cacheDir],
        { cwd: ROOT, timeout: 100_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
  } finally {
    if (readFileSync(routeTree, "utf8") !== routeTreeBefore) writeFileSync(routeTree, routeTreeBefore);
    rmSync(envDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
  const line = child.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line && child.error?.signal === "SIGSEGV") {
    t.skip("vite crashed loading native bindings (qemu-user); the config-level tests above still cover the plugin");
    return;
  }
  assert.ok(line, `probe produced no result: ${child.error?.message ?? ""}\n${child.stderr}`);
  const result = JSON.parse(line.slice("RESULT ".length));
  assert.deepEqual(result.restartLogs, [], "Vite logged a restart for an .env write");
  assert.equal(result.restarts, 0, "server.restart() was called for an .env write");
  assert.equal(result.sameHttpServer, true, "the original http server is no longer listening");
  assert.equal(result.srcWatched, true, "source files must stay watched for HMR");
});
