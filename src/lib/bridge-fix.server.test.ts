import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFixRegistry,
  DEFAULT_FIX_MAX_PROMPT_CHARS,
  DEFAULT_FIX_TIMEOUT_MS,
  FIX_TERMINAL_RETAIN_MS,
  isFixItemId,
  type FixItem,
  type FixOffer,
  type FixOfferKind,
  type FixRegistryDeps,
  type FixRequest,
} from "./bridge-fix.server.ts";

const CLAIM_MS = 20 * 60_000;
const SUBMIT_MS = 3 * 60_000;
const REQ: FixRequest = { owner: "o", repo: "r", pr: 7, provider: "chatgpt", prompt: "FIX PROMPT with file contents" };

type FakeTimer = { fn: () => void; ms: number; cleared: boolean };

/** Registry over a fake clock and fake timers: nothing here waits in real time. */
function harness(over: Partial<FixRegistryDeps> = {}) {
  let now = 1_700_000_000_000;
  let seq = 0;
  let limit = 3;
  const timers: FakeTimer[] = [];
  const reg = createFixRegistry({
    now: () => now,
    newId: () => `id${++seq}`,
    parallelLimit: () => limit,
    reasoning: () => ({ chatgpt: "pro", grok: "heavy" }),
    timeoutMs: () => DEFAULT_FIX_TIMEOUT_MS,
    maxPromptChars: () => DEFAULT_FIX_MAX_PROMPT_CHARS,
    claimMs: CLAIM_MS,
    submitWindowMs: SUBMIT_MS,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as FakeTimer).cleared = true;
    },
    ...over,
  });
  return {
    reg,
    timers,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setLimit: (n: number) => {
      limit = n;
    },
  };
}

/** Queue a request and take it for a Chrome profile: [promise, offer]. */
function queueAndTake(h: ReturnType<typeof harness>, req: Partial<FixRequest> = {}, clientId = "chrome-1") {
  const promise = h.reg.request({ ...REQ, ...req });
  const next = h.reg.peek();
  assert.ok(next, "the new request is offered");
  const offer = h.reg.take(next.id, clientId);
  assert.ok(offer, "the queued request can be taken");
  return { promise, offer };
}

describe("bridge fix registry: lifecycle", () => {
  it("enqueue → offered by take → claim → complete resolves with the answer text", async () => {
    const h = harness();
    const promise = h.reg.request(REQ);
    const next = h.reg.peek();
    assert.ok(next && isFixItemId(next.id));
    assert.deepEqual(h.reg.state(next.id), { active: true, status: "awaiting_chat" });
    const offer = h.reg.take(next.id, "chrome-1");
    assert.deepEqual(offer, {
      kind: "fix",
      jobId: next.id,
      offerKind: "fresh",
      deliveryId: offer?.deliveryId,
      provider: "chatgpt",
      providers: ["chatgpt"],
      resumeProviders: [],
      leaseId: offer?.leaseId,
      prompt: REQ.prompt,
      reasoning: { chatgpt: "pro", grok: "heavy" },
      title: "fix o/r#7",
      owner: "o",
      repo: "r",
      pr: 7,
    });
    const answer = 'Here you go.\n{"summary":"s","files":[]}';
    assert.deepEqual(h.reg.complete(next.id, "chatgpt", answer, offer!.leaseId), { ok: true });
    assert.equal(await promise, answer);
    assert.deepEqual(h.reg.state(next.id), { active: false, status: "posted" });
    // Settlement drops the prompt (file contents) and disarms the deadline.
    assert.equal(h.reg.snapshot(next.id)?.prompt, "");
    assert.equal(h.reg.prompt(next.id), null);
    assert.equal(h.timers[0].cleared, true);
    assert.equal(h.reg.peek(), undefined);
  });

  it("an explicit failure rejects with the provider's reason (idempotent on replay)", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.equal(h.reg.fail(offer.jobId, "chatgpt", "quota:\n usage limit — waiting for reset", offer.leaseId), true);
    await assert.rejects(promise, /chatgpt fix request failed: quota: usage limit — waiting for reset/);
    assert.deepEqual(h.reg.state(offer.jobId), { active: false, status: "dlq" });
    assert.equal(h.reg.fail(offer.jobId, "chatgpt", "again", offer.leaseId), true);
    assert.equal(h.reg.complete(offer.jobId, "chatgpt", "late", offer.leaseId).ok, false);
  });

  it("release voids the lease and frees the slot, but the item stays with its profile and resumes", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.equal(h.reg.progress(offer.jobId, offer.leaseId, "generating", "run-A"), true);
    assert.equal(h.reg.release(offer.jobId, "not-the-lease"), false);
    assert.equal(h.reg.release(offer.jobId, offer.leaseId), true);
    assert.deepEqual(h.reg.state(offer.jobId), { active: true, status: "awaiting_chat" });
    assert.equal(h.reg.counts().active, 0, "the parallelPrs slot is free");
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "stale", offer.leaseId), {
      ok: false,
      code: "lease_conflict",
      error: "fix item is not claimed by this worker",
    });
    // Like a review job (bridgeClientId + attemptedProviders): never a replacement generation
    // from another profile.
    assert.equal(h.reg.peek([], "chrome-2"), undefined);
    assert.equal(h.reg.take(offer.jobId, "chrome-2"), null);
    assert.equal(h.reg.claim(offer.jobId, "chrome-2").ok, false);
    const again = h.reg.take(offer.jobId, "chrome-1");
    assert.ok(again && again.leaseId !== offer.leaseId);
    assert.deepEqual(again.resumeProviders, ["chatgpt"], "a resume, never a fresh submission");
    assert.deepEqual(again.bindings, [{ jobId: offer.jobId, provider: "chatgpt", runId: "run-A" }]);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "answer", again.leaseId), { ok: true });
    assert.equal(await promise, "answer");
  });

  // Ashlar 4096068024: resume semantics exist only once a run is established.
  it("release before any run: the owner's next take is a fresh submission (no resume, no bindings); another profile still cannot take it", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.equal(h.reg.release(offer.jobId, offer.leaseId), true);
    assert.equal(h.reg.take(offer.jobId, "chrome-2"), null, "the item stays with its profile");
    const again = h.reg.take(offer.jobId, "chrome-1");
    assert.ok(again && again.leaseId !== offer.leaseId);
    assert.deepEqual(again.resumeProviders, [], "a fresh submission");
    assert.equal("bindings" in again, false);
    assert.equal(again.prompt, REQ.prompt);
    assert.equal(h.reg.submitting("chrome-1"), true, "its submission window starts at this take");
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "answer", again.leaseId), { ok: true });
    assert.equal(await promise, "answer");
  });

  it("release after a run was established: the owner's next take resumes that run through its binding", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.equal(h.reg.progress(offer.jobId, offer.leaseId, "generating", "run-A"), true);
    assert.equal(h.reg.release(offer.jobId, offer.leaseId), true);
    const again = h.reg.take(offer.jobId, "chrome-1");
    assert.deepEqual(again?.resumeProviders, ["chatgpt"]);
    assert.deepEqual(again?.bindings, [{ jobId: offer.jobId, provider: "chatgpt", runId: "run-A" }]);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "answer", again!.leaseId), { ok: true });
    assert.equal(await promise, "answer");
  });

  it("a done item acknowledges a lost-ACK replay only of the same answer (as a review's identical leg)", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.equal(h.reg.complete(offer.jobId, "chatgpt", "answer", offer.leaseId).ok, true);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "answer", offer.leaseId), { ok: true });
    assert.equal(h.reg.complete(offer.jobId, "chatgpt", "another answer", offer.leaseId).ok, false, "a different text is not a replay");
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "answer", "other-lease"), { ok: true }, "the payload identifies a replay");
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "other", "other-lease"), {
      ok: false,
      code: "lease_conflict",
      error: "fix item already completed",
    });
    assert.equal(await promise, "answer");
  });

  it("complete rejects a provider mismatch and an empty answer without settling", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.equal(h.reg.complete(offer.jobId, "grok", "answer", offer.leaseId).ok, false);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "  \n ", offer.leaseId), { ok: false, code: "invalid", error: "empty fix answer" });
    assert.deepEqual(h.reg.state(offer.jobId), { active: true, status: "awaiting_chat" });
    assert.equal(h.reg.complete(offer.jobId, undefined, "answer", offer.leaseId).ok, true);
    assert.equal(await promise, "answer");
  });
});

