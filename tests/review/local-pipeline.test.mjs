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
  dedupeCandidates,
  HUNT_INSTRUCTIONS,
  LENSES,
  lensesFor,
} from "../../src/lib/local-pipeline.server.ts";
import { REVIEW_INSTRUCTIONS } from "../../src/lib/chat-prompt.ts";
import { verifiedKey } from "../../src/lib/finding-gate.ts";
import { DEFAULT_SETTINGS } from "../../src/lib/types.ts";
import { gateLiveSubmission } from "../../src/lib/poster.ts";
import { parseChatSubmission } from "../../src/lib/chat-prompt.ts";

// One lens pass per feature unless a test is about lenses (it sets localPipelineLenses itself).
const settings = { ...DEFAULT_SETTINGS, reviewLocal: true, localLlmBaseUrl: "http://local/v1/", localLlmModel: "m", localLlmApiKey: "k", findingGate: "rules", localPipelineLenses: 1 };

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
// The group budget sits between the orders feature and the whole PR, so the PR is reviewed as two
// features (orders, mailer) with a PR map; tests of the whole-PR path drop it (wholePr()).
const sizeOf = (paths) => paths.reduce((n, p) => n + `--- ${p}\n${patchOf(FILES[p])}`.length + 200, 0);
const ORDERS = Object.keys(FILES).filter((p) => p.startsWith("src/orders/"));
process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS = String(sizeOf(ORDERS) + 20);
assert.ok(sizeOf(Object.keys(FILES)) > sizeOf(ORDERS) + 20);
async function wholePr(fn) {
  const before = process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS;
  delete process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS;
  try { return await fn(); } finally { process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS = before; }
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
  if (/You verify ONE defect/.test(sys)) return "verify";
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
const groupOf = (body) => {
  const text = body.messages[1].content;
  const feature = /Review only these files, one feature of this PR: ([^\n]+)\./.exec(text)?.[1].split(", ");
  return feature ?? (/^Changed: (.+)$/m.exec(text)?.[1].split(", ") ?? []);
};
const reviewFor = (findingsByFile) => (body) => {
  const group = groupOf(body);
  const findings = group.flatMap((f) => findingsByFile[f] ?? []);
  return JSON.stringify({ merge_recommendation: findings.length ? "REQUEST_CHANGES" : "COMMENT", investigated_safe: group.map((f) => `${f}: checked`), findings, coverage: group.map((file) => ({ file, status: "cleared", reason: "read" })) });
};
const confirm = (quote = "return charge(req.body.amount);", severity = "P1") => JSON.stringify({ verdict: "confirmed", reason: "no validation before charge", proof_quote: quote, severity });
/** A refutation that quotes a line of the CODE it was shown (a refutation must point at code or docs). */
const refute = (body) => {
  const code = /<<<CODE[^\n]*\n([\s\S]*?)\n<<<END>>>/.exec(body.messages[1].content)?.[1] ?? "";
  const line = code.split("\n").find((l) => /^\d+\| .*\w{8}/.test(l))?.replace(/^\d+\| /, "") ?? "";
  return JSON.stringify({ verdict: "refuted", reason: "a guard in the code shown prevents it", counter_quote: line });
};

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
    verify: (body) => (/sendMail/.test(body.messages[1].content.split("<<<END>>>")[0]) ? refute(body) : confirm()),
  });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(out.ok, true, out.error);
  const review = JSON.parse(out.raw);
  assert.deepEqual(review.findings.map((f) => f.title), ["create() charges a negative amount"]);
  assert.match(out.pipelineSummary, /2 feature group\(s\) × 1 lens\(es\), 2 candidate\(s\), 2 to verify, 1 confirmed, 1 refuted, 1 posted/);
  assert.equal(m.count.verify, 2);
  assert.ok(gateLiveSubmission(parseChatSubmission(out.raw), sample(), settings).ok);
});

test("pipeline: a feature turn sees what the OTHER features do (PR map), so a guard elsewhere is known", async () => {
  const m = model({ map: mapReply, review: reviewFor({}), verify: refute });
  await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const mailTurn = m.bodies.find((b) => stageOf(b) === "review" && /one feature of this PR: src\/mail\/mailer\.ts\./.test(b.messages[1].content));
  assert.ok(mailTurn, "the mailer feature had its own turn");
  assert.match(mailTurn.messages[1].content, /SUMMARY-OF src\/orders\/orders\.service\.ts/);
  assert.match(mailTurn.messages[1].content, /guards: charge rejects amount <= 0/);
  assert.doesNotMatch(mailTurn.messages[1].content, /if \(amount <= 0\) throw/, "the other feature's code itself is not in this turn");
});

