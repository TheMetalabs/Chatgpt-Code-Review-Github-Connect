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
  hunkAt,
  languageNotes,
  VERIFY_RULES,
  PART_NON_CODE_MAX_CHARS,
  calledNames,
  enclosingName,
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
  if (/You judge ONE reported defect/.test(sys)) return "verify";
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
    verify: (body) => (/sendMail/.test((/<<<CANDIDATE[^\n]*\n([\s\S]*?)\n<<<END>>>/.exec(body.messages[1].content)?.[1] ?? "")) ? refute(body) : confirm()),
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
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineKeepUncertain: true }, { request: m.request });
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
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineKeepUncertain: true }, { request: m.request });
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
      verify: (b) => (/currency/.test((/<<<CANDIDATE[^\n]*\n([\s\S]*?)\n<<<END>>>/.exec(b.messages[1].content)?.[1] ?? "")) ? refute(b) : confirm()),
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

test("recall: a PR reviewed in one turn gets three lens passes, each with its own focus; the same defect from two lenses is verified once", async () => {
  assert.deepEqual(lensesFor(3), ["failure", "data", "contract"]);
  assert.deepEqual(lensesFor(1), ["general"]);
  await wholePr(async () => {
    const m = model({
      review: (body) => {
        const text = body.messages[1].content;
        const lens = text.includes(LENSES.failure) ? "failure" : text.includes(LENSES.data) ? "data" : "contract";
        const files = groupOf(body);
        const rows = lens === "data" ? [F({ title: "negative amount charged by create" }), F({ title: "currency mismatch currencyq", line: 2 })] : [F()];
        return JSON.stringify({ merge_recommendation: "REQUEST_CHANGES", investigated_safe: files.map((f) => `${f}: read`), findings: rows });
      },
      verify: () => confirm(),
    });
    const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineLenses: 3 }, { request: m.request });
    const reviews = m.bodies.filter((b) => stageOf(b) === "review");
    assert.equal(reviews.length, 3, "1 whole-PR turn × 3 lenses");
    for (const focus of Object.values(LENSES).slice(0, 3)) assert.ok(reviews.some((b) => b.messages[1].content.includes(focus)));
    assert.equal(m.count.verify, 2, "the charge defect from three lenses is one candidate, the currency one another");
    assert.match(out.pipelineSummary, /× 3 lens\(es\)/);
  });
});

test("speed: a PR split into features gets one combined pass per feature, whatever the lens setting", async () => {
  const m = model({ map: mapReply, review: reviewFor({}), verify: () => confirm() });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineLenses: 3 }, { request: m.request });
  const reviews = m.bodies.filter((b) => stageOf(b) === "review");
  assert.equal(reviews.length, 2, "2 features × 1 pass, not × 3");
  assert.ok(reviews.every((b) => b.messages[1].content.includes(LENSES.general)));
  assert.ok(reviews.every((b) => /Report at most 3 findings for these files/.test(b.messages[1].content)), "a feature of a larger PR asks for at most 3");
  assert.match(out.pipelineSummary, /2 feature group\(s\) × 1 lens\(es\)/);
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

// ── Speed and precision on a large Swift PR (2026-11-07: WalkieBoard #566 took 2–4.5 h for 84–87 turns and
// posted 5 false positives of 9; 4 of them carried "Verified against the code") ──

test("precision: next to verified findings, a candidate the verifier never judged is not posted (and is counted)", async () => {
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo"];
  const many = names.map((w, i) => F({ title: `${w} ${w}q`, line: 1 + i, severity: "P2" }));
  const m = model({
    map: mapReply,
    review: reviewFor({ "src/orders/orders.controller.ts": many }),
    verify: (body) => (/alpha alphaq/.test(/<<<CANDIDATE[^\n]*\n([\s\S]*?)\n<<<END>>>/.exec(body.messages[1].content)?.[1] ?? "") ? confirm() : refute(body)),
  });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineMaxFindings: 8 }, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.deepEqual(review.findings.map((f) => f.title), ["alpha alphaq"], "the two over the cap are not posted next to the verified one");
  assert.match(review.assumptions.join("\n"), /2 local candidate finding\(s\) could not be verified .* not posted next to the verified ones/);
  assert.match(out.pipelineSummary, /2 over the verify cap, 1 posted/);
});

