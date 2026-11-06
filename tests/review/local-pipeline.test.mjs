// The staged local review (src/lib/local-pipeline.server.ts): PR map → feature groups → refute → select.
// The model is a mock that answers by stage (its system message), so each test pins one decision.
import test from "node:test";
import assert from "node:assert/strict";
import {
  evidencePack,
  featureGroups,
  namedSymbols,
  quoteInCode,
  rankSurvivors,
  renderPrMap,
  deterministicMap,
  runLocalReviewPipeline,
  verifySingleTurn,
} from "../../src/lib/local-pipeline.server.ts";
import { DEFAULT_SETTINGS } from "../../src/lib/types.ts";
import { gateLiveSubmission } from "../../src/lib/poster.ts";
import { parseChatSubmission } from "../../src/lib/chat-prompt.ts";

const settings = { ...DEFAULT_SETTINGS, reviewLocal: true, localLlmBaseUrl: "http://local/v1/", localLlmModel: "m", localLlmApiKey: "k", findingGate: "rules" };

// A PR with two features: orders (controller → service, + its spec) and an unrelated mailer.
const FILES = {
  "src/orders/orders.controller.ts": "import { charge } from './orders.service';\nexport function create(req) {\n  return charge(req.body.amount);\n}\n",
  "src/orders/orders.service.ts": "export function charge(amount) {\n  if (amount <= 0) throw new Error('bad amount');\n  return pay(amount);\n}\nfunction pay(a) { return a; }\n",
  "src/orders/orders.service.spec.ts": "import { charge } from './orders.service';\ntest('charge', () => { expect(charge(1)).toBe(1); });\n",
  "src/mail/mailer.ts": "export function sendMail(to) {\n  return queue.push(to);\n}\n",
};
const patchOf = (content) => `@@ -1,1 +1,${content.split("\n").length} @@\n${content.split("\n").map((l) => `+${l}`).join("\n")}`;
function sample(files = FILES, extra = {}) {
  const paths = Object.keys(files);
  return {
    key: "t", owner: "o", repo: "r", pr: 1, title: "t", body: "Adds order charging. The mailer is unchanged in behaviour.", sender: "s",
    headSha: "h", baseSha: "b", isFork: false, isDraft: false, labels: [],
    changedPaths: paths,
    files: paths.map((p) => ({ path: p, content: files[p], language: "ts" })),
    diff: paths.map((p) => `--- ${p}\n${patchOf(files[p])}`).join("\n\n"),
    diffDroppedPaths: [],
    ...extra,
  };
}
const F = (o = {}) => ({
  severity: "P1", file: "src/orders/orders.controller.ts", line: 3, side: "RIGHT", title: "create() charges a negative amount",
  failure_scenario: "A request with amount -5 is charged.", root_cause: "create passes req.body.amount to charge unchecked.",
  evidence: "src/orders/orders.controller.ts:3 `return charge(req.body.amount);`", recommended_fix: "Validate amount.", recommended_test: "Reject -5.", ...o,
});
const msg = (content, finish = "stop") => ({ choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 100 } });
const stageOf = (body) => {
  const sys = body.messages[0].content;
  if (sys.startsWith("You summarize")) return "map";
  if (sys.startsWith("You are a skeptical")) return "verify";
  if (sys.startsWith("You rank")) return "select";
  return "review";
};
/** A mock model: `on[stage](body, n)` answers that stage's n-th request (a string or a full response). */
function model(on) {
  const bodies = [];
  const count = {};
  const request = async (_b, _k, path, body) => {
    if (path === "models") return { data: [] };
    bodies.push(body);
    const stage = stageOf(body);
    count[stage] = (count[stage] ?? 0) + 1;
    const out = on[stage] ? on[stage](body, count[stage]) : "{}";
    return typeof out === "string" ? msg(out) : out;
  };
  return { request, bodies, count };
}
const mapReply = (body) => {
  const files = [...body.messages[1].content.matchAll(/=== FILE: (\S+)/g)].map((m) => m[1]);
  return JSON.stringify({ files: files.map((file) => ({ file, summary: `SUMMARY-OF ${file}`, guards: file.includes("service") ? ["charge rejects amount <= 0 (L2)"] : [], effects: [] })) });
};
const reviewFor = (findingsByFile) => (body) => {
  const group = /Review only these files, one feature of this PR: ([^\n]+)\./.exec(body.messages[1].content)?.[1].split(", ") ?? [];
  const findings = group.flatMap((f) => findingsByFile[f] ?? []);
  return JSON.stringify({ merge_recommendation: findings.length ? "REQUEST_CHANGES" : "COMMENT", investigated_safe: group.map((f) => `${f}: checked`), findings, coverage: group.map((file) => ({ file, status: "cleared", reason: "read" })) });
};
const confirm = (quote = "return charge(req.body.amount);", severity = "P1") => JSON.stringify({ verdict: "confirmed", reason: "no validation before charge", proof_quote: quote, severity });
const refute = JSON.stringify({ verdict: "refuted", reason: "charge() rejects amount <= 0 (orders.service.ts:2)" });