describe("bridge fix registry: deadline and supersession", () => {
  it("the deadline rejects 'timeout', reports cancelled and stops offering the item", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.equal(h.timers[0].ms, DEFAULT_FIX_TIMEOUT_MS);
    assert.equal(h.reg.progress(offer.jobId, offer.leaseId, "generating"), true);
    h.timers[0].fn();
    await assert.rejects(promise, /o\/r#7 timed out after 30 min \(last stage: generating\)/);
    assert.deepEqual(h.reg.state(offer.jobId), { active: false, status: "cancelled" });
    assert.equal(h.reg.peek(), undefined);
    assert.equal(h.reg.prompt(offer.jobId), null);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "late answer", offer.leaseId), {
      ok: false,
      code: "lease_conflict",
      error: "fix item was cancelled (timeout)",
    });
  });

  it("a late timer is backed by a lazy deadline check; a never-claimed item says so", async () => {
    const h = harness();
    const promise = h.reg.request(REQ);
    const id = h.reg.peek()!.id;
    h.advance(DEFAULT_FIX_TIMEOUT_MS);
    assert.deepEqual(h.reg.state(id), { active: false, status: "cancelled" });
    await assert.rejects(promise, /never picked up by the Chrome bridge/);
  });

  it("a per-request deadline is clamped like the env value", async () => {
    const h = harness();
    const promise = h.reg.request({ ...REQ, timeoutMs: 5 });
    assert.equal(h.timers[0].ms, 60_000);
    h.timers[0].fn();
    await assert.rejects(promise, /timed out after 1 min/);
  });

  it("a second request for the same PR supersedes the first (which rejects 'superseded')", async () => {
    const h = harness();
    const first = queueAndTake(h);
    const other = h.reg.request({ ...REQ, pr: 8, prompt: "another PR" });
    const second = h.reg.request({ ...REQ, owner: "O", repo: "R", prompt: "newer prompt" });
    await assert.rejects(first.promise, /fix request for o\/r#7 superseded by a newer request for the same PR/);
    assert.deepEqual(h.reg.state(first.offer.jobId), { active: false, status: "cancelled" });
    assert.equal(h.timers[0].cleared, true);
    // The newer item is the one offered; another PR's item is untouched.
    const offered = [h.reg.peek()!.id];
    h.reg.take(offered[0], "chrome-1");
    offered.push(h.reg.peek()!.id);
    assert.deepEqual(
      offered.map((id) => h.reg.snapshot(id)?.pr),
      [8, 7],
    );
    assert.equal(h.reg.snapshot(offered[1])?.prompt, "newer prompt");
    void other.catch(() => {});
    void second.catch(() => {});
  });
});

