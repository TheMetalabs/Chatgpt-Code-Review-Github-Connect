import test from "node:test";
import assert from "node:assert/strict";
import { runLocalReviewLoop, groupChangedFiles, chooseLocalReviewMode } from "../../src/lib/local-review-loop.server.ts";
import { DEFAULT_SETTINGS } from "../../src/lib/types.ts";

const settings = { ...DEFAULT_SETTINGS, reviewLocal: true, localLlmBaseUrl: "http://local/v1/", localLlmModel: "m", localLlmApiKey: "k" };

function sampleWith(paths) {
  return {
    key: "t", owner: "o", repo: "r", pr: 1, title: "t", body: "", sender: "s",
    headSha: "h", baseSha: "b", isFork: false, isDraft: false, labels: [],
    changedPaths: paths,
    files: paths.map((p) => ({ path: p, content: `export function fn_${p.replace(/\W/g, "_")}() {\n  return 1;\n}\n`, language: "ts" })),
    diff: paths.map((p) => `--- ${p}\n@@ -1,2 +1,3 @@\n export function fn() {\n+  changed();\n   return 1;`).join("\n\n"),
    diffDroppedPaths: [],
  };
}

function assistant(content, tools = []) {
  return { choices: [{ finish_reason: tools.length ? "tool_calls" : "stop", message: { content, tool_calls: tools.length ? tools : undefined } }], usage: { prompt_tokens: 100 } };
}
const toolCall = (name, args, id = "c1") => ({ id, function: { name, arguments: JSON.stringify(args) } });
const REVIEW_JSON = JSON.stringify({ merge_recommendation: "REQUEST_CHANGES", findings: [{ severity: "P1", file: "src/pay.ts", line: 2, title: "bug", failure_scenario: "x", evidence: "y" }], investigated_safe: [], coverage: [] });

function mock(script) {
  const bodies = [];
  let i = 0;
  const request = async (_baseURL, _apiKey, path, body) => {
    if (path === "models") return { data: [] };
    bodies.push(body);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return typeof step === "function" ? step(body) : step;
  };
  return { request, bodies };
}

test("tool loop serves file_read from the snapshot and returns gate-shaped JSON", async () => {
  const { request, bodies } = mock([
    assistant("", [toolCall("file_read", { file_path: "src/pay.ts" })]),
    assistant(REVIEW_JSON),
  ]);
  const out = await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  assert.equal(out.ok, true);
  assert.match(out.raw, /"findings"/);
  // The second request must carry the tool result for file_read.
  const toolMsg = bodies[1].messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && /File: src\/pay\.ts/.test(toolMsg.content), "file_read output fed back to the model");
});

test("every generation sends a completion budget and non-greedy sampling", async () => {
  const { request, bodies } = mock([assistant(REVIEW_JSON)]);
  await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  assert.ok(bodies[0].max_tokens >= 8192, "max_tokens must clear thinking + JSON");
  assert.ok(bodies[0].temperature > 0, "non-greedy to avoid repetition loops");
  assert.ok(bodies[0].top_p > 0 && bodies[0].top_k > 0, "nucleus + top-k sampling set");
});

test("already-arrived peer results are injected once as do-not-repeat data", async () => {
  const peer = { provider: "chatgpt", raw: JSON.stringify({ findings: [{ severity: "P2", file: "src/pay.ts", line: 3, title: "peer" }] }) };
  const { request, bodies } = mock([
    assistant("", [toolCall("code_search", { search_text: "changed" })]),
    assistant(REVIEW_JSON),
  ]);
  await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request, peerReported: () => [peer] });
  // All request bodies share the one growing messages array; inspect it once. The peer must be
  // injected exactly once (dedup by provider) even though peerReported() is polled every turn.
  const finalMessages = bodies[bodies.length - 1].messages;
  const injections = finalMessages.filter((m) => typeof m.content === "string" && m.content.includes("ALREADY_REPORTED_BY_PEER chatgpt"));
  assert.equal(injections.length, 1);
  assert.match(injections[0].content, /do not repeat/i);
});

test("context/iteration cap forces a final answer with tools removed", async () => {
  process.env.ASHLAR_LOCAL_REVIEW_TOOL_ITERS = "1";
  try {
    const { request, bodies } = mock([
      assistant("", [toolCall("file_read", { file_path: "src/pay.ts" })]), // iter 1: tools allowed
      assistant(REVIEW_JSON), // iter 2: forced final
    ]);
    const out = await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
    assert.equal(out.ok, true);
    assert.ok(bodies[0].tools, "first turn offers tools");
    assert.equal(bodies[1].tools, undefined, "forced-final turn omits tools");
    assert.ok(bodies[1].messages.some((m) => m.role === "user" && /Tool access has ended/.test(m.content)));
  } finally {
    delete process.env.ASHLAR_LOCAL_REVIEW_TOOL_ITERS;
  }
});

test("grouping splits changed files into size-bounded groups", () => {
  const sample = sampleWith(["a/one.ts", "a/two.ts", "a/three.ts"]);
  const one = groupChangedFiles(sample, { groupMaxChars: 1_000_000, maxFilesPerGroup: 6, toolIterCap: 8, ctxCapTokens: 24_000 });
  assert.equal(one.length, 1, "all files fit one group under a large budget");
  const many = groupChangedFiles(sample, { groupMaxChars: 10, maxFilesPerGroup: 1, toolIterCap: 8, ctxCapTokens: 24_000 });
  assert.equal(many.length, 3, "a one-file cap splits into one group per file");
  assert.deepEqual([...new Set(many.flat())].sort(), ["a/one.ts", "a/three.ts", "a/two.ts"]);
});

test("auto mode picks single for a small PR and multiturn for a large one", () => {
  const max = 30_000; // tokens; ~3.5 chars/token
  // A small PR (well under the budget) stays single-turn: faster, whole-PR view, higher recall.
  assert.equal(chooseLocalReviewMode("auto", 57_000, max), "single"); // ~16K tokens, like #261
  // A large PR (over the budget) goes multiturn: it would not fit one completion window and a single
  // call's KV cache would spike.
  assert.equal(chooseLocalReviewMode("auto", 160_000, max), "multiturn"); // ~46K tokens
  // Exact boundary stays single (<=).
  assert.equal(chooseLocalReviewMode("auto", max * 3.5, max), "single");
});

test("explicit mode overrides size-based auto selection", () => {
  assert.equal(chooseLocalReviewMode("single", 999_999, 30_000), "single");
  assert.equal(chooseLocalReviewMode("multiturn", 1, 30_000), "multiturn");
});

test("no reviewer JSON across groups is an explicit failure, not an empty pass", async () => {
  const { request } = mock([assistant("I could not find the file, sorry.")]);
  const out = await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  assert.equal(out.ok, false);
  assert.match(out.error, /no review JSON/i);
});
