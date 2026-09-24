import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "./with-app-env.mjs";

// Every tests/review/*.e2e.mjs runs somewhere: the Node-only files in `npm run test:e2e` (and so
// in `npm test`), the Chromium files in `npm run test:browser` and in CI's browser job. An
// unregistered file (a new fix/extension case in a file nobody runs) would pass by being skipped.
const e2eFiles = () => readdirSync(join(projectRoot(), "tests/review")).filter((f) => f.endsWith(".e2e.mjs"));
const listed = (command) => new Set([...String(command ?? "").matchAll(/tests\/review\/([\w.-]+\.e2e\.mjs)/g)].map((m) => m[1]));

test("every e2e file is registered in test:e2e or test:browser, and CI runs the same sets", () => {
  const scripts = JSON.parse(readFileSync(join(projectRoot(), "package.json"), "utf8")).scripts;
  const node = listed(scripts["test:e2e"]);
  const browser = listed(scripts["test:browser"]);
  const workflow = listed(readFileSync(join(projectRoot(), ".github/workflows/review-regressions.yml"), "utf8"));
  for (const file of e2eFiles()) {
    assert.ok(node.has(file) || browser.has(file), `${file} is in neither test:e2e nor test:browser`);
    assert.ok(workflow.has(file), `${file} is not run by CI`);
  }
  for (const file of node) assert.equal(browser.has(file), false, `${file} is in both sets`);
});