describe("bridge fix registry: the caller's abort", () => {
  it("an abort cancels a claimed item ('aborted'): rejects, reports cancelled, voids the lease", async () => {
    const h = harness();
    const ac = new AbortController();
    const { promise, offer } = queueAndTake(h, { signal: ac.signal });
    ac.abort();
    await assert.rejects(promise, /fix request for o\/r#7 was cancelled by the review loop/);
    assert.deepEqual(h.reg.state(offer.jobId), { active: false, status: "cancelled" });
    assert.equal(h.timers[0].cleared, true);
    assert.equal(h.reg.prompt(offer.jobId), null);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "late answer", offer.leaseId), {
      ok: false,
      code: "lease_conflict",
      error: "fix item was cancelled (aborted)",
    });
  });

  it("an already-aborted signal rejects up front and never queues", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(h.reg.request({ ...REQ, signal: ac.signal }), /cancelled before it was queued/);
    assert.equal(h.reg.peek(), undefined);
    assert.equal(h.timers.length, 0);
  });

  it("an abort after the item settled is a no-op", async () => {
    const h = harness();
    const ac = new AbortController();
    const { promise, offer } = queueAndTake(h, { signal: ac.signal });
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "ANSWER", offer.leaseId), { ok: true });
    assert.equal(await promise, "ANSWER");
    ac.abort();
    assert.deepEqual(h.reg.state(offer.jobId), { active: false, status: "posted" });
  });
});