test("pipeline: a confirmation that quotes no code is only uncertain — posted at P2 when the candidate's own quote is real code", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => confirm("chargeEverything(amount) // not in the code") });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.deepEqual(review.findings.map((f) => [f.title, f.severity]), [["create() charges a negative amount", "P2"]]);
  assert.match(out.pipelineSummary, /0 confirmed, 1 uncertain, 0 refuted, 1 posted/);
  // Settings off: an uncertain candidate is dropped.
  const off = await runLocalReviewPipeline(sample(), { ...settings, localPipelineKeepUncertain: false }, { request: m.request });
  assert.equal(JSON.parse(off.raw).findings.length, 0);
});

test("pipeline: an uncertain candidate whose own quote is not real code is dropped", async () => {
  const bogus = F({ evidence: "src/orders/orders.controller.ts:3 `return chargeTwice(req.body.amount, true);`" });
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [bogus] }), verify: () => JSON.stringify({ verdict: "uncertain", reason: "cannot tell" }) });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings.length, 0);
});

test("pipeline: a refutation without a counter-quote from the evidence is not accepted (it becomes uncertain)", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => JSON.stringify({ verdict: "refuted", reason: "probably fine" }) });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].severity, "P2");
  assert.match(out.pipelineSummary, /1 uncertain/);
});

test("pipeline: when every candidate is refuted and no group listed investigated_safe, the result still says it was reviewed", async () => {
  const noSafe = (body) => JSON.parse(reviewFor({ "src/orders/orders.controller.ts": [F()] })(body));
  // The feature with a finding lists no investigated_safe; the finding-free one must (or it is no review).
  const m = model({ map: mapReply, review: (b) => { const r = noSafe(b); return JSON.stringify(r.findings.length ? { ...r, investigated_safe: [] } : r); }, verify: refute });
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
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: (_b, n) => (n === 1 ? confirm() : refute(_b)) });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineVerifyVotes: 2 }, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings.length, 0);
  assert.equal(m.count.verify, 2);
});

test("pipeline: at most localPipelineMaxFindings are posted, in the selector's order", async () => {
  const many = ["alpha", "bravo", "charlie", "delta", "echo"].map((w, i) => F({ line: 1 + i, title: `${w} ${w}z`, severity: i === 4 ? "P1" : "P2" }));
  const m = model({
    map: mapReply,
    review: reviewFor({ "src/orders/orders.controller.ts": many.slice(0, 4), "src/mail/mailer.ts": [] }),
    verify: () => confirm(),
    select: () => JSON.stringify({ selected: [{ id: "c4" }, { id: "c2" }, { id: "c1" }, { id: "c3" }] }),
  });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 2 }, { request: m.request });
  assert.deepEqual(JSON.parse(out.raw).findings.map((f) => f.title), ["delta deltaz", "bravo bravoz"]);
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
  const rows = [F({ title: "first firstly", line: 2 }), F({ title: "second secondly", line: 3 })];
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": rows }), verify: () => confirm(), select: () => JSON.stringify({ selected: [{ id: "c1" }, { id: "c1" }, { id: "c2" }] }) });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 2 }, { request: m.request });
  assert.deepEqual(JSON.parse(out.raw).findings.map((f) => f.title), ["first firstly", "second secondly"]);
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
  const m = model({ map: mapReply, review: reviewFor({}), verify: refute });
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

test("whole PR: a PR that fits one turn is reviewed in one turn per lens with no map, and the other fields are kept", async () => {
  await wholePr(async () => {
    const m = model({
      review: (body) => JSON.stringify({
        merge_recommendation: "REQUEST_CHANGES", investigated_safe: ["src/mail/mailer.ts: unchanged behaviour"], assumptions: ["A1"],
        findings: [F(), F({ title: "charge ignores currency", line: 2 })], coverage: [{ file: "src/orders/orders.controller.ts", status: "cleared", reason: "r" }],
      }),
      verify: (b) => (/currency/.test(b.messages[1].content.split("<<<END>>>")[0]) ? refute(b) : confirm()),
    });
    const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
    assert.equal(m.count.map, undefined, "no PR map for a PR the turn sees whole");
    assert.equal(m.count.review, 1);
    assert.match(m.bodies.find((b) => stageOf(b) === "review").messages[1].content, /Review the whole change of this pull request\./);
    const review = JSON.parse(out.raw);
    assert.deepEqual(review.findings.map((f) => f.title), ["create() charges a negative amount"]);
    assert.deepEqual(review.investigated_safe, ["src/mail/mailer.ts: unchanged behaviour"]);
    assert.deepEqual(review.assumptions, ["A1"]);
    assert.match(out.pipelineSummary, /^Local pipeline: 1 feature group\(s\) × 1 lens\(es\), 2 candidate\(s\), 2 to verify, 1 confirmed, 1 refuted, 1 posted/);
  });
});