test("features: an import link and a test with its subject form one group; an unrelated file stays apart", () => {
  const groups = featureGroups(sample(), 40_000);
  const orders = groups.find((g) => g.includes("src/orders/orders.controller.ts"));
  assert.deepEqual([...orders].sort(), ["src/orders/orders.controller.ts", "src/orders/orders.service.spec.ts", "src/orders/orders.service.ts"]);
  assert.ok(groups.some((g) => g.length === 1 && g[0] === "src/mail/mailer.ts"));
  assert.equal(groups.flat().length, 4, "every reviewable file is in exactly one group");
});

test("features: a linked set over budget is cut along its imports; nothing is lost", () => {
  const groups = featureGroups(sample(), 450);
  assert.equal(groups.flat().length, 4);
  assert.ok(groups.length >= 3);
});

test("PR map: every changed file keeps a line within the cap; the files under review come first, marked", () => {
  const map = deterministicMap(sample());
  for (const e of map.values()) e.summary = "x".repeat(400);
  const text = renderPrMap(map, 800, new Set(["src/mail/mailer.ts"]));
  assert.ok(text.length <= 800, `bounded (${text.length})`);
  const lines = text.split("\n").slice(1, -1);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\* src\/mail\/mailer\.ts/);
  assert.match(text, /changed exports: charge/);
});

test("evidence: the cited code, the definition of a named symbol in another file, the module docs and the PR description", () => {
  const s = sample(FILES, { files: [...sample().files, { path: "src/orders/CLAUDE.md", content: "# Orders\nAmounts are validated in the service layer by design.", language: "md" }] });
  const map = deterministicMap(s);
  const f = { id: "x", status: "accepted", ...F(), failureScenario: "A request with amount -5 is charged.", rootCause: "`charge` is called unchecked.", recommendedFix: "", recommendedTest: "" };
  const pack = evidencePack(s, f, map, 40_000);
  assert.match(pack.code, /--- src\/orders\/orders\.controller\.ts \(L1-/);
  assert.match(pack.code, /--- src\/orders\/orders\.service\.ts[\s\S]*if \(amount <= 0\)/, "the definition of charge, in another file");
  assert.match(pack.text, /Amounts are validated in the service layer by design/);
  assert.match(pack.text, /UNTRUSTED_PR_DESCRIPTION[\s\S]*Adds order charging/);
  assert.doesNotMatch(pack.code, /Adds order charging/, "the proof quote must come from code, not the description");
});

test("a proof quote must be real code from the evidence", () => {
  const code = "--- a.ts (L1-L2)\n1| export function f(x) {\n2|   return charge(x.amount);";
  assert.equal(quoteInCode("return charge(x.amount);", code), true);
  assert.equal(quoteInCode("2|   return charge(x.amount);", code), true, "a copied gutter is fine");
  assert.equal(quoteInCode("return charge(x.total);", code), false);
  assert.equal(quoteInCode("x", code), false, "too short to prove anything");
});

test("named symbols: code-like identifiers, most specific first", () => {
  assert.deepEqual(namedSymbols({ title: "createOrder skips `validateAmount`", rootCause: "the ORDER_LIMIT check", evidence: "", failureScenario: "when this user" }).sort(), ["ORDER_LIMIT", "createOrder", "validateAmount"]);
});

test("pipeline: a refuted candidate is never posted; a confirmed one is, with the stage counts", async () => {
  const m = model({
    map: mapReply,
    review: reviewFor({
      "src/orders/orders.controller.ts": [F()],
      "src/mail/mailer.ts": [F({ file: "src/mail/mailer.ts", line: 2, title: "sendMail pushes to an undefined queue", evidence: "src/mail/mailer.ts:2 `return queue.push(to);`", root_cause: "`queue` is undefined", failure_scenario: "sendMail throws." })],
    }),
    verify: (body) => (/sendMail/.test(body.messages[1].content.split("<<<END>>>")[0]) ? refute : confirm()),
  });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(out.ok, true, out.error);
  const review = JSON.parse(out.raw);
  assert.deepEqual(review.findings.map((f) => f.title), ["create() charges a negative amount"]);
  assert.match(out.pipelineSummary, /2 feature group\(s\), 2 candidate\(s\), 2 past the gate, 1 confirmed, 1 refuted, 1 posted/);
  assert.equal(m.count.verify, 2);
  assert.ok(gateLiveSubmission(parseChatSubmission(out.raw), sample(), settings).ok);
});

test("pipeline: a feature turn sees what the OTHER features do (PR map), so a guard elsewhere is known", async () => {
  const m = model({ map: mapReply, review: reviewFor({}), verify: () => refute });
  await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const mailTurn = m.bodies.find((b) => stageOf(b) === "review" && /one feature of this PR: src\/mail\/mailer\.ts\./.test(b.messages[1].content));
  assert.ok(mailTurn, "the mailer feature had its own turn");
  assert.match(mailTurn.messages[1].content, /SUMMARY-OF src\/orders\/orders\.service\.ts/);
  assert.match(mailTurn.messages[1].content, /guards: charge rejects amount <= 0/);
  assert.doesNotMatch(mailTurn.messages[1].content, /if \(amount <= 0\) throw/, "the other feature's code itself is not in this turn");
});

test("pipeline: a confirmation that quotes no code from the evidence counts as refuted", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => confirm("chargeEverything(amount) // not in the code") });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.equal(review.findings.length, 0);
  assert.ok(gateLiveSubmission(parseChatSubmission(out.raw), sample(), settings).ok, "all refuted is a reviewed, clean result");
});