describe("bridge fix registry: parallelPrs and ownership", () => {
  it("at most parallelPrs items are claimed at once; the rest wait queued", async () => {
    const h = harness();
    h.setLimit(1);
    const a = queueAndTake(h, { pr: 1 });
    const b = h.reg.request({ ...REQ, pr: 2 });
    assert.equal(h.reg.peek(), undefined, "the cap holds B queued");
    assert.deepEqual(h.reg.counts(), { queued: 1, claimed: 1, active: 1 });
    h.setLimit(2); // only to learn B's id
    const bNext = h.reg.peek();
    assert.ok(bNext);
    h.setLimit(1);
    // A direct claim cannot bypass the cap either.
    assert.deepEqual(h.reg.claim(bNext.id, "chrome-1"), { ok: false, error: "fix parallel limit reached (fixAgent.parallelPrs)" });
    assert.equal(h.reg.complete(a.offer.jobId, "chatgpt", "A done", a.offer.leaseId).ok, true);
    assert.equal(await a.promise, "A done");
    assert.equal(h.reg.peek()?.id, bNext.id, "a finished claim frees the slot");
    void b.catch(() => {});
  });

  it("a stale claim (dead profile) frees its parallelPrs slot for another PR's fix", async () => {
    const h = harness();
    h.setLimit(1);
    const a = queueAndTake(h, { pr: 1 }, "chrome-1"); // chrome-1 then dies: no heartbeat
    const b = h.reg.request({ ...REQ, pr: 2 });
    assert.equal(h.reg.peek(), undefined, "a live claim holds the only slot");
    h.advance(CLAIM_MS + 1);
    const next = h.reg.peek();
    assert.ok(next, "the stale claim no longer counts against the cap");
    assert.ok(h.reg.take(next.id, "chrome-2"), "another profile takes PR 2's fix");
    assert.deepEqual(h.reg.counts(), { queued: 0, claimed: 2, active: 1 }, "A's request is still pending (live), but holds no slot");
    assert.deepEqual(h.reg.state(a.offer.jobId), { active: true, status: "awaiting_chat" });
    void a.promise.catch(() => {});
    void b.catch(() => {});
  });

  it("a claim whose take response was lost is offered again to its own profile only, under the same lease", async () => {
    const h = harness();
    h.setLimit(1);
    const promise = h.reg.request({ ...REQ, pr: 1 });
    const first = h.reg.peek([], "chrome-1");
    assert.ok(first);
    const lost = h.reg.take(first.id, "chrome-1"); // claimed; the response never reaches the worker
    assert.ok(lost);
    // the worker still does not list it: replayed (not a second claim), the same lease
    assert.equal(h.reg.peek([], "chrome-1")?.id, first.id);
    const replay = h.reg.take(first.id, "chrome-1");
    assert.equal(replay?.leaseId, lost.leaseId);
    assert.equal(replay?.prompt, REQ.prompt);
    assert.deepEqual(h.reg.counts(), { queued: 0, claimed: 1, active: 1 });
    // another profile never gets it, and a worker that lists it is not offered it again
    assert.equal(h.reg.peek([], "chrome-2"), undefined);
    assert.equal(h.reg.take(first.id, "chrome-2"), null);
    assert.equal(h.reg.peek([first.id], "chrome-1"), undefined);
    assert.equal(h.reg.complete(first.id, "chatgpt", "ANSWER", lost.leaseId).ok, true);
    assert.equal(await promise, "ANSWER");
  });

  it("every take is a fresh submission: a stale replay re-opens the profile's submission window", async () => {
    const h = harness();
    h.setLimit(1);
    const promise = h.reg.request({ ...REQ, pr: 1 });
    const first = h.reg.peek([], "chrome-1");
    assert.ok(first && h.reg.take(first.id, "chrome-1")); // the take response is lost
    h.advance(CLAIM_MS + 1); // the profile is away past claimMs (the window has long passed)
    assert.equal(h.reg.submitting("chrome-1", [first.id]), false);
    const replay = h.reg.take(first.id, "chrome-1");
    assert.ok(replay, "its own profile gets it again");
    assert.equal(h.reg.submitting("chrome-1", [first.id]), true, "the replayed prompt holds the foreground like a new one");
    h.reg.refresh(first.id, replay.leaseId, { chatgpt: true });
    assert.equal(h.reg.submitting("chrome-1", [first.id]), false);
    void promise.catch(() => {});
  });

  it("a completion after the deadline loses even when the deadline timer has not fired yet", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h, { pr: 1 }, "chrome-1");
    h.advance(DEFAULT_FIX_TIMEOUT_MS); // the timer is late: nothing fired it
    assert.equal(h.timers[0].cleared, false);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "late answer", offer.leaseId), {
      ok: false,
      code: "lease_conflict",
      error: "fix item was cancelled (timeout)",
    });
    await assert.rejects(promise, /timed out after 30 min/);
    assert.deepEqual(h.reg.state(offer.jobId), { active: false, status: "cancelled" });
    // every other lease operation sees the same expiry
    assert.equal(h.reg.refresh(offer.jobId, offer.leaseId, { chatgpt: true }), false);
    assert.equal(h.reg.progress(offer.jobId, offer.leaseId, "generating", "run-A"), false);
    assert.equal(h.reg.claim(offer.jobId, "chrome-1").ok, false);
    assert.equal(h.reg.prompt(offer.jobId), null);
  });

  it("each lease operation enforces the deadline itself (fail, refresh, recover)", async () => {
    for (const op of ["fail", "refresh", "recover"] as const) {
      const h = harness();
      const { promise, offer } = queueAndTake(h, { pr: 1 }, "chrome-1");
      h.reg.progress(offer.jobId, offer.leaseId, "generating", "run-A");
      h.advance(DEFAULT_FIX_TIMEOUT_MS + 1);
      if (op === "fail") assert.equal(h.reg.fail(offer.jobId, "chatgpt", "error", offer.leaseId), true, "nothing left to fail");
      if (op === "refresh") assert.equal(h.reg.refresh(offer.jobId, offer.leaseId), false);
      if (op === "recover") assert.equal(h.reg.recover(offer.jobId, "chrome-1", "chatgpt", "run-A"), null);
      await assert.rejects(promise, /timed out/, `${op}: the request settles as a timeout, not a failure`);
    }
  });

  it("a surviving tab binding whose first progress report was lost pins its run and resumes", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h, { pr: 1 }, "chrome-1");
    // run-A reached a tab, but no progress report ever pinned it; the worker then lost its job
    assert.equal(h.reg.recover(offer.jobId, "chrome-2", "chatgpt", "run-A"), null, "not another profile");
    assert.equal(h.reg.recover(offer.jobId, "chrome-1", "grok", "run-A"), null, "not another provider");
    const resumed = h.reg.recover(offer.jobId, "chrome-1", "chatgpt", "run-A");
    assert.ok(resumed);
    assert.deepEqual(resumed.resumeProviders, ["chatgpt"]);
    assert.deepEqual(resumed.bindings, [{ jobId: offer.jobId, provider: "chatgpt", runId: "run-A" }]);
    assert.equal(h.reg.snapshot(offer.jobId)?.runId, "run-A", "the run is pinned");
    // a later take (the worker lists nothing) never offers it as a fresh submission
    assert.equal(h.reg.peek([], "chrome-1"), undefined);
    assert.equal(h.reg.take(offer.jobId, "chrome-1"), null);
    assert.equal(h.reg.recover(offer.jobId, "chrome-1", "chatgpt", "run-B"), null, "one run per claim");
    assert.equal(h.reg.progress(offer.jobId, resumed.leaseId, "x", "run-B"), false);
    assert.deepEqual(h.reg.complete(offer.jobId, "chatgpt", "answer", resumed.leaseId), { ok: true });
    assert.equal(await promise, "answer");
  });

  it("a claim with a started run is resumed only through its tab binding, never re-submitted", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h, { pr: 1 }, "chrome-1");
    assert.equal(h.reg.progress(offer.jobId, offer.leaseId, "prompt_prepared", "run-A"), true);
    assert.equal(h.reg.progress(offer.jobId, offer.leaseId, "x", "run-B"), false, "one run per claim");
    // the worker lost its local job: take never offers the running fix again (no second tab/prompt)
    assert.equal(h.reg.peek([], "chrome-1"), undefined);
    assert.equal(h.reg.take(offer.jobId, "chrome-1"), null);
    // wrong profile, provider or run: nothing
    assert.equal(h.reg.recover(offer.jobId, "chrome-2", "chatgpt", "run-A"), null);
    assert.equal(h.reg.recover(offer.jobId, "chrome-1", "grok", "run-A"), null);
    assert.equal(h.reg.recover(offer.jobId, "chrome-1", "chatgpt", "run-B"), null);
    h.advance(SUBMIT_MS + 1);
    const resumed = h.reg.recover(offer.jobId, "chrome-1", "chatgpt", "run-A");
    assert.ok(resumed);
    assert.deepEqual(resumed.resumeProviders, ["chatgpt"]);
    assert.deepEqual(resumed.bindings, [{ jobId: offer.jobId, provider: "chatgpt", runId: "run-A" }]);
    assert.equal(h.reg.submitting("chrome-1", [offer.jobId]), false, "a resume sends nothing: no submission window");
    assert.equal(h.reg.complete(offer.jobId, "chatgpt", "ANSWER", resumed.leaseId).ok, true);
    assert.equal(await promise, "ANSWER");
  });

  it("a stale claim cannot come back above parallelPrs once its slot was reassigned", async () => {
    const h = harness();
    h.setLimit(1);
    const a = queueAndTake(h, { pr: 1 }, "chrome-1");
    const b = h.reg.request({ ...REQ, pr: 2 });
    h.advance(CLAIM_MS + 1);
    const bNext = h.reg.peek([], "chrome-2");
    assert.ok(bNext && h.reg.take(bNext.id, "chrome-2"), "B takes the freed slot");
    assert.equal(h.reg.refresh(a.offer.jobId, a.offer.leaseId, { chatgpt: true }), false, "A's heartbeat cannot revive it");
    assert.deepEqual(h.reg.claim(a.offer.jobId, "chrome-1"), { ok: false, error: "fix parallel limit reached (fixAgent.parallelPrs)" });
    assert.deepEqual(h.reg.counts(), { queued: 0, claimed: 2, active: 1 });
    void a.promise.catch(() => {});
    void b.catch(() => {});
  });

  it("only the claiming profile may re-claim; a stale lease is renewed, the old one voided", () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    assert.deepEqual(h.reg.claim(offer.jobId, "chrome-2"), { ok: false, error: "fix generation belongs to another Chrome profile" });
    assert.deepEqual(h.reg.claim(offer.jobId, "chrome-1"), { ok: true, leaseId: offer.leaseId });
    h.advance(CLAIM_MS + 1);
    const renewed = h.reg.claim(offer.jobId, "chrome-1");
    assert.ok(renewed.ok && renewed.leaseId !== offer.leaseId);
    assert.equal(h.reg.refresh(offer.jobId, offer.leaseId, { chatgpt: true }), false);
    assert.equal(h.reg.refresh(offer.jobId, renewed.ok ? renewed.leaseId : "", { chatgpt: true }), true);
    assert.equal(h.reg.fail(offer.jobId, "chatgpt", "x", offer.leaseId), false);
    void promise.catch(() => {});
  });

  it("the submission window holds the profile until generation starts or the window passes", () => {
    const h = harness();
    const a = queueAndTake(h, { pr: 1 });
    assert.equal(h.reg.submitting("chrome-1"), true);
    assert.equal(h.reg.submitting("chrome-2"), false);
    assert.equal(h.reg.submitting(""), false);
    h.reg.refresh(a.offer.jobId, a.offer.leaseId, { grok: true });
    assert.equal(h.reg.submitting("chrome-1"), true, "another provider's flag says nothing about this item");
    h.reg.refresh(a.offer.jobId, a.offer.leaseId, { chatgpt: true });
    assert.equal(h.reg.submitting("chrome-1"), false);
    const b = queueAndTake(h, { pr: 2 });
    assert.equal(h.reg.submitting("chrome-1"), true);
    h.advance(SUBMIT_MS);
    assert.equal(h.reg.submitting("chrome-1"), false, "a stuck submission stops blocking after the window");
    void a.promise.catch(() => {});
    void b.promise.catch(() => {});
  });

  it("an unknown fix id reports cancelled and every late call is safe", () => {
    const h = harness();
    assert.deepEqual(h.reg.state("fix-unknown"), { active: false, status: "cancelled" });
    assert.deepEqual(h.reg.complete("fix-unknown", "chatgpt", "answer", "lease"), {
      ok: false,
      code: "lease_conflict",
      error: "fix item is unknown or expired",
    });
    assert.equal(h.reg.fail("fix-unknown", "chatgpt", "x", "lease"), true);
    assert.equal(h.reg.prompt("fix-unknown"), null);
    assert.equal(h.reg.claim("fix-unknown", "chrome-1").ok, false);
    assert.equal(h.reg.refresh("fix-unknown", "lease"), false);
    assert.equal(h.reg.release("fix-unknown", "lease"), false);
  });

  it("a burst of settled items is bounded (oldest forgotten first); a live item is never evicted", async () => {
    const h = harness();
    h.setLimit(1000);
    const live = queueAndTake(h, { pr: 100_000 }); // claimed before the burst, stays live
    const liveId = live.offer.jobId;
    const ids: string[] = [];
    for (let pr = 1; pr <= 205; pr++) {
      const { promise, offer } = queueAndTake(h, { pr });
      assert.equal(h.reg.complete(offer.jobId, "chatgpt", `answer ${pr}`, offer.leaseId).ok, true);
      assert.equal(await promise, `answer ${pr}`);
      ids.push(offer.jobId);
    }
    h.reg.counts(); // prune
    const status = ids.map((id) => h.reg.state(id).status);
    assert.deepEqual(status.slice(0, 5), Array(5).fill("cancelled"), "the 5 oldest settled snapshots are forgotten");
    assert.deepEqual(status.slice(5), Array(200).fill("posted"), "the newest 200 are kept");
    assert.deepEqual(h.reg.state(liveId), { active: true, status: "awaiting_chat" });
    void live.promise.catch(() => {});
  });

  it("over the cap, the items that SETTLED first are forgotten, not the ones created first", async () => {
    const h = harness();
    h.setLimit(1000);
    const first = queueAndTake(h, { pr: 100_000 }); // created first, stays live through the burst
    const ids: string[] = [];
    for (let pr = 1; pr <= 200; pr++) {
      h.advance(1);
      const { promise, offer } = queueAndTake(h, { pr });
      assert.equal(h.reg.complete(offer.jobId, "chatgpt", `answer ${pr}`, offer.leaseId).ok, true);
      await promise;
      ids.push(offer.jobId);
    }
    h.advance(1);
    assert.equal(h.reg.complete(first.offer.jobId, "chatgpt", "LATE", first.offer.leaseId).ok, true); // settles last
    assert.equal(await first.promise, "LATE");
    h.reg.counts(); // prune: 201 settled
    assert.deepEqual(h.reg.state(first.offer.jobId), { active: false, status: "posted" }, "the newest settlement is kept");
    assert.deepEqual(h.reg.complete(first.offer.jobId, "chatgpt", "LATE", first.offer.leaseId), { ok: true }, "its lost-ACK replay is acknowledged");
    assert.equal(h.reg.state(ids[0]).status, "cancelled", "the earliest settled item is the one forgotten");
    assert.equal(h.reg.state(ids[1]).status, "posted");
  });

  it("settled items are forgotten after the retention window", async () => {
    const h = harness();
    const { promise, offer } = queueAndTake(h);
    h.reg.complete(offer.jobId, "chatgpt", "answer", offer.leaseId);
    await promise;
    assert.deepEqual(h.reg.state(offer.jobId), { active: false, status: "posted" });
    h.advance(FIX_TERMINAL_RETAIN_MS + 1);
    assert.deepEqual(h.reg.state(offer.jobId), { active: false, status: "cancelled" });
    assert.equal(h.reg.snapshot(offer.jobId), undefined);
  });
});

