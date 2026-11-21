// The Codex reviewer leg through the production module graph (app-fixture): webhook → harbor snapshot →
// Codex request to the fixture's proxy route (/codex/v1/chat/completions) → schema merge → GitHub post.
// Only GitHub I/O and settings persistence are adapters. Synthetic PR content only.
import test from "node:test";
import assert from "node:assert/strict";
import { appFixture, eventually } from "./app-fixture.mjs";
import { isConvergedFindings } from "../../src/lib/review-loop.ts";

const finding = {
  severity: "P1",
  file: "a.ts",
  line: 1,
  side: "RIGHT",
  title: "answer is off by one",
  failure_scenario: "Callers expecting 41 get 42.",
  root_cause: "The constant changed.",
  evidence: "a.ts:1 `export const answer = 42;`",
  recommended_fix: "Keep 41.",
  recommended_test: "Assert 41.",
};
const clean = JSON.stringify({
  merge_recommendation: "COMMENT",
  highest_risk: "",
  investigated_safe: ["a.ts: constant only"],
  assumptions: [],
  findings: [],
});
const dirty = JSON.stringify({
  merge_recommendation: "REQUEST_CHANGES",
  highest_risk: "wrong answer",
  investigated_safe: [],
  assumptions: [],
  findings: [finding],
});

const job = (app, id) => app.harbor.getHarbor().jobs.find((j) => j.id === id);
const ended = (app, id) =>
  eventually(
    () => ["posted", "skipped", "dlq", "cancelled"].includes(job(app, id)?.status),
    `job ${id} did not finish`,
  );
const codexSent = (app, n = 1) =>
  eventually(() => app.codexRequests.length >= n, `Codex request ${n} never arrived`);
/** The bridge's chat result, as the extension delivers it (no force: the merge waits for the other racers). */
const chatgpt = (app, id, raw) =>
  app.harbor.submitHarborChat(id, raw, [{ provider: "chatgpt", raw }]);

