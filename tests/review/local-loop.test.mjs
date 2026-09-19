import test from "node:test";
import assert from "node:assert/strict";
import { runLocalReviewLoop, groupChangedFiles, chooseLocalReviewMode } from "../../src/lib/local-review-loop.server.ts";
import { samplingRequestFields } from "../../src/lib/local-llm.server.ts";
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
  assert.ok(bodies[0].top_p > 0, "nucleus sampling set");
  assert.equal("top_k" in bodies[0], false, "top_k omitted by default for OpenAI compatibility");
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

test("a file larger than the group budget gets its own group", () => {
  // Oversized single file must be isolated so its opening prompt does not blow a finite context.
  const sample = sampleWith(["src/small.ts", "src/huge.ts"]);
  sample.files = sample.files.map((f) => (f.path === "src/huge.ts" ? { ...f, content: "x".repeat(50_000) } : f));
  const groups = groupChangedFiles(sample, { groupMaxChars: 40_000, maxFilesPerGroup: 6, toolIterCap: 8, ctxCapTokens: 24_000, groupContextMaxChars: 60_000 });
  const hugeGroup = groups.find((g) => g.includes("src/huge.ts"));
  assert.deepEqual(hugeGroup, ["src/huge.ts"], "oversized file is alone in its group");
});

test("a path whose diff was dropped by the prompt budget is excluded from groups", () => {
  // With no patch a group cannot see what changed, so grouping it would only fake coverage.
  const sample = sampleWith(["src/a.ts", "src/b.ts"]);
  sample.diffDroppedPaths = ["src/b.ts"];
  const groups = groupChangedFiles(sample, { groupMaxChars: 1_000_000, maxFilesPerGroup: 6, toolIterCap: 8, ctxCapTokens: 24_000, groupContextMaxChars: 60_000 });
  assert.equal(groups.flat().includes("src/b.ts"), false, "dropped-diff path is not grouped");
  assert.equal(groups.flat().includes("src/a.ts"), true, "normal changed path is still grouped");
});

test("grouping keeps a changed code file that is missing from the snapshot", () => {
  // A changed .ts whose content failed to fetch (not in sample.files) must still be grouped so it is
  // reviewed from its diff, not silently dropped from every group.
  const sample = sampleWith(["src/a.ts", "src/b.ts"]);
  sample.files = sample.files.filter((f) => f.path !== "src/b.ts"); // b.ts changed but unfetched
  const groups = groupChangedFiles(sample, { groupMaxChars: 1_000_000, maxFilesPerGroup: 6, toolIterCap: 8, ctxCapTokens: 24_000 });
  assert.ok(groups.flat().includes("src/b.ts"), "missing-from-snapshot changed file is still grouped");
});

test("top_k is sent only when positive so strict OpenAI endpoints do not reject it", () => {
  const base = { maxTokens: 100, temperature: 0.6, top_p: 0.95, presence_penalty: 1.0 };
  const withK = samplingRequestFields({ ...base, top_k: 20 });
  assert.equal(withK.top_k, 20);
  assert.equal(withK.max_tokens, 100);
  const noK = samplingRequestFields({ ...base, top_k: 0 });
  assert.equal("top_k" in noK, false, "top_k omitted when 0 (non-standard OpenAI field)");
  assert.equal(noK.temperature, 0.6); // standard fields still present
});

test("a failed group does not discard groups already reviewed", async () => {
  // A transient request/tool failure in one group must not throw away the whole multi-group run.
  process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP = "1";
  try {
    let call = 0;
    const request = async (_b, _k, path) => {
      if (path === "models") return { data: [] };
      call += 1;
      if (call === 1) throw new Error("transient failure"); // first group's first request
      return assistant(REVIEW_JSON); // later groups succeed
    };
    const out = await runLocalReviewLoop(sampleWith(["src/a.ts", "src/b.ts"]), settings, { request });
    assert.equal(out.ok, true, "one group failing still yields the other group's findings");
    assert.match(out.raw, /"findings"/);
  } finally {
    delete process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP;
  }
});

test("the loop prompt permits tools (strips the one-shot no-tools rule)", async () => {
  const { request, bodies } = mock([assistant(REVIEW_JSON)]);
  await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  const userMsg = bodies[0].messages.find((m) => m.role === "user").content;
  assert.doesNotMatch(userMsg, /do not call tools/i, "the no-tools rule must be removed for the loop");
  assert.match(userMsg, /file_read|local tools/i, "the loop prompt tells the model it has tools");
});