describe("bridge fix registry: request validation", () => {
  it("an oversized prompt fails fast with the limit, never queues and never echoes the prompt", async () => {
    const h = harness({ maxPromptChars: () => 20_000 });
    const prompt = `SECRET-FILE-CONTENT ${"x".repeat(20_000)}`;
    await assert.rejects(h.reg.request({ ...REQ, prompt }), (error: Error) => {
      assert.match(error.message, new RegExp(`fix prompt is ${prompt.length} chars`));
      assert.match(error.message, /at most 20000 \(Settings → Fix agent \/ review loop → fix_agent\.chat_max_prompt_chars\)/);
      assert.doesNotMatch(error.message, /SECRET-FILE-CONTENT/);
      return true;
    });
    assert.deepEqual(h.reg.counts(), { queued: 0, claimed: 0, active: 0 });
    assert.equal(h.timers.length, 0);
  });

  it("a non-bridge provider, a missing PR or an empty prompt is rejected up front", async () => {
    const h = harness();
    await assert.rejects(h.reg.request({ ...REQ, provider: "local" as never }), /not a Chrome bridge provider/);
    await assert.rejects(h.reg.request({ ...REQ, pr: 0 }), /needs owner, repo and a PR number/);
    await assert.rejects(h.reg.request({ ...REQ, repo: "" }), /needs owner, repo and a PR number/);
    await assert.rejects(h.reg.request({ ...REQ, prompt: "  " }), /empty fix prompt/);
    assert.deepEqual(h.reg.counts(), { queued: 0, claimed: 0, active: 0 });
  });

  it("fix ids are recognized by their prefix only", () => {
    assert.equal(isFixItemId("fix-abc"), true);
    assert.equal(isFixItemId("fix-"), false);
    assert.equal(isFixItemId("job-abc"), false);
    assert.equal(isFixItemId(42), false);
  });
});

