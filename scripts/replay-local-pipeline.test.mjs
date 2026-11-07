// scripts/replay-local-pipeline.mjs end to end against a fake local model server and a saved snapshot:
// it runs the pipeline with the configured model and scores the posted findings against judged labels.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const finding = (title, line) => ({ severity: "P1", file: "a.ts", line, side: "RIGHT", title, failure_scenario: "x fails", root_cause: "rc", evidence: `a.ts:${line} \`export const answer = 42;\``, recommended_fix: "f", recommended_test: "t" });

test("replay: runs the pipeline on a snapshot with the configured local model and scores the posted findings", async (t) => {
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text || "{}");
      const sys = body.messages?.[0]?.content ?? "";
      const content = sys.startsWith("You summarize")
        ? JSON.stringify({ files: [{ file: "a.ts", summary: "changes answer", guards: [], effects: [] }] })
        : /You judge ONE reported defect/.test(sys)
          ? (/judged false positive/.test((/<<<CANDIDATE[^\n]*\n([\s\S]*?)\n<<<END>>>/.exec(body.messages[1].content)?.[1] ?? ""))
            ? JSON.stringify({ verdict: "refuted", reason: "documented", counter_quote: "export const answer = 42;" })
            : JSON.stringify({ verdict: "confirmed", reason: "real", proof_quote: "export const answer = 42;", severity: "P1" }))
          : JSON.stringify({ merge_recommendation: "REQUEST_CHANGES", investigated_safe: ["a.ts: read"], findings: [finding("answer judged valid off by one", 1), finding("answer judged false positive rename", 1)] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const snap = join(dir, "snap.json");
  writeFileSync(snap, JSON.stringify({
    key: "k", owner: "o", repo: "r", pr: 7, title: "t", body: "", sender: "s", headSha: "h", baseSha: "b", isFork: false, isDraft: false, labels: [],
    changedPaths: ["a.ts"], files: [{ path: "a.ts", content: "export const answer = 42;\n", language: "ts" }], diff: "--- a.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;", diffDroppedPaths: [],
  }));
  const expect = join(dir, "expect.json");
  writeFileSync(expect, JSON.stringify([
    { file: "a.ts", keywords: ["off by one"] },
    { file: "a.ts", keywords: ["never reported"] },
  ]));
  const labels = join(dir, "labels.json");
  writeFileSync(labels, JSON.stringify([
    { pr: 7, file: "a.ts", title: "answer judged valid off by one", ourLabel: "valid" },
    { pr: 7, file: "a.ts", title: "answer judged false positive rename", ourLabel: "false_positive" },
  ]));
  const { port } = server.address();
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["--experimental-strip-types", "--import", join(root, "scripts/ts-resolve-hook.mjs"), join(root, "scripts/replay-local-pipeline.mjs"), "--snapshot", snap, "--labels", labels, "--expect", expect, "--mode", "pipeline"], {
      cwd: dir,
      env: { ...process.env, ASHLAR_LOCAL_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, ASHLAR_LOCAL_LLM_MODEL: "fixture", ASHLAR_LOCAL_LLM_STREAM: "false", ASHLAR_REVIEW_LOCAL: "true" },
      timeout: 60_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  const report = JSON.parse(out);
  assert.equal(report.cases[0].pr, "o/r#7");
  const [r] = report.cases[0].results;
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.score, { posted: 1, valid: 1, false_positive: 0, unclear: 0, unjudged: 0, expected: 2, caught: 1 });
  assert.deepEqual(r.recall.map((x) => x.caught), [true, false]);
  assert.match(r.summary, /1 confirmed, 1 refuted, 1 posted/);
  assert.deepEqual(report.totals.pipeline, { reviews: 1, failed: 0, posted: 1, valid: 1, false_positive: 0, expected: 2, caught: 1, seconds: r.seconds });
});

test("replay: a case whose review fails still counts its expected defects in the recall denominator (codex #181)", async (t) => {
  // The model answers nothing usable, so the pipeline fails on the case.
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "no json here" } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const snap = join(dir, "snap.json");
  writeFileSync(snap, JSON.stringify({
    key: "k", owner: "o", repo: "r", pr: 8, title: "t", body: "", sender: "s", headSha: "h", baseSha: "b", isFork: false, isDraft: false, labels: [],
    changedPaths: ["a.ts"], files: [{ path: "a.ts", content: "export const answer = 42;\n", language: "ts" }], diff: "--- a.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;", diffDroppedPaths: [],
  }));
  const expect = join(dir, "expect.json");
  writeFileSync(expect, JSON.stringify([{ file: "a.ts", keywords: ["off by one"] }]));
  const { port } = server.address();
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["--experimental-strip-types", "--import", join(root, "scripts/ts-resolve-hook.mjs"), join(root, "scripts/replay-local-pipeline.mjs"), "--snapshot", snap, "--expect", expect, "--mode", "pipeline"], {
      cwd: dir,
      env: { ...process.env, ASHLAR_LOCAL_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, ASHLAR_LOCAL_LLM_MODEL: "fixture", ASHLAR_LOCAL_LLM_STREAM: "false", ASHLAR_REVIEW_LOCAL: "true" },
      timeout: 60_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  const report = JSON.parse(out);
  assert.equal(report.cases[0].results[0].ok, false);
  assert.equal(report.totals.pipeline.failed, 1);
  assert.equal(report.totals.pipeline.expected, 1);
  assert.equal(report.totals.pipeline.caught, 0);
});