test("a group that completes with non-JSON is marked not_cleared, not silently dropped", async () => {
  process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP = "1";
  try {
    let call = 0;
    const request = async (_b, _k, path) => {
      if (path === "models") return { data: [] };
      call += 1;
      return call === 1 ? assistant("some prose, no JSON here") : assistant(REVIEW_JSON);
    };
    const out = await runLocalReviewLoop(sampleWith(["src/a.ts", "src/b.ts"]), settings, { request });
    assert.equal(out.ok, true);
    const cov = JSON.parse(out.raw).coverage;
    assert.ok(cov.some((c) => c.file === "src/a.ts" && c.status === "not_cleared"), "non-JSON group's file is not_cleared");
  } finally {
    delete process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP;
  }
});

test("provisional JSON on a tool-call turn is not accepted when the final turn has none", async () => {
  // The model emits review JSON while still requesting a tool (provisional), then the terminal turn
  // returns prose. The provisional findings must NOT become the group's result — the lone group then
  // yields no valid JSON, so the leg fails rather than posting unconfirmed findings.
  const { request } = mock([
    assistant(REVIEW_JSON, [toolCall("file_read", { file_path: "src/pay.ts" })]),
    assistant("actually I could not verify anything"),
  ]);
  const out = await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  assert.equal(out.ok, false, "provisional findings from a tool-call turn are not posted");
  assert.match(out.error, /no review JSON/i);
});

test("a path whose diff was dropped is marked not_cleared in the merged result", async () => {
  const sample = sampleWith(["src/a.ts", "src/b.ts"]);
  sample.diffDroppedPaths = ["src/b.ts"];
  const emptySafe = JSON.stringify({ findings: [], merge_recommendation: "COMMENT", investigated_safe: ["a checked"], coverage: [] });
  const { request } = mock([assistant(emptySafe)]);
  const out = await runLocalReviewLoop(sample, settings, { request });
  assert.equal(out.ok, true);
  const merged = JSON.parse(out.raw);
  assert.ok(merged.coverage.some((c) => c.file === "src/b.ts" && c.status === "not_cleared"), "dropped path is not_cleared");
  assert.deepEqual(merged.investigated_safe, [], "empty findings + a dropped path → safe forced empty (not a clean pass)");
});

test("a changed path that literally begins with a/ keeps its diff", async () => {
  const { request, bodies } = mock([assistant(REVIEW_JSON)]);
  await runLocalReviewLoop(sampleWith(["a/foo.ts"]), settings, { request });
  const userMsg = bodies[0].messages.find((m) => m.role === "user").content;
  assert.match(userMsg, /changed\(\)/, "the a/foo.ts patch reaches the prompt (a/ not wrongly stripped)");
});

test("task_done with state FAILED fails the group instead of accepting stale JSON", async () => {
  const { request } = mock([assistant(REVIEW_JSON, [toolCall("task_done", { state: "FAILED" })])]);
  const out = await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  assert.equal(out.ok, false, "a FAILED task_done does not post the group as reviewed");
});

test("no reviewer JSON across groups is an explicit failure, not an empty pass", async () => {
  const { request } = mock([assistant("I could not find the file, sorry.")]);
  const out = await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  assert.equal(out.ok, false);
  assert.match(out.error, /no review JSON/i);
});

test("D1: findings are deduped and sorted by severity before the downstream 8-cap", async () => {
  // 8 P2 findings then 1 P1 — the P1 must be in the top 8 after dedup+sort.
  const p2s = Array.from({ length: 8 }, (_, i) => ({
    severity: "P2", file: "src/a.ts", line: i + 1, title: `p2-${i}`,
    failure_scenario: "x", evidence: "y"
  }));
  const p1 = { severity: "P1", file: "src/b.ts", line: 1, title: "p1", failure_scenario: "x", evidence: "y" };
  const group1 = JSON.stringify({ merge_recommendation: "COMMENT", findings: p2s.slice(0, 4), investigated_safe: [], coverage: [] });
  const group2 = JSON.stringify({ merge_recommendation: "COMMENT", findings: [...p2s.slice(4), p1], investigated_safe: [], coverage: [] });
  process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP = "2";
  try {
    let call = 0;
    const request = async () => {
      call += 1;
      return assistant(call === 1 ? group1 : group2);
    };
    const out = await runLocalReviewLoop(sampleWith(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]), settings, { request });
    assert.equal(out.ok, true);
    const merged = JSON.parse(out.raw);
    assert.equal(merged.findings[0].severity, "P1", "P1 must be first after sort");
    assert.ok(merged.findings.slice(0, 8).some(f => f.severity === "P1"), "P1 must be in top 8");
  } finally {
    delete process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP;
  }
});