// ── The LIFECYCLE table (bridge-fix.server.ts header): one row per transition T1-T16 plus a row
// per review finding (F-*). Each row starts from a named state, applies one operation and checks
// the resulting state, the offer's classification and every piece of bookkeeping that transition
// may (or must not) write. `kept` = unchanged from the starting state.
type From = "Q0" | "QU" | "QP" | "CU" | "CP";
type Named = From | "DONE" | "FAILED" | "CANCELLED";
interface Ctx {
  h: ReturnType<typeof harness>;
  id: string;
  leaseId?: string;
  promise: Promise<string>;
  before: FixItem;
}
interface Want {
  to: Named;
  offer?: FixOfferKind | null; // null = the operation hands out nothing
  lease?: "same" | "new" | "none";
  submitAt?: "now" | "unset" | "kept";
  generating?: boolean | "kept";
  submitting?: boolean; // submitting("chrome-1", [id]) right after the operation
  /** Another eligible item of the same profile is taken at once (nothing holds the foreground). */
  nextTakeable?: boolean;
  reason?: string;
  /** The delivery nonce: minted (new), repeated (same) or none yet. */
  delivery?: "new" | "same" | "none";
}
interface Row {
  t: string;
  from: From;
  generating?: boolean; // the run reported generation before the starting state was reached
  op: (c: Ctx) => unknown;
  want: Want;
}

function named(item: FixItem | undefined): Named | undefined {
  if (!item) return undefined;
  if (item.state === "done") return "DONE";
  if (item.state === "failed") return "FAILED";
  if (item.state === "cancelled") return "CANCELLED";
  if (item.state === "claimed") return item.runId ? "CP" : "CU";
  return !item.clientId ? "Q0" : item.runId ? "QP" : "QU";
}

/** Reach `from` for profile chrome-1 (runs are "run-A"), then move the clock on so a transition's
 * "now" differs from every timestamp written while getting there. */
function reach(from: From, generating = false): Ctx {
  const h = harness();
  const promise = h.reg.request(REQ);
  promise.catch(() => {});
  const id = h.reg.peek()!.id;
  let leaseId: string | undefined;
  if (from !== "Q0") {
    leaseId = h.reg.take(id, "chrome-1")!.leaseId;
    if (from === "CP" || from === "QP") assert.equal(h.reg.progress(id, leaseId, "generating", "run-A"), true);
    if (generating) assert.equal(h.reg.refresh(id, leaseId, { chatgpt: true }), true);
    if (from === "QU" || from === "QP") {
      assert.equal(h.reg.release(id, leaseId), true);
      leaseId = undefined;
    }
  }
  h.advance(1_000);
  assert.equal(named(h.reg.snapshot(id)), from, "setup reached the starting state");
  return { h, id, leaseId, promise, before: h.reg.snapshot(id)! };
}