function sse(res, content, finish = "stop") {
  const data = (o) => `data: ${JSON.stringify(o)}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(data({ choices: [{ delta: { content: content.slice(0, 9) } }] }));
  res.end(
    data({ choices: [{ delta: { content: content.slice(9) }, finish_reason: finish }] }) +
      "data: [DONE]\n\n",
  );
}
function quota(res, body) {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const hhmm = (at) =>
  `${String(new Date(at).getUTCHours()).padStart(2, "0")}:${String(new Date(at).getUTCMinutes()).padStart(2, "0")} UTC`;

async function codexApp(t, settings = {}, github = {}) {
  const app = await appFixture({ reviewLocal: false, reviewCodex: true, ...settings }, github);
  t.after(() => app.close());
  return app;
}

test("Codex races ChatGPT: its request carries no sampling fields, and its finding is merged and posted", async (t) => {
  const app = await codexApp(t);
  const out = await app.mention("codex-findings");
  await codexSent(app);
  const { body } = app.codexRequests[0];
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.stream, true);
  assert.equal(body.reasoning_effort, "medium");
  for (const field of [
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "max_tokens",
    "service_tier",
  ])
    assert.equal(field in body, false, field);
  assert.equal(body.response_format?.type, "json_schema");
  assert.match(
    body.messages[1].content,
    /<<<ATTACH:ashlar-diff\.patch>>>[\s\S]*export const answer = 42;/,
    "the job's chat prompt, attachments inline",
  );
  assert.match(body.messages[1].content, /Return at most 8 findings/);
  assert.equal(app.localRequests.length, 0, "never sent to the local model");
  assert.deepEqual([...job(app, out.jobId).reviewProviders], ["chatgpt", "codex"]);
  // The bridge never offers Codex to the extension.
  const offer = app.bridge.takeNextBridgeJob("fixture-client");
  assert.ok(offer, "the chat leg is offered");
  assert.deepEqual([...offer.providers], ["chatgpt"]);
  // ChatGPT answers first: the merge waits for Codex.
  assert.equal((await chatgpt(app, out.jobId, clean)).ok, true);
  assert.equal(job(app, out.jobId).status, "awaiting_chat", "still racing Codex");
  const lane = app.harbor
    .publicJobs([job(app, out.jobId)])[0]
    .reviewerLanes.find((l) => l.provider === "codex");
  assert.equal(lane.label, "Codex (ChatGPT account)");
  assert.equal(lane.state, "generating");
  sse(app.codexResponses[0], dirty);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(app.reviews.length, 1);
  assert.match(app.reviews[0].body, /ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 p2=0/);
  assert.equal(app.reviews[0].comments.length, 1);
  assert.match(app.reviews[0].comments[0].body, /answer is off by one/);
  assert.match(done.plan, /Schema-merged chatgpt \+ codex/);
  assert.equal(app.codexRequests.length, 1, "one Codex request per review");
});

test("a Codex request goes out while the local model holds its lease and the slot lock", async (t) => {
  const app = await codexApp(t, { reviewLocal: true });
  app.env.ASHLAR_LOCAL_SLOT_LOCK = "true";
  const out = await app.mention("codex-beside-local");
  await eventually(() => app.localRequests.length === 1, "the local leg is running");
  await codexSent(app);
  assert.equal(
    app.localResponses[0].writableEnded,
    false,
    "local still holds the lease and the slot",
  );
  sse(app.codexResponses[0], clean);
  await eventually(
    () => (job(app, out.jobId)?.storedLegs ?? []).some((l) => l.provider === "codex"),
    "the Codex leg is stored",
  );
});

test("a superseded job aborts its Codex request", async (t) => {
  const app = await codexApp(t);
  const first = await app.mention("codex-supersede-1");
  await codexSent(app);
  const second = await app.mention("codex-supersede-2");
  await eventually(
    () => job(app, first.jobId).status === "cancelled",
    "the first job is superseded",
  );
  await eventually(
    () => app.codexResponses[0].req.destroyed || app.codexResponses[0].destroyed,
    "the old Codex request was aborted",
  );
  await codexSent(app, 2);
  assert.equal(app.harbor.orphanedLocalState().length, 0);
  sse(app.codexResponses[1], clean);
  await chatgpt(app, second.jobId, clean);
  await ended(app, second.jobId);
  assert.equal(job(app, second.jobId).status, "posted");
});

test("usage limit mid-job beside a clean ChatGPT: Codex leaves the pinned list, the review posts clean and converges; the next job sends no Codex request", async (t) => {
  const app = await codexApp(t);
  const out = await app.mention("codex-quota");
  await codexSent(app);
  await chatgpt(app, out.jobId, clean);
  const resetAt = app.clock.now + 3_600_000;
  const note = `Codex skipped (usage limit, resets at ${hhmm(resetAt)})`;
  // The backend's own words never reach the job: they name ChatGPT and "disconnected".
  quota(app.codexResponses[0], {
    error: {
      type: "usage_limit_reached",
      message: "ChatGPT account disconnected: usage limit",
      resets_in_seconds: 3600,
    },
  });
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.deepEqual([...done.reviewProviders], ["chatgpt"]);
  assert.deepEqual([...done.quotaEndedLegs], ["codex"]);
  assert.deepEqual([...(done.skippedProviders ?? [])], []);
  assert.deepEqual([...(done.incompleteProviders ?? [])], []);
  assert.equal(done.codexNote, note);
  const body = app.reviews[0].body;
  assert.ok(body.startsWith("Didn't find any major issues."), body.slice(0, 200));
  assert.ok(isConvergedFindings(body), "clean converges");
  assert.ok(body.includes(note), "the review body carries the fixed note");
  assert.doesNotMatch(JSON.stringify(done), /disconnected/i, "no backend text on the job");
  await eventually(
    () => app.ops.some((b) => b.includes(out.jobId) && b.includes(note)),
    "the ops comment carries the fixed note",
  );

  // The next job, during the cooldown: Codex is not pinned and no request is spent.
  const next = await app.mention("codex-quota-next");
  await eventually(() => job(app, next.jobId)?.status === "awaiting_chat", "snapshot ready");
  assert.deepEqual([...job(app, next.jobId).reviewProviders], ["chatgpt"]);
  assert.equal(job(app, next.jobId).codexNote, note);
  await eventually(
    () => app.ops.some((b) => b.includes(next.jobId) && b.includes(`- ${note}`)),
    "the next job's ops comment says why, in fixed text",
  );
  await chatgpt(app, next.jobId, clean);
  await ended(app, next.jobId);
  assert.equal(job(app, next.jobId).status, "posted");
  assert.equal(app.codexRequests.length, 1, "no Codex request during the cooldown");
  assert.equal(
    app.harbor.publicSettings(app.harbor.getHarbor().settings).codexCooldownUntil,
    resetAt,
  );
});

test("Codex as the only reviewer: nothing is offered to the bridge, and its finding is posted on its own", async (t) => {
  const app = await codexApp(t, { reviewChatgpt: false });
  const out = await app.mention("codex-only-review");
  await codexSent(app);
  assert.deepEqual([...job(app, out.jobId).reviewProviders], ["codex"]);
  assert.equal(app.bridge.takeNextBridgeJob("fixture-client"), null, "no chat leg to offer");
  sse(app.codexResponses[0], dirty);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(app.reviews.length, 1);
  assert.match(app.reviews[0].body, /ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 p2=0/);
  assert.match(app.reviews[0].comments[0].body, /answer is off by one/);
  assert.equal(app.localRequests.length, 0);
  assert.equal(app.codexRequests.length, 1);
});

test("Codex as the only reviewer: a clean reply posts a clean, converged review", async (t) => {
  const app = await codexApp(t, { reviewChatgpt: false });
  const out = await app.mention("codex-only-clean");
  await codexSent(app);
  sse(app.codexResponses[0], clean);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(app.reviews.length, 1);
  assert.ok(isConvergedFindings(app.reviews[0].body), "a clean Codex-only review converges");
  assert.equal(done.noReviewAttempt ?? false, false);
});

test("Codex alone hitting its usage limit is never a clean review; during the cooldown a Codex-only job is a failed attempt", async (t) => {
  const app = await codexApp(t, { reviewChatgpt: false });
  const out = await app.mention("codex-only-quota");
  await codexSent(app);
  assert.deepEqual([...job(app, out.jobId).reviewProviders], ["codex"]);
  quota(app.codexResponses[0], {
    error: { type: "usage_limit_reached", resets_at: Math.floor(app.clock.now / 1000) + 1800 },
  });
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "skipped");
  assert.match(done.skipReason, /usage limit/);
  assert.equal(app.reviews.length, 0, "nothing posted");
  assert.equal(done.providerErrors.codex.code, "quota");
  // A failed attempt, exactly as the cooldown case below: never counted as this head's review.
  assert.equal(done.noReviewAttempt, true);
  await eventually(
    () =>
      app.ops.some(
        (b) =>
          b.includes(out.jobId) &&
          /\*\*Status:\*\* failed/.test(b) &&
          /ashlar-attempt failed/.test(b),
      ),
    "the mid-job usage limit reads as a failed attempt",
  );

  const next = await app.mention("codex-only-cooling");
  await ended(app, next.jobId);
  const cooling = job(app, next.jobId);
  assert.equal(cooling.status, "skipped");
  assert.equal(cooling.noReviewAttempt, true);
  assert.match(cooling.skipReason, /^Codex skipped \(usage limit, resets at \d\d:\d\d UTC\)$/);
  assert.equal(app.codexRequests.length, 1);
  await eventually(
    () =>
      app.ops.some(
        (b) =>
          b.includes(next.jobId) &&
          /\*\*Status:\*\* failed/.test(b) &&
          /ashlar-attempt failed/.test(b),
      ),
    "a failed attempt, not a review",
  );
});

test("a Codex reply cut off before it finished stays incomplete beside a clean ChatGPT (never clean)", async (t) => {
  const app = await codexApp(t);
  const out = await app.mention("codex-truncated");
  await codexSent(app);
  await chatgpt(app, out.jobId, clean);
  sse(
    app.codexResponses[0],
    '{"merge_recommendation":"REQUEST_CHANGES","findings":[{"severity":"P1","file":"a.ts","line":1,"title":"answer',
    "length",
  );
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.ok(done.incompleteProviders.includes("codex"));
  const body = app.reviews[0].body;
  assert.ok(!isConvergedFindings(body), "not a clean pass");
  assert.doesNotMatch(body, /^Didn't find any major issues/);
  assert.match(body, /No complete review from codex/);
});

test("publicSettings masks the Codex proxy key", async (t) => {
  const app = await codexApp(t);
  const pub = app.harbor.publicSettings({
    ...app.harbor.getHarbor().settings,
    codexApiKey: "proxy-secret",
  });
  assert.equal(pub.codexApiKey, "");
  assert.equal(pub.codexApiKeySet, true);
  assert.equal(
    app.harbor.publicSettings({ ...app.harbor.getHarbor().settings, codexApiKey: "" })
      .codexApiKeySet,
    false,
  );
});

const localReply = (res, content) =>
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));

async function verifyCleanApp(t) {
  const app = await codexApp(t, {
    reviewLocal: true,
    localReviewRole: "verify-clean",
    localJsonRepairEnabled: false,
  });
  app.env.ASHLAR_LOCAL_LLM_STREAM = "false";
  return app;
}
/** The worker reports ChatGPT's usage limit, as the extension does. */
function chatgptQuota(app, jobId) {
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob("fixture-client");
  assert.equal(
    app.bridge.failBridgeProvider(jobId, "chatgpt", "quota: usage limit reached", take.leaseId),
    true,
  );
}

// verify-clean: Codex is a primary reviewer like chat. It runs first with chat; local verifies a clean
// merged primary result, or runs as the fallback once no primary can still produce a usable verdict.
test("verify-clean: ChatGPT at its usage limit and a clean Codex reply: local verifies Codex's clean result before anything posts", async (t) => {
  const app = await verifyCleanApp(t);
  const out = await app.mention("verify-codex-clean");
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  assert.equal(app.localRequests.length, 0, "local is held back in verify-clean");
  chatgptQuota(app, out.jobId);
  sse(app.codexResponses[0], clean);
  await eventually(() => app.localRequests.length === 1, "local runs as the verifier");
  assert.ok(job(app, out.jobId).localVerifyStartedAt, "released as the verification round");
  assert.equal(job(app, out.jobId).localFallbackAt, undefined, "not as the fallback: Codex returned a usable verdict");
  assert.equal(app.reviews.length, 0, "nothing posted before local");
  localReply(app.localResponses[0], clean);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(done.localVerified, true);
  assert.equal(done.canonicalProvider, "codex", "Codex stands in for the ChatGPT leg at its usage limit");
  assert.match(done.plan, /Schema-merged .*codex/);
  assert.match(done.plan, /Schema-merged .*local/);
  assert.match(app.reviews[0].body, /codex found nothing; local verification agreed\./);
  assert.ok(isConvergedFindings(app.reviews[0].body), "verified clean");
});

test("verify-clean: ChatGPT at its usage limit while Codex is still running: local waits for Codex, and Codex's finding posts without local", async (t) => {
  const app = await verifyCleanApp(t);
  const out = await app.mention("verify-codex-running");
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  chatgptQuota(app, out.jobId);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(app.localRequests.length, 0, "no local request while Codex, a primary reviewer, still runs");
  assert.equal(job(app, out.jobId).localFallbackAt, undefined);
  assert.equal(job(app, out.jobId).status, "awaiting_chat");
  sse(app.codexResponses[0], dirty);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.match(app.reviews[0].body, /ashlar-findings total=1 /, "Codex's finding is posted");
  assert.equal(app.localRequests.length, 0, "findings: no verification round");
  assert.equal(done.localVerifyStartedAt, undefined);
  assert.equal(done.localFallbackAt, undefined);
});

test("verify-clean: a clean Codex reply that lands before ChatGPT hits its usage limit is verified by local, never replaced by the fallback", async (t) => {
  const app = await verifyCleanApp(t);
  const out = await app.mention("verify-codex-first");
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  sse(app.codexResponses[0], clean);
  await eventually(
    () => (job(app, out.jobId)?.storedLegs ?? []).some((l) => l.provider === "codex"),
    "the Codex leg is stored while ChatGPT still runs",
  );
  assert.equal(app.localRequests.length, 0);
  chatgptQuota(app, out.jobId);
  await eventually(() => app.localRequests.length === 1, "local runs");
  assert.ok(job(app, out.jobId).localVerifyStartedAt, "as the verifier of Codex's clean result");
  assert.equal(job(app, out.jobId).localFallbackAt, undefined, "never as the fallback");
  localReply(app.localResponses[0], clean);
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, "posted");
  assert.equal(job(app, out.jobId).localVerified, true);
});

/** verify-clean with local + Codex only (no chat reviewer). */
async function localCodexApp(t) {
  const app = await codexApp(t, {
    reviewChatgpt: false,
    reviewLocal: true,
    localReviewRole: "verify-clean",
    localJsonRepairEnabled: false,
  });
  app.env.ASHLAR_LOCAL_LLM_STREAM = "false";
  return app;
}
async function localCodexJob(app, name) {
  const out = await app.mention(name);
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  assert.deepEqual([...job(app, out.jobId).reviewProviders], ["local", "codex"]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.localRequests.length, 0, "local is held back while Codex reviews first");
  return out.jobId;
}

test("verify-clean, local + Codex: Codex's finding posts without running local, and local is not counted skipped or incomplete", async (t) => {
  const app = await localCodexApp(t);
  const id = await localCodexJob(app, "lc-findings");
  assert.match(job(app, id).plan, /codex review first; local verifies a clean result/);
  await eventually(
    () => app.ops.some((b) => b.includes(id) && b.includes("Reviewers: codex; local verifies a clean result.")),
    "the ops comment names local as the verifier",
  );
  sse(app.codexResponses[0], dirty);
  await ended(app, id);
  const done = job(app, id);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(app.reviews.length, 1);
  assert.match(app.reviews[0].body, /ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 p2=0/);
  assert.match(app.reviews[0].comments[0].body, /answer is off by one/);
  assert.equal(app.localRequests.length, 0, "zero local requests");
  assert.deepEqual([...(done.skippedProviders ?? [])], [], "local is not a skipped reviewer");
  assert.deepEqual([...(done.incompleteProviders ?? [])], [], "nor an incomplete one");
  assert.doesNotMatch(app.reviews[0].body, /ashlar-outcome incomplete/);
  assert.equal(done.noReviewAttempt ?? false, false);
});

test("verify-clean, local + Codex: a clean Codex reply is held while local verifies, then posts verified clean", async (t) => {
  const app = await localCodexApp(t);
  const id = await localCodexJob(app, "lc-clean");
  sse(app.codexResponses[0], clean);
  await eventually(() => app.localRequests.length === 1, "local verification starts");
  assert.ok(job(app, id).localVerifyStartedAt, "a verification round");
  assert.deepEqual([...job(app, id).localVerifyChat], ["codex"]);
  await eventually(
    () => app.ops.some((b) => b.includes(id) && b.includes("The review found nothing; the local LLM is verifying before the review posts.")),
    "the ops comment says local is verifying the clean result",
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.reviews.length, 0, "the clean Codex result is held");
  assert.equal(job(app, id).status, "awaiting_chat");
  localReply(app.localResponses[0], clean);
  await ended(app, id);
  const done = job(app, id);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(done.localVerified, true);
  const body = app.reviews[0].body;
  assert.ok(body.startsWith("Didn't find any major issues."), body.slice(0, 200));
  assert.match(body, /codex found nothing; local verification agreed\./);
  assert.ok(isConvergedFindings(body), "verified clean converges");
  assert.equal(app.codexRequests.length, 1);
});

test("verify-clean, local + Codex: Codex at its usage limit releases local as the fallback; a clean local result posts incomplete, never converged", async (t) => {
  const app = await localCodexApp(t);
  const id = await localCodexJob(app, "lc-quota");
  quota(app.codexResponses[0], { error: { type: "usage_limit_reached", resets_in_seconds: 3600 } });
  await eventually(() => app.localRequests.length === 1, "local runs as the fallback");
  const released = job(app, id);
  assert.ok(released.localFallbackAt, "released as the fallback");
  assert.equal(released.localVerifyStartedAt, undefined);
  // The last primary stays pinned as a skipped reviewer, as a chat leg at its usage limit does.
  assert.deepEqual([...released.reviewProviders], ["local", "codex"]);
  assert.equal(released.providerErrors.codex.code, "quota");
  localReply(app.localResponses[0], clean);
  await ended(app, id);
  const done = job(app, id);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(done.noReviewAttempt ?? false, false, "not a failed attempt: local is pinned");
  assert.deepEqual([...done.skippedProviders], ["codex"]);
  const body = app.reviews[0].body;
  assert.ok(!isConvergedFindings(body), "not a clean pass");
  assert.match(body, /ashlar-outcome incomplete/);
  assert.match(body, /^<!-- ashlar-review-summary -->\nCodex did not finish a full review\./);
  assert.match(body, /Codex skipped \(usage limit/);
  assert.match(done.plan, /Schema-merged local/);
});

test("verify-clean, local + Codex: a Codex HTTP 500 releases local as the fallback, as a chat failure does", async (t) => {
  const app = await localCodexApp(t);
  const id = await localCodexJob(app, "lc-500");
  app.codexResponses[0].writeHead(500, { "content-type": "text/plain" });
  app.codexResponses[0].end("upstream exploded");
  await eventually(() => app.localRequests.length === 1, "local runs as the fallback");
  assert.ok(job(app, id).localFallbackAt, "released as the fallback");
  assert.match(job(app, id).plan, /^Codex returned nothing usable; local runs as the fallback\./);
  localReply(app.localResponses[0], clean);
  await ended(app, id);
  const done = job(app, id);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(done.noReviewAttempt ?? false, false);
  // As the chat-down fallback: the primary that returned nothing is a skipped reviewer, so not a clean pass.
  assert.deepEqual([...done.skippedProviders], ["codex"]);
  assert.ok(!isConvergedFindings(app.reviews[0].body), "a skipped primary is no clean pass");
  assert.match(app.reviews[0].body, /ashlar-outcome incomplete/);
});

test("verify-clean, local + Codex: a Codex reply that is not review JSON releases local as the fallback; the reply posts as evidence", async (t) => {
  const app = await localCodexApp(t);
  const id = await localCodexJob(app, "lc-prose");
  sse(app.codexResponses[0], "PROSE-MARK: I looked at a.ts and think the constant is wrong.");
  await eventually(() => app.localRequests.length === 1, "local runs as the fallback");
  assert.ok(job(app, id).localFallbackAt, "released as the fallback, not as a verifier");
  assert.equal(job(app, id).localVerifyStartedAt, undefined);
  assert.equal(app.reviews.length, 0, "nothing posted before local");
  localReply(app.localResponses[0], clean);
  await ended(app, id);
  const done = job(app, id);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  const body = app.reviews[0].body;
  assert.match(body, /PROSE-MARK/, "Codex's reply posts verbatim");
  assert.ok(!isConvergedFindings(body), "never a clean pass");
  assert.match(done.plan, /Schema-merged .*codex/);
  assert.match(done.plan, /Schema-merged .*local/);
});

test("verify-clean, ChatGPT + Codex + local: a clean ChatGPT beside Codex's finding posts without local", async (t) => {
  const app = await verifyCleanApp(t);
  const out = await app.mention("mixed-findings");
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  assert.equal((await chatgpt(app, out.jobId, clean)).ok, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(job(app, out.jobId).status, "awaiting_chat", "the merge waits for Codex");
  assert.equal(app.localRequests.length, 0);
  sse(app.codexResponses[0], dirty);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.match(app.reviews[0].body, /ashlar-findings total=1 /);
  assert.equal(app.localRequests.length, 0, "findings: no verification round");
  assert.equal(done.canonicalProvider, "chatgpt", "the browser chat provider stays canonical");
  assert.deepEqual([...(done.skippedProviders ?? [])], []);
});

test("verify-clean, ChatGPT + Codex + local: clean ChatGPT and clean Codex are verified by local", async (t) => {
  const app = await verifyCleanApp(t);
  const out = await app.mention("mixed-clean");
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  sse(app.codexResponses[0], clean);
  await eventually(
    () => (job(app, out.jobId)?.storedLegs ?? []).some((l) => l.provider === "codex"),
    "the Codex leg is stored",
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.localRequests.length, 0, "ChatGPT is still a racing primary");
  assert.equal((await chatgpt(app, out.jobId, clean)).ok, true);
  await eventually(() => app.localRequests.length === 1, "local verification starts");
  assert.deepEqual([...job(app, out.jobId).localVerifyChat], ["chatgpt", "codex"]);
  assert.equal(app.reviews.length, 0, "held while local verifies");
  localReply(app.localResponses[0], clean);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(done.localVerified, true);
  assert.equal(done.canonicalProvider, "chatgpt");
  assert.match(app.reviews[0].body, /chatgpt \+ codex found nothing; local verification agreed\./);
  assert.ok(isConvergedFindings(app.reviews[0].body));
});

test("verify-clean, local + Codex: turning Codex off mid-flight releases local as the fallback; a clean local result posts incomplete", async (t) => {
  const app = await localCodexApp(t);
  const id = await localCodexJob(app, "lc-off");
  app.harbor.patchHarborSettings({ reviewCodex: false });
  await eventually(
    () => app.codexResponses[0].req.destroyed || app.codexResponses[0].destroyed,
    "the Codex request was aborted",
  );
  await eventually(() => app.localRequests.length === 1, "local runs as the fallback");
  assert.ok(job(app, id).localFallbackAt, "released as the fallback");
  assert.deepEqual([...job(app, id).reviewProviders], ["local", "codex"]);
  localReply(app.localResponses[0], clean);
  await ended(app, id);
  const done = job(app, id);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(done.noReviewAttempt ?? false, false);
  assert.deepEqual([...done.skippedProviders], ["codex"]);
  assert.ok(!isConvergedFindings(app.reviews[0].body), "a clean local fallback is not a clean pass");
  assert.match(app.reviews[0].body, /ashlar-outcome incomplete/);
  assert.equal(app.codexRequests.length, 1);
});

for (const [name, reply] of [["clean", clean], ["dirty", dirty]]) {
  test(`verify-clean, ChatGPT + Codex + local: the bridge offline past its grace beside a stored ${name} Codex reply never hangs`, async (t) => {
    const app = await verifyCleanApp(t);
    const out = await app.mention(`stall-${name}`);
    await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
    await codexSent(app);
    sse(app.codexResponses[0], reply);
    await eventually(
      () => (job(app, out.jobId)?.storedLegs ?? []).some((l) => l.provider === "codex"),
      "the Codex leg is stored",
    );
    assert.equal(app.bridge.getBridgePublic().connected, false, "the bridge never connected");
    app.clock.now += 3_600_000; // far past the bridge grace
    if (name === "clean") {
      await eventually(() => app.localRequests.length === 1, "local verifies Codex's clean result");
      assert.ok(job(app, out.jobId).localVerifyStartedAt, "a verification round, not the fallback");
      assert.equal(job(app, out.jobId).localFallbackAt, undefined);
      localReply(app.localResponses[0], clean);
    }
    await ended(app, out.jobId);
    const done = job(app, out.jobId);
    assert.equal(done.status, "posted", done.githubError || done.plan);
    assert.equal(done.providerErrors.chatgpt.code, "cancelled", "the stalled chat leg is an explicit skip");
    assert.match(done.providerErrors.chatgpt.message, /^Chrome bridge offline/);
    assert.equal(done.canonicalProvider, "codex", "Codex stands in for the stalled chat leg");
    if (name === "dirty") {
      assert.match(app.reviews[0].body, /ashlar-findings total=1 /, "Codex's finding posts");
      assert.equal(app.localRequests.length, 0, "findings: no local run");
    } else {
      assert.equal(done.localVerified, true);
    }
  });
}

test("verify-clean, ChatGPT + Codex + local: a Codex reply that is not review JSON beside a clean ChatGPT is auxiliary, like a broken Grok leg: local still verifies, never clean", async (t) => {
  const app = await verifyCleanApp(t);
  const out = await app.mention("aux-codex");
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  sse(app.codexResponses[0], "AUX-MARK: no JSON here, just thoughts about a.ts.");
  await eventually(
    () => (job(app, out.jobId)?.storedLegs ?? []).some((l) => l.provider === "codex"),
    "the Codex leg is stored",
  );
  assert.equal((await chatgpt(app, out.jobId, clean)).ok, true);
  await eventually(() => app.localRequests.length === 1, "local verifies ChatGPT's clean verdict");
  assert.ok(job(app, out.jobId).localVerifyStartedAt);
  assert.equal(app.reviews.length, 0, "nothing posted before local");
  localReply(app.localResponses[0], clean);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.equal(done.auxiliaryProviderFailures?.codex, "unparseable");
  assert.equal(done.canonicalProvider, "chatgpt");
  const body = app.reviews[0].body;
  assert.ok(!isConvergedFindings(body), "never a clean pass");
  assert.match(body, /codex returned no usable review, so this is not a clean pass/);
});

test("verify-clean, ChatGPT + Codex + local: Codex HTTP 500 beside a clean ChatGPT runs the verification round, then posts incomplete", async (t) => {
  const app = await verifyCleanApp(t);
  const out = await app.mention("mixed-500");
  await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
  await codexSent(app);
  app.codexResponses[0].writeHead(500, { "content-type": "text/plain" });
  app.codexResponses[0].end("upstream exploded");
  await eventually(() => job(app, out.jobId)?.providerErrors?.codex, "Codex failed");
  assert.equal((await chatgpt(app, out.jobId, clean)).ok, true);
  await eventually(() => app.localRequests.length === 1, "local verifies ChatGPT's clean verdict");
  assert.ok(job(app, out.jobId).localVerifyStartedAt);
  localReply(app.localResponses[0], clean);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.deepEqual([...done.skippedProviders], ["codex"]);
  assert.ok(!isConvergedFindings(app.reviews[0].body));
  assert.match(app.reviews[0].body, /ashlar-outcome incomplete/);
});

test("verify-clean, local + Codex: a Codex request past its timeout releases local as the fallback", async (t) => {
  const app = await localCodexApp(t);
  app.env.ASHLAR_CODEX_TIMEOUT_MS = "600";
  const id = await localCodexJob(app, "lc-timeout");
  // The proxy never answers: the request's hard ceiling ends it.
  await eventually(() => app.localRequests.length === 1, "local runs as the fallback");
  assert.ok(job(app, id).localFallbackAt, "released as the fallback");
  assert.equal(job(app, id).providerErrors.codex.code, "error");
  localReply(app.localResponses[0], dirty);
  await ended(app, id);
  const done = job(app, id);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.match(app.reviews[0].body, /ashlar-findings total=1 /);
});

for (const chatEnds of ["clean", "quota"]) {
  test(`verify-clean, ChatGPT + Codex + local: Codex at its usage limit while ChatGPT still runs never hangs; ChatGPT ${chatEnds} then ${chatEnds === "clean" ? "is verified by local" : "releases the fallback"}`, async (t) => {
    const app = await verifyCleanApp(t);
    const out = await app.mention(`mixed-quota-${chatEnds}`);
    await eventually(() => job(app, out.jobId)?.status === "awaiting_chat", "snapshot ready");
    await codexSent(app);
    quota(app.codexResponses[0], { error: { type: "usage_limit_reached", resets_in_seconds: 3600 } });
    await eventually(() => !(job(app, out.jobId)?.reviewProviders ?? []).includes("codex"), "Codex leaves the job");
    assert.deepEqual([...job(app, out.jobId).reviewProviders], ["chatgpt", "local"]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(app.localRequests.length, 0, "local waits for ChatGPT, still a racing primary");
    assert.equal(job(app, out.jobId).localFallbackAt, undefined);
    if (chatEnds === "clean") assert.equal((await chatgpt(app, out.jobId, clean)).ok, true);
    else chatgptQuota(app, out.jobId);
    await eventually(() => app.localRequests.length === 1, "local runs");
    const released = job(app, out.jobId);
    if (chatEnds === "clean") assert.ok(released.localVerifyStartedAt, "verification round");
    else assert.ok(released.localFallbackAt, "fallback");
    localReply(app.localResponses[0], clean);
    await ended(app, out.jobId);
    const done = job(app, out.jobId);
    assert.equal(done.status, "posted", done.githubError || done.plan);
    if (chatEnds === "clean") {
      assert.equal(done.localVerified, true);
      assert.ok(isConvergedFindings(app.reviews[0].body), "a Codex usage limit beside another primary never blocks convergence");
    } else {
      assert.ok(!isConvergedFindings(app.reviews[0].body), "chat skipped: incomplete");
    }
  });
}

test("turning Codex off in Settings aborts its running leg; the job finishes with the others (clean stays clean)", async (t) => {
  const app = await codexApp(t);
  const out = await app.mention("codex-off");
  await codexSent(app);
  app.harbor.patchHarborSettings({ reviewCodex: false });
  await eventually(
    () => app.codexResponses[0].req.destroyed || app.codexResponses[0].destroyed,
    "the Codex request was aborted",
  );
  assert.deepEqual([...job(app, out.jobId).reviewProviders], ["chatgpt"]);
  await chatgpt(app, out.jobId, clean);
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "posted", done.githubError || done.plan);
  assert.ok(isConvergedFindings(app.reviews[0].body), "clean converges");
  assert.deepEqual([...(done.skippedProviders ?? [])], []);
  assert.equal(app.codexRequests.length, 1);
});

test("turning Codex off ends a Codex-only job as a failed attempt, never a clean review", async (t) => {
  const app = await codexApp(t, { reviewChatgpt: false });
  const out = await app.mention("codex-only-off");
  await codexSent(app);
  app.harbor.patchHarborSettings({ reviewCodex: false, reviewChatgpt: true });
  await eventually(
    () => app.codexResponses[0].req.destroyed || app.codexResponses[0].destroyed,
    "the Codex request was aborted",
  );
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, "skipped");
  assert.equal(done.noReviewAttempt, true);
  assert.equal(app.reviews.length, 0);
  await eventually(
    () => app.ops.some((b) => b.includes(out.jobId) && /ashlar-attempt failed/.test(b)),
    "a failed attempt",
  );
});