test("verifier prompt: fixed rules first (a shared prefix), the five checks, and the trace before the verdict", async () => {
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => confirm() });
  await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const turns = m.bodies.filter((b) => stageOf(b) === "verify").map((b) => b.messages[1].content);
  assert.ok(turns.length >= 1);
  for (const t of turns) assert.ok(t.startsWith(VERIFY_RULES), "every verify turn starts with the same fixed text");
  assert.match(VERIFY_RULES, /Most reported candidates are false/);
  for (const check of [/Is the cited line changed by this PR\?/, /declared type or signature/, /handled elsewhere/, /stated as intended|state this behaviour as intended/, /work it through with concrete values/]) assert.match(VERIFY_RULES, check);
  assert.ok(VERIFY_RULES.indexOf('"trace"') < VERIFY_RULES.indexOf('"verdict"'), "the reply reasons before it decides");
  assert.match(VERIFY_RULES, /When in doubt, answer uncertain, never confirmed/);
});

test("verifier: a refutation in the new shape (trace + blocking_code from the DIFF) is accepted", async () => {
  const m = model({
    map: mapReply,
    review: reviewFor({ "src/orders/orders.controller.ts": [F()] }),
    verify: () => JSON.stringify({ trace: "The line is unchanged context; the report describes a change this PR does not make.", blocking_code: "export function create(req) {", verdict: "refuted", proof_quote: "", severity: "P2" }),
  });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings.length, 0);
  assert.match(out.pipelineSummary, /0 confirmed, 1 refuted/);
});