test("whole PR: every reported row is inspected (more than the gate's 8-row cap), and a cut-off reply stays marked (Codex #180)", async () => {
  await wholePr(async () => {
    const rows = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"].map((w, i) => F({ title: `${w} ${w}q`, line: 1 + i }));
    const m = model({ review: () => JSON.stringify({ merge_recommendation: "REQUEST_CHANGES", investigated_safe: [], findings: rows, truncated: true }), verify: refute });
    const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
    assert.equal(m.count.verify, 10, "rows 9 and 10 were verified too, not dropped unread");
    const review = JSON.parse(out.raw);
    assert.equal(review.truncated, true, "the cut-off mark survives the rebuild");
    assert.deepEqual(review.findings, []);
    assert.deepEqual(review.investigated_safe, [], "no 'all refuted' clean line for a cut-off reply");
    const gate = gateLiveSubmission(parseChatSubmission(out.raw), sample(), settings);
    assert.ok(!gate.ok || gate.truncated, "never a complete clean verdict");
  });
});

test("pipeline: candidates past the verify cap stay as reported, never dropped into a clean result", async () => {
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo"];
  const many = names.map((w, i) => F({ title: `${w} ${w}q`, line: 1 + i, severity: "P2" }));
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": many }), verify: refute });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 8 }, { request: m.request });
  assert.equal(m.count.verify, 16);
  const review = JSON.parse(out.raw);
  assert.equal(review.findings.length, 2, "the two over the cap are kept, unverified");
  assert.match(review.assumptions.join("\n"), /2 local candidate finding\(s\) could not be verified/);
  assert.match(out.pipelineSummary, /2 over the verify cap/);
});

// ── Recall (2026-11-06: after the pipeline shipped, three real defects Codex caught on the same commit came
// back findings:[] from the local reviewer — the candidate prompt's precision rules silenced it) ──

test("recall: candidate turns get the hunt instructions, not the chat precision rules", async () => {
  const m = model({ map: mapReply, review: reviewFor({}), verify: refute });
  await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const turn = m.bodies.find((b) => stageOf(b) === "review").messages[1].content;
  assert.ok(turn.includes(HUNT_INSTRUCTIONS));
  assert.ok(!turn.includes(REVIEW_INSTRUCTIONS));
  assert.doesNotMatch(turn, /Never report anything unverified/);
  assert.match(turn, /do not hold back a defect because you could not fully prove it here/);
});

test("recall: three lens passes per feature, each with its own focus; the same defect from two lenses is verified once", async () => {
  assert.deepEqual(lensesFor(3), ["failure", "data", "contract"]);
  assert.deepEqual(lensesFor(1), ["general"]);
  const m = model({
    map: mapReply,
    review: (body) => {
      const text = body.messages[1].content;
      const lens = text.includes(LENSES.failure) ? "failure" : text.includes(LENSES.data) ? "data" : "contract";
      const files = groupOf(body);
      if (!files.includes("src/orders/orders.controller.ts")) return reviewFor({})(body);
      const rows = lens === "data" ? [F({ title: "negative amount charged by create" }), F({ title: "currency mismatch currencyq", line: 2 })] : [F()];
      return JSON.stringify({ merge_recommendation: "REQUEST_CHANGES", investigated_safe: files.map((f) => `${f}: read`), findings: rows });
    },
    verify: () => confirm(),
  });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineLenses: 3 }, { request: m.request });
  const reviews = m.bodies.filter((b) => stageOf(b) === "review");
  assert.equal(reviews.length, 6, "2 features × 3 lenses");
  for (const focus of Object.values(LENSES).slice(0, 3)) assert.ok(reviews.some((b) => b.messages[1].content.includes(focus)));
  assert.equal(m.count.verify, 2, "the charge defect from three lenses is one candidate, the currency one another");
  assert.match(out.pipelineSummary, /× 3 lens\(es\)/);
});

test("recall: a hedged candidate the gate would drop goes to the verifier, and a confirmed one survives the downstream gate", async () => {
  const hedged = F({ title: "create may charge a negative amount", failure_scenario: "If amount is -5 it could be charged." });
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [hedged] }), verify: () => confirm() });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(m.count.verify, 1, "verified, not dropped unread");
  assert.match(out.pipelineSummary, /\(1 the gate would have dropped\)/);
  const review = JSON.parse(out.raw);
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0].evidence, /`return charge\(req\.body\.amount\);`/);
  assert.equal(out.verifiedKeys.length, 1);
  // Downstream (harbor's leg gate): with the trusted verified keys it posts; without them the hedge drops it.
  const parsed = parseChatSubmission(out.raw);
  const withKeys = gateLiveSubmission(parsed, sample(), settings, { verifiedKeys: new Set(out.verifiedKeys) });
  assert.equal(withKeys.findings.length, 1);
  const without = gateLiveSubmission(parsed, sample(), settings);
  assert.equal(without.findings.length, 0, "the plain gate still drops a hedged claim");
});

