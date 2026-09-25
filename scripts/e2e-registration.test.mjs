import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "./with-app-env.mjs";

// Every tests/review/*.e2e.mjs runs somewhere. package.json is the ONE filename registry: the
// Node-only files in `test:e2e` (and so in `npm test`), the Chromium files in `test:browser`
// (its `test:browser:dom` + `test:browser:mv3` parts). CI must execute those npm scripts in its
// run steps; a filename that only appears in the workflow text (a comment, an echo, an inline
// node command) is never counted, so an unregistered file cannot pass by being skipped.
const e2eFiles = () => readdirSync(join(projectRoot(), "tests/review")).filter((f) => f.endsWith(".e2e.mjs"));
const listed = (command) => new Set([...String(command ?? "").matchAll(/tests\/review\/([\w.-]+\.e2e\.mjs)/g)].map((m) => m[1]));

/** The shell text of every `run:` step (single-line or block scalar), YAML comments and shell
 * comment lines removed. */
export function workflowRunCommands(yaml) {
  const lines = String(yaml).split("\n");
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const value = m[2].replace(/\s+#.*$/, "").trim();
    if (/^[|>][+-]?$/.test(value)) {
      const body = [];
      for (; i + 1 < lines.length && (!lines[i + 1].trim() || /^\s*/.exec(lines[i + 1])[0].length > indent); i++) body.push(lines[i + 1]);
      commands.push(body.filter((line) => !line.trim().startsWith("#")).map((line) => line.replace(/\s+#.*$/, "")).join("\n"));
    } else if (value && !value.startsWith("#")) {
      commands.push(value);
    }
  }
  return commands;
}

/** The npm scripts a command runs (`npm test`, `npm run x`), expanded through nested `npm run`. */
export function npmScriptsRun(command, scripts, seen = new Set()) {
  for (const m of String(command).matchAll(/\bnpm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test)\b)/g)) {
    const name = m[1] || m[2];
    if (seen.has(name) || !(name in scripts)) continue;
    seen.add(name);
    npmScriptsRun(scripts[name], scripts, seen);
  }
  return seen;
}

/** The e2e files CI executes: only through the registered npm scripts its run steps invoke. */
export function ciE2eFiles(yaml, scripts) {
  const names = new Set();
  for (const command of workflowRunCommands(yaml)) for (const name of npmScriptsRun(command, scripts)) names.add(name);
  return new Set([...names].flatMap((name) => [...listed(scripts[name])]));
}

test("every e2e file is registered in test:e2e or test:browser, and CI runs those npm scripts", () => {
  const scripts = JSON.parse(readFileSync(join(projectRoot(), "package.json"), "utf8")).scripts;
  const node = listed(scripts["test:e2e"]);
  const browser = new Set([...npmScriptsRun("npm run test:browser", scripts)].flatMap((name) => [...listed(scripts[name])]));
  const ci = ciE2eFiles(readFileSync(join(projectRoot(), ".github/workflows/review-regressions.yml"), "utf8"), scripts);
  for (const file of e2eFiles()) {
    assert.ok(node.has(file) || browser.has(file), `${file} is in neither test:e2e nor test:browser`);
    assert.ok(ci.has(file), `${file} is not run by CI (its run steps must execute the npm script that lists it)`);
  }
  for (const file of node) assert.equal(browser.has(file), false, `${file} is in both sets`);
});

test("the CI guard counts only npm scripts a run step executes", () => {
  const scripts = {
    "test:e2e": "node --test tests/review/a.e2e.mjs",
    "test:browser": "npm run test:browser:dom && npm run test:browser:mv3",
    "test:browser:dom": "node --test tests/review/b.e2e.mjs",
    "test:browser:mv3": "node --test tests/review/c.e2e.mjs",
    test: "node --test x && npm run test:e2e",
  };
  const runs = `jobs:\n  a:\n    steps:\n      - run: npm test\n      - name: dom\n        run: |\n          set -o pipefail\n          npm run test:browser:dom 2>&1 | tee log\n      - run: npm run test:browser:mv3 # MV3\n`;
  assert.deepEqual([...ciE2eFiles(runs, scripts)].sort(), ["a.e2e.mjs", "b.e2e.mjs", "c.e2e.mjs"]);
  // A filename (or an npm script) that only appears in a YAML or shell comment does not count.
  const commented = `jobs:\n  a:\n    steps:\n      # npm run test:browser:dom runs tests/review/b.e2e.mjs\n      - run: npm test # npm run test:browser:mv3\n      - run: |\n          # npm run test:browser:dom\n          echo done\n`;
  assert.deepEqual([...ciE2eFiles(commented, scripts)], ["a.e2e.mjs"]);
  // An inline node command naming the file bypasses the registry: not counted either.
  const inline = `jobs:\n  a:\n    steps:\n      - run: node --test tests/review/b.e2e.mjs tests/review/c.e2e.mjs\n`;
  assert.deepEqual([...ciE2eFiles(inline, scripts)], []);
});
