import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "./with-app-env.mjs";

const script = join(projectRoot(), "scripts/deploy-server.sh");
const run = (args, env = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("deploy-server.sh parses and prints its usage", () => {
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--from-ref <ref>/);
  assert.equal(run(["--bogus"]).status, 64);
});

// A stub PATH: git records its calls, npm's loop:fixing fails (a PR at FIXING), pm2 records a restart.
function stubs(npmExit) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-stub-"));
  const log = join(dir, "calls.log");
  const bin = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); };
  bin("git", `echo "git $*" >> ${log}; exit 0`);
  bin("npm", `echo "npm $*" >> ${log}; exit ${npmExit}`);
  bin("pm2", `echo "pm2 $*" >> ${log}; exit 0`);
  bin("curl", `echo '{"jobs":[],"bridge":{"workerStatus":{"activeJobs":0}}}'`);
  return { env: { PATH: `${dir}:/usr/bin:/bin` }, calls: () => readFileSync(log, "utf8") };
}

test("a PR at FIXING stops the deploy before the checkout or pm2 is touched", () => {
  const s = stubs(1);
  const out = run(["--from-ref", "origin/some-branch"], s.env);
  assert.notEqual(out.status, 0);
  assert.doesNotMatch(s.calls(), /git checkout|pm2 restart/);
});

test("--check runs the gates and changes nothing", () => {
  const s = stubs(0);
  const out = run(["--check"], s.env);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /gates pass/);
  assert.doesNotMatch(s.calls(), /git checkout|pm2 restart/);
});
