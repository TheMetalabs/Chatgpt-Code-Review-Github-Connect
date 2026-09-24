import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFixRegistry,
  DEFAULT_FIX_MAX_PROMPT_CHARS,
  DEFAULT_FIX_TIMEOUT_MS,
  FIX_TERMINAL_RETAIN_MS,
  fixChatMaxPromptChars,
  fixChatTimeoutMs,
  isFixItemId,
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
      assert.match(error.message, /at most 20000 \(ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS\)/);
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

  it("env overrides are clamped to sane bounds", () => {
    assert.equal(fixChatTimeoutMs({}), 30 * 60_000);
    assert.equal(fixChatTimeoutMs(undefined), 30 * 60_000);
    assert.equal(fixChatTimeoutMs({ ASHLAR_FIX_CHAT_TIMEOUT_MS: "120000" }), 120_000);
    assert.equal(fixChatTimeoutMs({ ASHLAR_FIX_CHAT_TIMEOUT_MS: "1000" }), 60_000);
    assert.equal(fixChatTimeoutMs({ ASHLAR_FIX_CHAT_TIMEOUT_MS: "99999999999" }), 6 * 60 * 60_000);
    assert.equal(fixChatTimeoutMs({ ASHLAR_FIX_CHAT_TIMEOUT_MS: "soon" }), 30 * 60_000);
    assert.equal(fixChatMaxPromptChars({}), 100_000);
    assert.equal(fixChatMaxPromptChars({ ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS: "250000" }), 250_000);
    assert.equal(fixChatMaxPromptChars({ ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS: "5" }), 10_000);
    assert.equal(fixChatMaxPromptChars({ ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS: "9e9" }), 1_000_000);
  });

  it("fix ids are recognized by their prefix only", () => {
    assert.equal(isFixItemId("fix-abc"), true);
    assert.equal(isFixItemId("fix-"), false);
    assert.equal(isFixItemId("job-abc"), false);
    assert.equal(isFixItemId(42), false);
  });
});