test("evidence: the cited line's diff hunk is shown, or that the PR does not change the line", () => {
  const diff = "--- App/Storage.swift\n@@ -10,3 +10,3 @@\n /// Conversations live under Conversations/.\n-/// was Conversation/\n+/// lives in Conversations/\n static let folderName = \"Conversations\"";
  assert.match(hunkAt(diff, "App/Storage.swift", 11), /'-' removed, '\+' added[\s\S]*-\/\/\/ was Conversation\//);
  assert.match(hunkAt(diff, "App/Storage.swift", 40), /App\/Storage\.swift:40 is not inside any hunk of this PR's diff: this PR does not change that line/);
  assert.equal(hunkAt(diff, "Other.swift", 1), "");
});

test("evidence: Swift definitions are found (func / var / struct), so the verifier sees the helper a finding names", () => {
  const files = { "App/ConversationModel.swift": "final class ConversationModel {\n  private var catchUp: Task<Void, Never>?\n  func stopCatchUp() {\n    catchUp?.cancel()\n  }\n}\n" };
  // The helper is not changed by the PR: only the definition search can find it.
  const s = sample(files, { referenceFiles: [{ path: "App/AudioSessionUsers.swift", content: "struct AudioSessionUsers {\n  var count = 0\n  mutating func endSession(_ user: User) {\n    deactivateWhenIdle()\n  }\n}\n" }] });
  const f = { id: "x", status: "accepted", severity: "P1", file: "App/ConversationModel.swift", line: 3, side: "RIGHT", title: "`endSession` leaves the audio session on", failureScenario: "x", rootCause: "`AudioSessionUsers` never deactivates", evidence: "App/ConversationModel.swift:3 `func stopCatchUp() {`", recommendedFix: "f", recommendedTest: "t" };
  const pack = evidencePack(s, f, new Map(), 20_000);
  assert.match(pack.code, /App\/AudioSessionUsers\.swift[\s\S]*mutating func endSession/);
  assert.match(pack.text, /<<<DIFF \(this PR's change around App\/ConversationModel\.swift:3;/, "the verifier also sees what the PR changed at the cited line");
});

test("language notes: a Swift change gets the Swift semantics in its candidate turn and its verify turn", async () => {
  assert.match(languageNotes(["App/A.swift", "README.md"]), /Task<_, Never>\.value` never throws/);
  assert.equal(languageNotes(["README.md"]), "");
  const files = { "App/ConversationModel.swift": "final class ConversationModel {\n  func stop() {\n    catchUp?.cancel()\n  }\n}\n" };
  const swiftF = F({ file: "App/ConversationModel.swift", line: 3, title: "stop crashes on a cancelled catch-up", evidence: "App/ConversationModel.swift:3 `catchUp?.cancel()`" });
  await wholePr(async () => {
    const m = model({ review: () => JSON.stringify({ merge_recommendation: "REQUEST_CHANGES", investigated_safe: [], findings: [swiftF] }), verify: () => confirm("catchUp?.cancel()") });
    await runLocalReviewPipeline(sample(files), settings, { request: m.request });
    const review = m.bodies.find((b) => stageOf(b) === "review").messages[1].content;
    const verify = m.bodies.find((b) => stageOf(b) === "verify").messages[1].content;
    for (const t of [review, verify]) assert.match(t, /<<<LANGUAGE_NOTES>>>[\s\S]*Swift:/);
  });
});

test("candidate prompt: a finding is tied to a changed line ('+', or for removed code its '-' lines and where it now fails); no claim about what a line was without its '-' line", () => {
  assert.match(HUNT_INSTRUCTIONS, /the '\+' line that causes it/);
  assert.match(HUNT_INSTRUCTIONS, /when the cause is code this diff removes \(a deleted guard or check\), the '-' line\(s\) together with the surviving line where it now fails/, "a deletion-only defect can be reported (Codex #182)");
  assert.match(HUNT_INSTRUCTIONS, /Never say what a line was or that it changed from something unless that '-' line is in the diff/);
});

test("evidence: a long hunk is cut around the cited line, not at its start (Codex #182)", () => {
  const added = Array.from({ length: 300 }, (_, i) => `+let value${i + 1} = compute(${i + 1}) // padding padding padding`);
  const diff = `--- App/Big.swift\n@@ -0,0 +1,300 @@\n${added.join("\n")}`;
  const out = hunkAt(diff, "App/Big.swift", 290, 2_000);
  assert.ok(out.length <= 2_200, `bounded (${out.length})`);
  assert.match(out, /let value290 = compute\(290\)/, "the cited line is in the window");
  assert.match(out, /^@@ -0,0 \+1,300 @@$/m, "the hunk header stays");
  assert.match(out, /… \d+ earlier line\(s\) of this hunk omitted/);
  const replaced = `--- a.swift\n@@ -1,203 +1,203 @@\n${Array.from({ length: 200 }, (_, i) => ` let keep${i} = ${i} // context context context`).join("\n")}\n-guard isAdmin(user) else { return }\n+guard true else { return }\n write(user)`;
  const w = hunkAt(replaced, "a.swift", 201, 600);
  assert.match(w, /-guard isAdmin\(user\) else \{ return \}\n\+guard true else \{ return \}/, "the removed line right before the cited one is kept");
});

// ── A Swift PR's context (2026-11-07: on WalkieBoard every .swift file ranked as a doc, so no feature turn
// carried code context, and each carried ~24K chars of the PR's other files as "changed non-code files") ──

const SWIFT = {
  "App/Conversation/ConversationModel.swift": "import Foundation\n\nfinal class ConversationModel {\n  private var catchUp: Task<Void, Never>?\n  func stop() {\n    catchUp?.cancel()\n  }\n}\n",
  "App/Home/HomeView.swift": "import SwiftUI\n\nstruct HomeView: View {\n  var body: some View { Text(\"Home\") }\n}\n",
  "Tests/ConversationModelTests.swift": "import XCTest\n\nfinal class ConversationModelTests: XCTestCase {\n  func testStop() { XCTAssertTrue(true) }\n}\n",
  "App/Localizable.xcstrings": `{\n  "strings": {\n${Array.from({ length: 1500 }, (_, i) => `    "key${i}": { "localizations": { "ko": { "value": "값 ${i}" } } },`).join("\n")}\n  }\n}\n`,
  "docs/decisions/2026-11-05-conversation.md": "# Conversation screen\n\nA failed catch-up is retried on the next opening, for the whole store: nothing is marked ended.\n",
};

test("Swift PR: a feature turn carries its own Swift file as code context, the design doc before resources, and a capped non-code share", async () => {
  const before = process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS;
  process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS = "2000";
  try {
    const m = model({ map: mapReply, review: reviewFor({}), verify: refute });
    await runLocalReviewPipeline(sample(SWIFT), settings, { request: m.request });
    const turns = m.bodies.filter((b) => stageOf(b) === "review").map((b) => b.messages[1].content);
    const home = turns.find((t) => /one feature of this PR: App\/Home\/HomeView\.swift/.test(t));
    assert.ok(home, "HomeView is a feature of its own");
    const snap = /<<<ATTACH:ashlar-snapshot\.md>>>\n([\s\S]*?)\n<<<END_ATTACH>>>/.exec(home)?.[1] ?? "";
    const nonCode = /<<<CHANGED_NON_CODE_FILES>>>\n([\s\S]*?)\n<<<END>>>/.exec(snap)?.[1] ?? "";
    const code = snap.replace(/<<<CHANGED_NON_CODE_FILES>>>\n[\s\S]*?\n<<<END>>>/, "");
    assert.match(code, /--- App\/Home\/HomeView\.swift \(L/, "the feature's Swift file is code context");
    assert.doesNotMatch(nonCode, /--- App\/Home\/HomeView\.swift/, "a Swift source is never a non-code file");
    const doc = nonCode.indexOf("docs/decisions/2026-11-05-conversation.md");
    const strings = nonCode.indexOf("App/Localizable.xcstrings");
    assert.ok(doc >= 0 && (strings < 0 || doc < strings), "the design doc comes before the string catalog");
    assert.ok(nonCode.length <= PART_NON_CODE_MAX_CHARS + 600, `non-code share ${nonCode.length} stays near the cap`);
  } finally {
    process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS = before;
  }
});

test("evidence: the verifier reads the design docs the PR edits (check 4: documented as intended)", () => {
  const f = { id: "x", status: "accepted", severity: "P1", file: "App/Conversation/ConversationModel.swift", line: 6, side: "RIGHT", title: "stop() swallows a failed catch-up", failureScenario: "x", rootCause: "y", evidence: "App/Conversation/ConversationModel.swift:6 `catchUp?.cancel()`", recommendedFix: "f", recommendedTest: "t" };
  const pack = evidencePack(sample(SWIFT), f, new Map(), 20_000);
  assert.match(pack.text, /<<<CHANGED_DOCS[^\n]*>>>\n--- docs\/decisions\/2026-11-05-conversation\.md\n# Conversation screen[\s\S]*retried on the next opening/);
  assert.doesNotMatch(pack.code, /retried on the next opening/, "a doc is never proof code");
});


// ── Prompt prefix cache (2026-11-07: oMLX reuses a cached prompt prefix, e.g. 8,192 of 12,512 input tokens;
// before this, on #566's diff only 7% of the prompt text was a prefix shared with an earlier request) ──

const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; };

test("prefix cache: verify turns of one PR share the fixed rules, the PR description and its changed docs before the candidate", async () => {
  const body = "Adds order charging.\n\nDesign: a charge below zero is rejected by the service, never by the controller.";
  const s = sample({ ...FILES, "docs/charging.md": "# Charging\n\nThe service validates every amount.\n" }, { body });
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F(), F({ title: "second distinct problem zzq", line: 2 })] }), verify: refute });
  await runLocalReviewPipeline(s, settings, { request: m.request });
  const turns = m.bodies.filter((b) => stageOf(b) === "verify").map((b) => b.messages[1].content);
  assert.ok(turns.length >= 2);
  const shared = commonPrefix(turns[0], turns[1]);
  const prefix = turns[0].slice(0, shared);
  assert.ok(prefix.startsWith(VERIFY_RULES));
  assert.match(prefix, /never by the controller/, "the PR description is in the shared prefix");
  assert.match(prefix, /<<<CHANGED_DOCS[\s\S]*The service validates every amount/, "the changed docs are in the shared prefix");
  assert.ok(turns[0].indexOf("<<<CANDIDATE") <= shared, "everything before the candidate is shared");
});

test("prefix cache: feature turns of a split PR share instructions, description, reply shape and rules before their own diff", async () => {
  const body = "Adds order charging. The mailer is unchanged in behaviour.";
  const m = model({ map: mapReply, review: reviewFor({}), verify: refute });
  await runLocalReviewPipeline(sample(FILES, { body }), settings, { request: m.request });
  const turns = m.bodies.filter((b) => stageOf(b) === "review").map((b) => b.messages[1].content);
  assert.equal(turns.length, 2);
  for (const t of turns) {
    assert.doesNotMatch(t, /^Changed: /m, "no per-feature Changed: line in the shared part");
    assert.ok(t.indexOf("<<<ATTACH:ashlar-policy.md>>>") < t.indexOf("<<<ATTACH:ashlar-diff.patch>>>") || !t.includes("<<<ATTACH:ashlar-policy.md>>>"), "rules before the feature's diff");
  }
  const shared = commonPrefix(turns[0], turns[1]);
  const prefix = turns[0].slice(0, shared);
  assert.ok(prefix.includes(HUNT_INSTRUCTIONS));
  assert.match(prefix, /The mailer is unchanged in behaviour/);
  assert.match(prefix, /Return exactly this JSON shape/);
  assert.ok(turns[0].indexOf("<<<ATTACH:ashlar-diff.patch>>>") >= shared, "the feature's diff is after the shared part");
});

test("prefix cache: a whole-PR turn keeps its Changed: line and the usual attachment order", async () => {
  await wholePr(async () => {
    const m = model({ review: reviewFor({}), verify: refute });
    await runLocalReviewPipeline(sample(), settings, { request: m.request });
    const t = m.bodies.find((b) => stageOf(b) === "review").messages[1].content;
    assert.match(t, /^Changed: /m);
    assert.ok(t.indexOf("<<<ATTACH:ashlar-diff.patch>>>") < t.indexOf("<<<ATTACH:ashlar-snapshot.md>>>"));
  });
});

test("evidence: the cited line's DIFF is never crowded out by a large code excerpt and the shared docs (Codex #182)", () => {
  const long = (i) => `  let value${i} = compute(${i}, "${"x".repeat(200)}")`;
  const lines = Array.from({ length: 120 }, (_, i) => long(i + 1));
  const content = ["func run() {", ...lines, "}"].join("\n");
  const ctx = (a, b) => lines.slice(a, b).map((l) => ` ${l}`).join("\n");
  const patch = `@@ -45,21 +45,21 @@\n${ctx(44, 54)}\n-  guard isAdmin(user) else { return }\n+  guard true else { return }\n${ctx(55, 65)}`;
  const s = {
    ...sample({ "App/Run.swift": content, "docs/design.md": `# Design\n\n${"Every call is checked by the coordinator. ".repeat(50)}\n` }),
    body: `Adds the run loop: ${"the guard moved to the coordinator, which checks every caller before it runs, ".repeat(18)}`,
  };
  s.diff = `--- App/Run.swift\n${patch}\n\n--- docs/design.md\n@@ -0,0 +1,3 @@\n+# Design`;
  const f = { id: "x", status: "accepted", severity: "P1", file: "App/Run.swift", line: 56, side: "RIGHT", title: "guard removed", failureScenario: "x", rootCause: "y", evidence: "App/Run.swift:56 `guard true else { return }`", recommendedFix: "f", recommendedTest: "t" };
  const pack = evidencePack(s, f, new Map(), 20_000);
  assert.ok(pack.text.length <= 20_000, `within budget (${pack.text.length})`);
  assert.match(pack.text, /<<<DIFF \(this PR's change around App\/Run\.swift:56;[\s\S]*-  guard isAdmin\(user\) else \{ return \}/);
  assert.match(pack.code, /56\| /, "the cited line's code window is kept, shrunk to fit");
});

// ── WalkieBoard #569 (2026-11-07): the local reviewer looked at roomToRun's line 145 for which errors sleep
// throws and never raised Codex's finding (the deadline is not re-checked after the wait); and 3 of its 9
// feature turns returned no usable review, leaving 12 files unreviewed ──

test("candidate prompt: the general and failure lenses ask for a state checked before a wait and used after it", () => {
  for (const lens of [LENSES.general, LENSES.failure]) {
    assert.match(lens, /checked before an await, sleep, lock or retry and relied on after it without being checked again/);
  }
  assert.match(LENSES.failure, /a wait can wake past its deadline/);
});

test("verifier: a guard that runs only before the wait does not refute a failure that arises during it", () => {
  assert.match(VERIFY_RULES, /A guard prevents the failure only if it runs on the failing path after the state it checks could change: a check made before an await, sleep or lock does not cover what happens during the wait/);
});

test("failed feature turn: a multi-file group that returns no usable review is retried one file at a time", async () => {
  const m = model({
    map: mapReply,
    review: (body) => {
      const group = groupOf(body);
      if (group.length > 1) return "I could not produce JSON for this group.";
      return reviewFor({ "src/orders/orders.controller.ts": [F()] })(body);
    },
    verify: () => confirm(),
  });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.deepEqual(review.findings.map((f) => f.title), ["create() charges a negative amount"], "the finding from the file retried alone is posted");
  assert.equal(review.unreviewed_paths, undefined, "every file was reviewed on retry");
  assert.match(out.pipelineSummary, /\(1 failed, 3 file\(s\) retried alone, all reviewed on retry\)/);
  const singles = m.bodies.filter((b) => stageOf(b) === "review" && groupOf(b).length === 1).map((b) => groupOf(b)[0]);
  for (const f of ORDERS) assert.ok(singles.includes(f), `${f} retried alone`);
});

test("failed feature turn: files still failing alone are unreviewed and named in the ops line", async () => {
  const m = model({
    map: mapReply,
    review: (body) => (groupOf(body).some((f) => f.startsWith("src/orders/")) ? "no json" : reviewFor({})(body)),
    verify: () => confirm(),
  });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const review = JSON.parse(out.raw);
  assert.deepEqual([...review.unreviewed_paths].sort(), [...ORDERS].sort());
  assert.match(out.pipelineSummary, /\(1 failed, 3 file\(s\) retried alone, unreviewed: orders\.(controller|service)\.ts, /);
  assert.ok(review.coverage.filter((c) => c.reason === "feature review failed").length === 3);
});

// ── Precision on aicc-center and WalkieBoard (2026-11-09: 17 posted findings after #183, none valid; 8 of 10
// false positives were refuted by code in another file — a callee, a caller, a DTO, a config list, the
// database; at least 4 posted findings were "uncertain"; and the model marked nearly every file not_cleared) ──

test("coverage: Ashlar records it — a file reviewed in a feature turn is cleared whatever the model says; only failed files are not", async () => {
  const review = (body) => {
    const group = groupOf(body);
    if (group.includes("src/mail/mailer.ts")) return "no json";
    return JSON.stringify({ merge_recommendation: "COMMENT", investigated_safe: group.map((f) => `${f}: read`), findings: [], coverage: group.map((file) => ({ file, status: "not_cleared", reason: "helpers not shown" })) });
  };
  const m = model({ map: mapReply, review, verify: refute });
  const out = await runLocalReviewPipeline(sample(), settings, { request: m.request });
  const cov = JSON.parse(out.raw).coverage;
  for (const f of ORDERS) assert.deepEqual(cov.filter((c) => c.file === f).map((c) => c.status), ["cleared"], f);
  assert.deepEqual(cov.filter((c) => c.file === "src/mail/mailer.ts").map((c) => [c.status, c.reason]), [["not_cleared", "feature review failed"]]);
  assert.match(HUNT_INSTRUCTIONS, /coverage: leave it an empty array \(Ashlar records coverage itself\)/);
});

test("uncertain: by default a candidate the verifier could not decide is not posted", async () => {
  assert.equal(DEFAULT_SETTINGS.localPipelineKeepUncertain, false);
  const m = model({ map: mapReply, review: reviewFor({ "src/orders/orders.controller.ts": [F()] }), verify: () => JSON.stringify({ trace: "t", verdict: "uncertain", blocking_code: "", proof_quote: "", severity: "P2" }) });
  const out = await runLocalReviewPipeline(sample(), { ...settings, localPipelineKeepUncertain: DEFAULT_SETTINGS.localPipelineKeepUncertain }, { request: m.request });
  assert.equal(JSON.parse(out.raw).findings.length, 0);
});

test("verifier rule 6: a claim about what a caller, client, database or config supplies needs a path that supplies it", () => {
  assert.match(VERIFY_RULES, /6\. Does the failure depend on something the cited code does not control/);
  assert.match(VERIFY_RULES, /If the callers shown never pass it, or the validation, schema, constraint or list shown rules it out, it is refuted\. If no such path is shown, it is uncertain, never confirmed\./);
});

test("calledNames: plain lower-case methods, member calls and JSX components; keywords and collection helpers left out", () => {
  assert.deepEqual(calledNames("switch whole.revert(in: &field) { case .kept: log(x) }"), ["revert"]);
  assert.deepEqual(calledNames("return <ItemBadge item={item} /> && items.map((x) => format(x))"), ["ItemBadge", "format"]);
  assert.deepEqual(calledNames("if (ok) { fetchJson(url, {}, { raw: true }) }"), ["fetchJson"]);
});

test("enclosingName: the function, method or component that holds a line", () => {
  const js = ["export default function ItemBadge({ item }) {", "  const due = item.label;", "  return due;", "}"];
  assert.equal(enclosingName(js, 2), "ItemBadge");
  const swift = ["final class Host {", "  private func revertSwap() {", "    defer { offerRevert() }", "  }", "}"];
  assert.equal(enclosingName(swift, 3), "revertSwap");
  const arrow = ["const downloadFile = async (id) => {", "  return fetchJson(url, {}, other);", "};"];
  assert.equal(enclosingName(arrow, 2), "downloadFile");
});

test("evidence: the verifier sees the definition of a lower-case method the cited line calls, in another file (WalkieBoard #570)", () => {
  const files = {
    "Keyboard/Host.swift": "final class Host {\n  private func revertSwap() {\n    defer { offerRevert() }\n    switch whole.revert(in: &field) {\n    case .reverted: break\n    case .kept(let reason): log(reason)\n    }\n  }\n}\n",
    "Core/WholeDictation.swift": "public struct WholeDictation {\n  public mutating func revert(in field: inout Field) -> Outcome {\n    guard let swap = swapped else { return .nothing }\n    swapped = nil\n    return field.matches(swap) ? .reverted : .kept(reason: \"edited\")\n  }\n}\n",
  };
  const f = { id: "x", status: "accepted", severity: "P2", file: "Keyboard/Host.swift", line: 6, side: "RIGHT", title: "Revert button reappears when revert returns kept", failureScenario: "The function does not drop the swap.", rootCause: "No dropSwap on kept.", evidence: "Keyboard/Host.swift:4 `switch whole.revert(in: &field) {`", recommendedFix: "f", recommendedTest: "t" };
  const pack = evidencePack(sample(files), f, new Map(), 20_000);
  assert.match(pack.code, /Core\/WholeDictation\.swift[\s\S]*func revert\(in field: inout Field\)[\s\S]*swapped = nil/);
});

test("evidence: the verifier sees who calls the cited function (aicc: a component only rendered for an existing row)", () => {
  const files = { "src/items/ItemBadge.js": "export default function ItemBadge({ item }) {\n  const label = item.label;\n  return label;\n}\n" };
  // The caller is not changed by the PR: only the caller search reaches it.
  const s = sample(files, { referenceFiles: [{ path: "src/items/ItemRow.js", content: "import ItemBadge from './ItemBadge';\nexport function ItemRow({ item }) {\n  if (!item) return null;\n  return <ItemBadge item={item} />;\n}\n" }] });
  const f = { id: "x", status: "accepted", severity: "P2", file: "src/items/ItemBadge.js", line: 2, side: "RIGHT", title: "Unhandled null item prop crashes the render", failureScenario: "A caller renders it with item null.", rootCause: "No guard.", evidence: "src/items/ItemBadge.js:2 `const label = item.label;`", recommendedFix: "f", recommendedTest: "t" };
  const pack = evidencePack(s, f, new Map(), 20_000);
  assert.match(pack.code, /src\/items\/ItemRow\.js[\s\S]*if \(!item\) return null;[\s\S]*<ItemBadge item=\{item\} \/>/);
});

test("feature turn: CALLEE_DEFINITIONS carries the code its added lines call in another feature's file", async () => {
  const files = {
    "Keyboard/Host.swift": "final class Host {\n  func tap() {\n    let outcome = whole.revert(in: &field)\n    show(outcome)\n  }\n}\n",
    "Core/WholeDictation.swift": "public struct WholeDictation {\n  public mutating func revert(in field: inout Field) -> Outcome {\n    swapped = nil\n    return .kept\n  }\n}\n",
  };
  const before = process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS;
  process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS = "600";
  try {
    const m = model({ map: mapReply, review: reviewFor({}), verify: refute });
    await runLocalReviewPipeline(sample(files), settings, { request: m.request });
    const host = m.bodies.filter((b) => stageOf(b) === "review").map((b) => b.messages[1].content).find((t) => /one feature of this PR: Keyboard\/Host\.swift/.test(t));
    assert.ok(host, "Host.swift is a feature of its own");
    assert.match(host, /<<<CALLEE_DEFINITIONS[^\n]*>>>\n--- Core\/WholeDictation\.swift \(L[\s\S]*func revert\(in field: inout Field\)[\s\S]*swapped = nil/);
  } finally {
    process.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS = before;
  }
});