test("pipeline: when every candidate is refuted and no group listed investigated_safe, the result still says it was reviewed", async () => {
  const noSafe = (body) => JSON.parse(reviewFor({ "src/orders/orders.controller.ts": [F()] })(body));
  // The feature with a finding lists no investigated_safe; the finding-free one must (or it is no review).
  const m = model({ map: mapReply, review: (b) => { const r = noSafe(b); return JSON.stringify(r.findings.length ? { ...r, investigated_safe: [] } : r); }, verify: () => refute });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.equal(review.findings.length, 0);
  assert.equal(review.unreviewed_paths, undefined);
  assert.ok(review.investigated_safe.length, "never an empty result without investigated_safe");
  // One feature only, whose reply listed no investigated_safe: the refute stage's own line keeps it a review.
  const { "src/mail/mailer.ts": _mail, ...orders } = FILES;
  const one = await runLocalReviewPipeline(sample(orders), settings, { request: m.request });
  const r1 = JSON.parse(one.raw);
  assert.deepEqual(r1.findings, []);
  assert.match(r1.investigated_safe.join("\n"), /refuted all 1 candidate/);
  assert.ok(gateLiveSubmission(parseChatSubmission(one.raw), sample(orders), settings).ok);
  assert.ok(gateLiveSubmission(parseChatSubmission(out.raw), sample(), settings).ok);
});

test("pipeline: the verifier may lower a severity, never raise it", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F({ severity: "P2" })] }), verify: () => confirm(undefined, "P0") });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings[0].severity, "P2");
  const m2 = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => confirm(undefined, "P2") });
  assert.equal(JSON.parse((await runLocalReviewPipeline(sample(), settings, { request: m2.request })).raw).findings[0].severity, "P2");
});

test("pipeline: two votes — a candidate the second vote refutes is not posted", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: (_b, n) => (n === 1 ? confirm() : refute) });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineVerifyVotes: 2 }, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings.length, 0);
  assert.equal(m.count.verify, 2);
});

test("pipeline: at most localPipelineMaxFindings are posted, in the selector's order", async () => {
  const many = [1, 2, 3, 4, 5].map((i) => F({ line: 3, title: `distinct defect number ${i}`, severity: i === 5 ? "P1" : "P2" }));
  const m = model({
    map: mapReply,
    review: reviewFor({ "src/orders/orders.controller.ts": many.slice(0, 4), "src/mail/mailer.ts": [] }),
    verify: () => confirm(),
    select: () => JSON.stringify({ selected: [{ id: "c4" }, { id: "c2" }, { id: "c1" }, { id: "c3" }] }),
  });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 2 }, { request: m.request });
  assert.deepEqual(JSON.parse(out.raw).findings.map((f) => f.title), ["distinct defect number 4", "distinct defect number 2"]);
});