const LIFECYCLE: Row[] = [
  { t: "T1 request queues an unowned item", from: "Q0", op: () => undefined, want: { delivery: "none", to: "Q0", lease: "none", submitAt: "unset" } },
  { t: "T1 a newer request for the PR supersedes the live item", from: "CU", op: (c) => void c.h.reg.request(REQ).catch(() => {}), want: { to: "CANCELLED", reason: "superseded" } },
  { t: "T2 take of Q0 is a fresh submission", from: "Q0", op: (c) => c.h.reg.take(c.id, "chrome-1"), want: { delivery: "new", to: "CU", offer: "fresh", lease: "new", submitAt: "now", generating: false, submitting: true, nextTakeable: false } },
  { t: "T2 claim of Q0 is a fresh submission", from: "Q0", op: (c) => c.h.reg.claim(c.id, "chrome-1"), want: { delivery: "new", to: "CU", lease: "new", submitAt: "now", generating: false, submitting: true } },
  { t: "T3 take of CU by its profile (lost take response) is a replay under the same lease", from: "CU", op: (c) => c.h.reg.take(c.id, "chrome-1"), want: { delivery: "same", to: "CU", offer: "replay", lease: "same", submitAt: "now", generating: "kept", submitting: true } },
  {
    t: "T3 a stale replay renews the lease",
    from: "CU",
    op: (c) => {
      c.h.advance(CLAIM_MS + 1);
      return c.h.reg.take(c.id, "chrome-1");
    },
    want: { delivery: "same", to: "CU", offer: "replay", lease: "new", submitAt: "now", submitting: true },
  },
  { t: "T4 progress pins the run", from: "CU", op: (c) => c.h.reg.progress(c.id, c.leaseId, "generating", "run-A"), want: { to: "CP", lease: "same", submitAt: "kept", generating: "kept" } },
  { t: "T5 recover of CU pins the page's run and resumes", from: "CU", op: (c) => c.h.reg.recover(c.id, "chrome-1", "chatgpt", "run-A"), want: { delivery: "same", to: "CP", offer: "resume", lease: "same", submitAt: "kept", generating: "kept" } },
  { t: "T6 recover of CP resumes (generating)", from: "CP", generating: true, op: (c) => c.h.reg.recover(c.id, "chrome-1", "chatgpt", "run-A"), want: { delivery: "same", to: "CP", offer: "resume", lease: "same", submitAt: "kept", generating: true, submitting: false } },
  {
    t: "T6 recover of a stale CP renews the lease only",
    from: "CP",
    op: (c) => {
      c.h.advance(CLAIM_MS + 1);
      return c.h.reg.recover(c.id, "chrome-1", "chatgpt", "run-A");
    },
    want: { delivery: "same", to: "CP", offer: "resume", lease: "new", submitAt: "kept", generating: "kept" },
  },
  { t: "T7 refresh records generation", from: "CU", op: (c) => c.h.reg.refresh(c.id, c.leaseId, { chatgpt: true }), want: { to: "CU", lease: "same", submitAt: "kept", generating: true, submitting: false } },
  { t: "T8 claim of a live CU is a renewal (same lease), not a submission", from: "CU", op: (c) => c.h.reg.claim(c.id, "chrome-1"), want: { delivery: "same", to: "CU", lease: "same", submitAt: "kept", generating: "kept" } },
  {
    t: "T8 claim of a stale CP renews the lease only",
    from: "CP",
    generating: true,
    op: (c) => {
      c.h.advance(CLAIM_MS + 1);
      return c.h.reg.claim(c.id, "chrome-1");
    },
    want: { delivery: "same", to: "CP", lease: "new", submitAt: "kept", generating: true },
  },
  { t: "T9 release of CU keeps the owner", from: "CU", op: (c) => c.h.reg.release(c.id, c.leaseId), want: { to: "QU", lease: "none", submitAt: "unset", submitting: false } },
  { t: "T10 release of CP keeps owner, run and generation", from: "CP", generating: true, op: (c) => c.h.reg.release(c.id, c.leaseId), want: { to: "QP", lease: "none", submitAt: "unset", generating: true, submitting: false } },
  { t: "T11 take of QU is a fresh submission again", from: "QU", op: (c) => c.h.reg.take(c.id, "chrome-1"), want: { delivery: "new", to: "CU", offer: "fresh", lease: "new", submitAt: "now", generating: false, submitting: true } },
  { t: "T11 claim of QU is a fresh submission again", from: "QU", op: (c) => c.h.reg.claim(c.id, "chrome-1"), want: { delivery: "new", to: "CU", lease: "new", submitAt: "now", generating: false, submitting: true } },
  { t: "T12 take of QP resumes: lease only", from: "QP", generating: true, op: (c) => c.h.reg.take(c.id, "chrome-1"), want: { delivery: "same", to: "CP", offer: "resume", lease: "new", submitAt: "unset", generating: true, submitting: false } },
  { t: "T12 claim of QP resumes: lease only", from: "QP", generating: true, op: (c) => c.h.reg.claim(c.id, "chrome-1"), want: { delivery: "same", to: "CP", lease: "new", submitAt: "unset", generating: true, submitting: false } },
  { t: "T13 recover of QU pins the page's run and resumes", from: "QU", op: (c) => c.h.reg.recover(c.id, "chrome-1", "chatgpt", "run-A"), want: { delivery: "same", to: "CP", offer: "resume", lease: "new", submitAt: "unset", submitting: false } },
  { t: "T13 recover of QP resumes", from: "QP", generating: true, op: (c) => c.h.reg.recover(c.id, "chrome-1", "chatgpt", "run-A"), want: { delivery: "same", to: "CP", offer: "resume", lease: "new", submitAt: "unset", generating: true, submitting: false } },
  { t: "T14 complete settles done", from: "CP", op: (c) => c.h.reg.complete(c.id, "chatgpt", "ANSWER", c.leaseId), want: { to: "DONE", reason: "completed", generating: false } },
  { t: "T15 fail settles failed (the worker's terminal page verdicts arrive here)", from: "CU", op: (c) => c.h.reg.fail(c.id, "chatgpt", "taken_over: the user took over the fix tab", c.leaseId), want: { to: "FAILED", reason: "failure" } },
  {
    t: "T16 the deadline cancels a live item",
    from: "QP",
    op: (c) => {
      c.h.advance(DEFAULT_FIX_TIMEOUT_MS);
      return c.h.reg.state(c.id);
    },
    want: { to: "CANCELLED", reason: "timeout" },
  },
  // refusals: nothing moves
  { t: "refused: another profile cannot take QU", from: "QU", op: (c) => c.h.reg.take(c.id, "chrome-2"), want: { to: "QU", offer: null, lease: "none", submitAt: "unset" } },
  { t: "refused: another profile cannot recover CP", from: "CP", op: (c) => c.h.reg.recover(c.id, "chrome-2", "chatgpt", "run-A"), want: { to: "CP", offer: null, lease: "same", submitAt: "kept" } },
  { t: "refused: take never re-offers CP (only recover resumes a run)", from: "CP", op: (c) => c.h.reg.take(c.id, "chrome-1"), want: { to: "CP", offer: null, lease: "same", submitAt: "kept" } },
  { t: "refused: recover of another run", from: "QP", op: (c) => c.h.reg.recover(c.id, "chrome-1", "chatgpt", "run-B"), want: { to: "QP", offer: null, lease: "none", submitAt: "unset" } },
  // Findings (review round 11). F-P2 (4096523028): a resume is never a foreground submission, through
  // take AND recover: submitAt stays unset, the profile is not submitting, its next job is takeable.
  { t: "F-P2 take: a resumed pinned run holds no submission window", from: "QP", op: (c) => c.h.reg.take(c.id, "chrome-1"), want: { delivery: "same", to: "CP", offer: "resume", submitAt: "unset", generating: "kept", submitting: false, nextTakeable: true } },
  { t: "F-P2 recover: a resumed released run holds no submission window", from: "QU", op: (c) => c.h.reg.recover(c.id, "chrome-1", "chatgpt", "run-A"), want: { delivery: "same", to: "CP", offer: "resume", submitAt: "unset", generating: "kept", submitting: false, nextTakeable: true } },
  { t: "F-P2 claim: a lease renewal of a released run is not a submission", from: "QP", op: (c) => c.h.reg.claim(c.id, "chrome-1"), want: { delivery: "same", to: "CP", submitAt: "unset", generating: "kept", submitting: false, nextTakeable: true } },
];