test("recall: only verified findings carry a verified key (an unverifiable one is kept but re-gated as before)", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => { throw new Error("HTTP 500"); } });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings.length, 1);
  assert.equal(out.verifiedKeys, undefined);
});

test("recall: a near-identical quote still proves (dropped semicolon, quotes); a different identifier never does", () => {
  const code = "--- a.ts (L1-L2)\n1| export function f(x) {\n2|   return charge(x.amount, 'KRW');";
  assert.equal(quoteInCode('return charge(x.amount, "KRW")', code), true);
  assert.equal(quoteInCode("return charge(x.amount, KRW);", code), true);
  assert.equal(quoteInCode("return charge(x.total, 'KRW');", code), false);
  assert.equal(quoteInCode("return refund(x.amount, 'KRW');", code), false);
});

test("recall: the same defect from different passes is one candidate; distinct defects on one line stay apart", () => {
  const rows = [
    { severity: "P2", file: "a.ts", line: 3, title: "negative amount is charged" },
    { severity: "P1", file: "a.ts", line: 3, title: "charged amount can be negative" },
    { severity: "P2", file: "a.ts", line: 3, title: "currency code ignored" },
    { severity: "P2", file: "b.ts", line: 3, title: "negative amount is charged" },
  ];
  const kept = dedupeCandidates(rows);
  assert.deepEqual(kept.map((r) => `${r.file}:${r.title}`), ["a.ts:charged amount can be negative", "a.ts:currency code ignored", "b.ts:negative amount is charged"]);
});

test("recall: a confirmed finding's evidence gains the verifier's proof quote when it did not already carry it", async () => {
  const thin = F({ evidence: "src/orders/orders.controller.ts:3 the amount goes straight to `charge`" });
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [thin] }), verify: () => confirm() });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.match(JSON.parse(out.raw).findings[0].evidence, /Verified against the code: `return charge\(req\.body\.amount\);`/);
});

test("codex #181: a fuzzy quote never matches code with a different operator, identifier or case", () => {
  const code = "--- a.ts (L1-L3)\n1| export function g(user, a) {\n2|   if (isAdmin(user)) return denyAccess();\n3|   return charge(a);";
  assert.equal(quoteInCode("if (!isAdmin(user)) return denyAccess();", code), false, "an added operator is other code");
  assert.equal(quoteInCode("return charge(b);  // the amount", code), false, "a one-letter identifier still counts");
  assert.equal(quoteInCode("if (IsAdmin(user)) return denyAccess()", code), false, "identifier case counts");
  assert.equal(quoteInCode("if isAdmin(user) return denyAccess()", code), true, "dropped brackets and semicolon are formatting");
});

test("codex #181: similar titles at two locations stay two candidates unless their evidence quotes the same code", () => {
  const at = (line, title, quote) => ({ severity: "P2", file: "a.ts", line, title, evidence: `a.ts:${line} \`${quote}\`` });
  const two = dedupeCandidates([
    at(10, "Handle a missing billing address before reading city", "const c = order.billing.address.city;"),
    at(20, "Handle a missing shipping address before reading city", "const s = order.shipping.address.city;"),
  ]);
  assert.equal(two.length, 2);
  const one = dedupeCandidates([
    at(10, "Handle a missing billing address before reading city", "const c = order.billing.address.city;"),
    at(11, "Handle missing billing address before reading the city", "const c = order.billing.address.city;"),
  ]);
  assert.equal(one.length, 1, "the same quoted code on a neighbouring line is one defect");
});

test("codex #181: a whole-PR reply that marks a file unreviewed keeps it unreviewed (never a clean result)", async () => {
  await wholePr(async () => {
    const review = () => JSON.stringify({ merge_recommendation: "COMMENT", investigated_safe: ["src/mail/mailer.ts: checked"], findings: [], unreviewed_paths: ["src/orders/orders.service.ts"] });
    const m = model({ review });
    const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
    const json = JSON.parse(out.raw);
    assert.deepEqual(json.unreviewed_paths, ["src/orders/orders.service.ts"]);
    assert.deepEqual(json.investigated_safe, [], "a partial review with no finding claims nothing clean");
    assert.ok(json.coverage.some((c) => c.file === "src/orders/orders.service.ts" && c.status === "not_cleared"));
  });
});

test("codex #181: a hedged style remark is not rescued to the verifier; it stays a note", async () => {
  const style = F({ severity: "P2", title: "Variable naming might be misleading", failure_scenario: "Readers might misread it.", root_cause: "The name might be unclear.", recommended_fix: "Rename the variable." });
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [style] }), verify: () => JSON.stringify({ verdict: "uncertain", reason: "cannot tell" }) });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings.length, 0);
  assert.equal(m.count.verify ?? 0, 0);
  assert.equal(out.verifiedKeys, undefined);
});