test("pipeline: a selection that is unusable or drops every proven P1 falls back to severity order", async () => {
  const rows = [F({ title: "minor thing", severity: "P2" }), F({ title: "real P1", severity: "P1", line: 2 })];
  for (const select of [() => "not json at all", () => JSON.stringify({ selected: [{ id: "c1" }] })]) {
    const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": rows }), verify: (b) => confirm(undefined, /real P1/.test(b.messages[1].content) ? "P1" : "P2"), select });
    const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 1 }, { request: m.request });
    assert.deepEqual(JSON.parse(out.raw).findings.map((f) => f.title), ["real P1"]);
  }
  assert.deepEqual(rankSurvivors([{ severity: "P2", file: "a", title: "x" }, { severity: "P1", file: "a", title: "y" }, { severity: "P1", file: "a", title: "Y!" }], 5).map((r) => r.title), ["y", "x"]);
});

test("pipeline: a verification that cannot run keeps the candidate as reported and says so (never a clean result from a failure)", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => { throw new Error("HTTP 500"); } });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.equal(review.findings.length, 1);
  // Codex #180: demoting it to P2 let a P1 publish threshold filter it away into a clean result.
  assert.equal(review.findings[0].severity, "P1");
  assert.match(review.assumptions.join("\n"), /could not be verified and are kept as reported/);
  const gate = gateLiveSubmission(parseChatSubmission(out.raw), sample(), { ...settings, publishMinSeverity: "P1" });
  assert.equal(gate.findings.length, 1, "still posted under a P1 publish threshold");
});

test("pipeline: a map turn whose request throws leaves the deterministic map; the review still runs (Codex #180)", async () => {
  const m = model({ map: () => { throw new Error("HTTP 500"); }, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => confirm() });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(out.ok, true, out.error);
  assert.equal(JSON.parse(out.raw).findings.length, 1);
});

test("pipeline: a selection that repeats an id cannot take a second slot from another verified finding (Codex #180)", async () => {
  const rows = [F({ title: "first distinct defect", line: 2 }), F({ title: "second distinct defect", line: 3 })];
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": rows }), verify: () => confirm(), select: () => JSON.stringify({ selected: [{ id: "c1" }, { id: "c1" }, { id: "c2" }] }) });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 2 }, { request: m.request });
  assert.deepEqual(JSON.parse(out.raw).findings.map((f) => f.title), ["first distinct defect", "second distinct defect"]);
});

test("pipeline: a feature whose reply is never review JSON is unreviewed, kept as evidence; the others still post", async () => {
  const m = model({
    map: mapReply,
    review: (body) => (/one feature of this PR: src\/mail\/mailer\.ts\./.test(body.messages[1].content) ? "MAIL-PROSE no json" : reviewFor({ "src/orders/orders.controller.ts": [F()] })(body)),
    verify: () => confirm(),
  });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(out.ok, true);
  const review = JSON.parse(out.raw);
  assert.deepEqual(review.unreviewed_paths, ["src/mail/mailer.ts"]);
  assert.ok(review.coverage.some((c) => c.file === "src/mail/mailer.ts" && c.status === "not_cleared"));
  assert.match(out.unparsedText, /MAIL-PROSE/);
  assert.equal(review.findings.length, 1);
});

test("pipeline: every feature failing is a failed leg, not an empty pass", async () => {
  const m = model({ map: mapReply, review: () => "prose only" });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(out.ok, false);
  assert.match(out.error, /local pipeline produced no review JSON/);
  assert.match(out.unparsedText, /prose only/);
});

test("pipeline: a map turn that fails leaves the deterministic map; the review still runs", async () => {
  const m = model({ map: () => "no", review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => confirm() });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(out.ok, true);
  const turn = m.bodies.find((b) => stageOf(b) === "review");
  assert.match(turn.messages[1].content, /changed exports: charge/);
});