describe("bridge fix registry: lifecycle table", () => {
  for (const row of LIFECYCLE) {
    it(`${row.t} (${row.from} → ${row.want.to})`, async () => {
      const c = reach(row.from, row.generating);
      const out = row.op(c) as FixOffer | null | undefined;
      const now = c.h.now();
      const after = c.h.reg.snapshot(c.id)!;
      const w = row.want;
      assert.equal(named(after), w.to, "resulting state");
      if (w.reason) assert.equal(after.reason, w.reason);
      if (w.delivery === "none") assert.equal(after.deliveryId, undefined);
      if (w.delivery === "same") assert.ok(after.deliveryId && after.deliveryId === c.before.deliveryId, "the same delivery");
      if (w.delivery === "new") assert.ok(after.deliveryId && after.deliveryId !== c.before.deliveryId, "a new delivery");
      if (w.offer !== undefined) {
        if (w.offer === null) assert.equal(out, null, "nothing is handed out");
        else {
          assert.equal(out?.offerKind, w.offer, "the offer's classification");
          assert.equal(out.leaseId, after.leaseId, "the offer carries the item's lease");
          assert.equal(out.deliveryId, after.deliveryId, "the offer carries the item's delivery");
          if (w.offer === "resume") assert.deepEqual(out.bindings, [{ jobId: c.id, provider: "chatgpt", runId: "run-A" }], "a resume names its binding");
          else assert.equal("bindings" in out, false, "fresh and replay offers name no binding");
          assert.equal(out.prompt, REQ.prompt);
        }
      }
      if (w.lease === "none") assert.equal(after.leaseId, undefined);
      if (w.lease === "same") assert.equal(after.leaseId, c.before.leaseId ?? c.leaseId);
      if (w.lease === "new") assert.ok(after.leaseId && after.leaseId !== c.before.leaseId, "a new lease");
      if (w.submitAt === "now") assert.equal(after.submitAt, now, "submitAt starts now");
      if (w.submitAt === "unset") assert.equal(after.submitAt, undefined, "submitAt is not set");
      if (w.submitAt === "kept") assert.equal(after.submitAt, c.before.submitAt, "submitAt is untouched");
      if (w.generating === "kept") assert.equal(after.generating, c.before.generating, "generating is untouched");
      else if (w.generating !== undefined) assert.equal(after.generating, w.generating);
      if (w.submitting !== undefined) assert.equal(c.h.reg.submitting("chrome-1", [c.id]), w.submitting, "submitting(chrome-1, [id])");
      if (w.nextTakeable !== undefined) {
        assert.equal(c.h.reg.submitting("chrome-1"), !w.nextTakeable, "the profile's foreground is free");
      }
      if (w.nextTakeable) {
        const other = c.h.reg.request({ ...REQ, pr: 8 });
        other.catch(() => {});
        const next = c.h.reg.peek([c.id], "chrome-1");
        assert.ok(next && c.h.reg.take(next.id, "chrome-1")?.offerKind === "fresh", "another eligible job is taken");
      }
      void c.promise;
    });
  }

  // F-P2b (4096523047): two overlapping takes from one profile with the same exclude list (the
  // worker stored neither answer yet) both reach the claimed, run-less item. They get ONE delivery:
  // the first is fresh, the second replays it (same deliveryId and lease); nothing mints a second.
  it("F-P2b two overlapping takes, same client, same exclude list: one fresh delivery, replayed", () => {
    const h = harness();
    h.reg.request(REQ).catch(() => {});
    const exclude = ["job-known"];
    const a = h.reg.peek(exclude, "chrome-1");
    const b = h.reg.peek(exclude, "chrome-1");
    assert.ok(a && b && a.id === b.id);
    const first = h.reg.take(a.id, "chrome-1");
    const second = h.reg.take(b.id, "chrome-1");
    assert.ok(first && second);
    assert.deepEqual(
      [first.offerKind, second.offerKind],
      ["fresh", "replay"],
      "at most one fresh submission path",
    );
    assert.ok(first.deliveryId, "a fresh offer names its delivery");
    assert.equal(second.deliveryId, first.deliveryId, "the replay is the same delivery");
    assert.equal(second.leaseId, first.leaseId);
    assert.equal(h.reg.snapshot(a.id)?.deliveryId, first.deliveryId, "no second delivery was minted");
    // once the worker lists it, nothing is handed out again
    assert.equal(h.reg.peek([...exclude, a.id], "chrome-1"), undefined);
  });
});