test("D1: duplicate findings (same file|line|normalizedTitle) are deduped", async () => {
  const dup = { severity: "P1", file: "src/a.ts", line: 5, title: "Bug Here!", failure_scenario: "x", evidence: "y" };
  const dup2 = { severity: "P1", file: "src/a.ts", line: 5, title: "Bug  here", failure_scenario: "different", evidence: "z" }; // normalized same
  const group1 = JSON.stringify({ merge_recommendation: "COMMENT", findings: [dup], investigated_safe: [], coverage: [] });
  const group2 = JSON.stringify({ merge_recommendation: "COMMENT", findings: [dup2], investigated_safe: [], coverage: [] });
  process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP = "1";
  try {
    let call = 0;
    const request = async () => {
      call += 1;
      return assistant(call === 1 ? group1 : group2);
    };
    const out = await runLocalReviewLoop(sampleWith(["src/a.ts", "src/b.ts"]), settings, { request });
    assert.equal(out.ok, true);
    const merged = JSON.parse(out.raw);
    assert.equal(merged.findings.length, 1, "duplicate findings must be deduped");
  } finally {
    delete process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP;
  }
});

test("D2: partial group failure adds not_cleared coverage and forces empty investigated_safe", async () => {
  // 2 groups: group 2 throws, group 1 returns findings:[] + investigated_safe:["something"].
  // The merged result must have investigated_safe:[] and a not_cleared coverage entry for group 2's file.
  process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP = "1";
  try {
    let call = 0;
    const request = async (_b, _k, path) => {
      if (path === "models") return { data: [] };
      call += 1;
      if (call === 2) throw new Error("group 2 failed"); // second group throws
      return assistant(JSON.stringify({ merge_recommendation: "COMMENT", findings: [], investigated_safe: ["something"], coverage: [] }));
    };
    const out = await runLocalReviewLoop(sampleWith(["src/a.ts", "src/b.ts"]), settings, { request });
    assert.equal(out.ok, true);
    const merged = JSON.parse(out.raw);
    assert.equal(merged.investigated_safe.length, 0, "investigated_safe must be forced to [] when findings empty + group failed");
    const notCleared = merged.coverage.find(c => c.status === "not_cleared");
    assert.ok(notCleared, "coverage must have a not_cleared entry for the failed group's file");
    assert.equal(notCleared.file, "src/b.ts");
    assert.ok(merged.assumptions.some(a => /Local review incomplete/.test(a)), "assumptions must note the failure");
  } finally {
    delete process.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP;
  }
});

test("D3: grouping includes all changedPaths (code, non-code, missing-snapshot)", async () => {
  const sample = sampleWith(["src/a.ts", ".github/workflows/ci.yml"]);
  const groups = groupChangedFiles(sample, { groupMaxChars: 1_000_000, maxFilesPerGroup: 6, toolIterCap: 8, ctxCapTokens: 24_000 });
  const flat = groups.flat();
  assert.ok(flat.includes("src/a.ts"), "code file must be included");
  assert.ok(flat.includes(".github/workflows/ci.yml"), "non-code changed file must be included");
});

test("D4: top_k defaults to 0 (omitted from request) for portable OpenAI-compatible requests", async () => {
  const { request, bodies } = mock([assistant(REVIEW_JSON)]);
  await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request });
  assert.equal("top_k" in bodies[0], false, "top_k must be omitted when default (0)");
  assert.ok(bodies[0].temperature > 0, "temperature still present");
  assert.ok(bodies[0].top_p > 0, "top_p still present");
});

test("D6: user mention text (extra) is threaded into the loop and appears in the prompt", async () => {
  const { request, bodies } = mock([assistant(REVIEW_JSON)]);
  const out = await runLocalReviewLoop(sampleWith(["src/pay.ts"]), settings, { request, extra: "focus on migration rollback" });
  assert.equal(out.ok, true);
  // The extra text must appear in the first request's user message.
  const userMsg = bodies[0].messages.find(m => m.role === "user");
  assert.ok(userMsg && /focus on migration rollback/.test(userMsg.content), "extra text must appear in the prompt");
});