test("pipeline: every request fits the local window, and the stage turns run at low temperature", async () => {
  const big = {};
  for (let i = 0; i < 30; i += 1) big[`src/mod${i % 5}/file${i}.ts`] = `export function f${i}(x) {\n${"  x = x + 1; // padding line\n".repeat(120)}  return x;\n}\n`;
  const m = model({ map: mapReply, review: reviewFor({}), verify: () => refute });
  const out = await runLocalReviewPipeline(sample(big), settings, { request: m.request });
  assert.equal(out.ok, true, out.error);
  for (const b of m.bodies) {
    const tokens = Math.ceil(b.messages.reduce((n, x) => n + x.content.length, 0) / 3.5);
    assert.ok(tokens <= 24_000, `${stageOf(b)} request ${tokens} tokens`);
    if (stageOf(b) !== "review") assert.ok(b.temperature <= 0.1 && b.presence_penalty === 0, `${stageOf(b)} sampling`);
  }
  assert.ok(m.bodies.filter((b) => stageOf(b) === "map").every((b) => (b.messages[1].content.match(/=== FILE:/g) ?? []).length <= 12));
});

test("pipeline: a cancelled review stops at the next turn and fails the leg", async () => {
  const ctl = new AbortController();
  const m = model({ map: () => { ctl.abort(new Error("cancelled by operator")); return mapReply({ messages: [{}, { content: "" }] }); } });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request, signal: ctl.signal });
  assert.equal(out.ok, false);
  assert.match(out.error, /aborted/);
});

test("single-turn: each finding is verified, the refuted ones dropped, the reply's other fields kept", async () => {
  const raw = JSON.stringify({
    merge_recommendation: "REQUEST_CHANGES", investigated_safe: ["src/mail/mailer.ts: unchanged behaviour"], assumptions: ["A1"],
    findings: [F(), F({ title: "charge ignores currency", line: 2 })], coverage: [{ file: "src/orders/orders.controller.ts", status: "cleared", reason: "r" }],
  });
  const m = model({ verify: (b) => (/currency/.test(b.messages[1].content) ? refute : confirm()) });
  const out = await verifySingleTurn(raw, sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.deepEqual(review.findings.map((f) => f.title), ["create() charges a negative amount"]);
  assert.deepEqual(review.investigated_safe, ["src/mail/mailer.ts: unchanged behaviour"]);
  assert.deepEqual(review.assumptions, ["A1"]);
  assert.equal(review.coverage.length, 1);
  assert.match(out.summary, /^Local verification: 2 candidate\(s\), 2 past the gate, 1 confirmed, 1 refuted, 1 posted/);
});

test("single-turn: a reply with no finding (or one the gate rejects) is returned unchanged, with no request", async () => {
  const m = model({});
  for (const raw of [JSON.stringify({ findings: [], investigated_safe: ["ok"] }), "{\"findings\":[]}"]) {
    assert.equal((await verifySingleTurn(raw, sample(), settings, { request: m.request })).raw, raw);
  }
  assert.equal(m.bodies.length, 0);
});

test("single-turn: every reported row is inspected (more than the gate's 8-row cap), and a cut-off reply stays marked (Codex #180)", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => F({ title: `distinct defect ${i + 1}`, line: 1 + (i % 4) }));
  const raw = JSON.stringify({ merge_recommendation: "REQUEST_CHANGES", investigated_safe: [], findings: rows, truncated: true });
  const m = model({ verify: () => refute });
  const out = await verifySingleTurn(raw, sample(), settings, { request: m.request });
  assert.equal(m.count.verify, 10, "rows 9 and 10 were verified too, not dropped unread");
  const review = JSON.parse(out.raw);
  assert.equal(review.truncated, true, "the cut-off mark survives the rebuild");
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.investigated_safe, [], "no 'all refuted' clean line for a cut-off reply");
  const gate = gateLiveSubmission(parseChatSubmission(out.raw), sample(), settings);
  assert.ok(!gate.ok || gate.truncated, "never a complete clean verdict");
});

test("pipeline: candidates past the verify cap stay as reported, never dropped into a clean result", async () => {
  const many = Array.from({ length: 14 }, (_, i) => F({ title: `cap defect ${i + 1}`, line: 1 + (i % 4), severity: "P2" }));
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": many }), verify: () => refute });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 8 }, { request: m.request });
  assert.equal(m.count.verify, 12);
  const review = JSON.parse(out.raw);
  assert.equal(review.findings.length, 2, "the two over the cap are kept, unverified");
  assert.match(review.assumptions.join("\n"), /2 local candidate finding\(s\) could not be verified/);
  assert.match(out.pipelineSummary, /2 over the verify cap/);
});
