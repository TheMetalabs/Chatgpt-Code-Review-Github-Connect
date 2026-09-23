import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixRequestStop, watchFixRequest, type FixPhase, type WatchedRequest } from "./fix-request-watch.ts";

/** A controllable provider: the test drives its phase and settlement. */
function provider() {
  let resolveFn: (v: string) => void = () => {};
  let rejectFn: (e: Error) => void = () => {};
  let activity: (p: FixPhase) => void = () => {};
  let aborted = false;
  const request: WatchedRequest = (_prompt, ctl) => {
    activity = ctl.onActivity;
    ctl.signal.addEventListener("abort", () => {
      aborted = true;
      rejectFn(new Error("aborted"));
    });
    return new Promise<string>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
  };
  return {
    request,
    phase: (p: FixPhase) => activity(p),
    resolve: (v: string) => resolveFn(v),
    get aborted() {
      return aborted;
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = { generationMs: 60, queueMaxMs: 10_000, livenessMs: 0, checkEveryMs: 10_000, tickMs: 5, reportsActivity: true, stillWanted: async () => null };

describe("watchFixRequest (queue-aware deadlines, relevance)", () => {
  it("resolves with the provider's answer", async () => {
    const p = provider();
    const out = watchFixRequest(p.request, "x", base);
    p.phase("queued");
    p.phase("generating");
    p.resolve("answer");
    assert.equal(await out, "answer");
  });

  it("the generation deadline EXCLUDES queue time (a long queue is not a timeout)", async () => {
    const p = provider();
    const out = watchFixRequest(p.request, "x", { ...base, generationMs: 60 });
    p.phase("queued");
    await wait(120); // queued past generationMs — must NOT expire
    p.phase("generating");
    p.resolve("done");
    assert.equal(await out, "done");
  });

  it("generation past its deadline is aborted with a generation-deadline stop", async () => {
    const p = provider();
    const out = watchFixRequest(p.request, "x", { ...base, generationMs: 30 });
    p.phase("generating");
    await assert.rejects(out, (e: unknown) => e instanceof FixRequestStop && e.why === "generation-deadline");
    assert.equal(p.aborted, true);
  });

  it("the queue ceiling is a backstop", async () => {
    const p = provider();
    const out = watchFixRequest(p.request, "x", { ...base, queueMaxMs: 30 });
    p.phase("queued");
    await assert.rejects(out, (e: unknown) => e instanceof FixRequestStop && e.why === "queue-deadline");
  });

  it("silence after a sign of life means the provider died (liveness)", async () => {
    const p = provider();
    const out = watchFixRequest(p.request, "x", { ...base, livenessMs: 30 });
    p.phase("queued");
    await assert.rejects(out, (e: unknown) => e instanceof FixRequestStop && e.why === "silent");
  });

  it("a queued request whose PR moved on is cancelled BEFORE it generates", async () => {
    const p = provider();
    let calls = 0;
    const out = watchFixRequest(p.request, "x", { ...base, checkEveryMs: 10, stillWanted: async () => (++calls >= 2 ? "the PR head moved" : null) });
    p.phase("queued");
    await assert.rejects(out, (e: unknown) => e instanceof FixRequestStop && e.why === "cancelled" && /head moved/.test(e.message));
    assert.equal(p.aborted, true, "the queue slot is released");
  });

  it("relevance is re-checked the moment generation starts (cut a stale generation early)", async () => {
    const p = provider();
    let wanted: string | null = null;
    const out = watchFixRequest(p.request, "x", { ...base, stillWanted: async () => wanted });
    p.phase("queued");
    wanted = "loop stopped";
    p.phase("generating");
    await assert.rejects(out, (e: unknown) => e instanceof FixRequestStop && e.why === "cancelled");
  });

  it("a failing relevance check never cancels (fail open)", async () => {
    const p = provider();
    const out = watchFixRequest(p.request, "x", { ...base, checkEveryMs: 5, stillWanted: async () => { throw new Error("502"); } });
    p.phase("queued");
    await wait(30);
    p.phase("generating");
    p.resolve("ok");
    assert.equal(await out, "ok");
  });

  it("a provider that reports no activity is timed from send and still relevance-checked", async () => {
    const p = provider();
    const out = watchFixRequest(p.request, "x", { ...base, reportsActivity: false, generationMs: 30 });
    await assert.rejects(out, (e: unknown) => e instanceof FixRequestStop && e.why === "generation-deadline");
    const q = provider();
    const out2 = watchFixRequest(q.request, "x", { ...base, reportsActivity: false, generationMs: 10_000, checkEveryMs: 10, stillWanted: async () => "the PR head moved" });
    await assert.rejects(out2, (e: unknown) => e instanceof FixRequestStop && e.why === "cancelled");
  });

  it("a provider error passes through unchanged", async () => {
    const failing: WatchedRequest = async () => {
      throw new Error("local LLM response ended with length");
    };
    await assert.rejects(watchFixRequest(failing, "x", base), /ended with length/);
  });
});
