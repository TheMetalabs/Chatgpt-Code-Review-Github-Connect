import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLocalActivity, localLegProgress, localReviewDeadlineMs, startLocalLeg } from "./local-leg-activity.ts";

describe("localReviewDeadlineMs", () => {
  it("defaults to no ceiling: a queued multi-turn review may legitimately take hours", () => {
    assert.equal(localReviewDeadlineMs({}), 0);
    assert.equal(localReviewDeadlineMs({ ASHLAR_LOCAL_REVIEW_DEADLINE_MS: "" }), 0);
    assert.equal(localReviewDeadlineMs({ ASHLAR_LOCAL_REVIEW_DEADLINE_MS: "0" }), 0);
  });

  it("honours an explicit positive ceiling and ignores garbage or negatives", () => {
    assert.equal(localReviewDeadlineMs({ ASHLAR_LOCAL_REVIEW_DEADLINE_MS: "7200000" }), 7_200_000);
    assert.equal(localReviewDeadlineMs({ ASHLAR_LOCAL_REVIEW_DEADLINE_MS: "abc" }), 0);
    assert.equal(localReviewDeadlineMs({ ASHLAR_LOCAL_REVIEW_DEADLINE_MS: "-5" }), 0);
  });
});

describe("local leg activity tracker", () => {
  it("starts queued and reports the first server acceptance once, without a phase change", () => {
    const start = startLocalLeg(1_000);
    assert.equal(start.phase, "queued");
    const a = applyLocalActivity(start, "keepalive", 2_000);
    assert.equal(a.accepted, true);
    assert.equal(a.generated, false);
    assert.equal(a.state.phase, "queued");
    assert.equal(a.state.aliveAt, 2_000);
    assert.equal(a.state.progressAt, 1_000, "a heartbeat is a sign of life, not progress");
    assert.equal(a.flush, false, "heartbeats inside the throttle window do not rewrite the job");
    const b = applyLocalActivity(a.state, "keepalive", 3_000);
    assert.equal(b.accepted, false, "acceptance is recorded once per leg");
  });

  it("flushes a heartbeat once the throttle window has elapsed", () => {
    const start = startLocalLeg(0);
    const a = applyLocalActivity(start, "keepalive", 5_000);
    assert.equal(a.flush, true);
    assert.equal(a.state.writtenAt, 5_000);
  });

  it("flips to generating on the first output token and flushes immediately", () => {
    const start = startLocalLeg(0);
    const queued = applyLocalActivity(start, "keepalive", 1_000).state;
    const gen = applyLocalActivity(queued, "output", 1_500);
    assert.equal(gen.generated, true);
    assert.equal(gen.state.phase, "generating");
    assert.equal(gen.state.progressAt, 1_500);
    assert.equal(gen.flush, true, "a phase change is always written");
    const more = applyLocalActivity(gen.state, "output", 1_600);
    assert.equal(more.generated, false);
    assert.equal(more.flush, false);
  });

  it("returns to queued at a multi-turn boundary and counts the boundary as progress", () => {
    const gen = applyLocalActivity(startLocalLeg(0), "output", 100).state;
    const turn = applyLocalActivity(gen, "turn", 60_000);
    assert.equal(turn.state.phase, "queued");
    assert.equal(turn.state.progressAt, 60_000);
    assert.equal(turn.flush, true);
  });

  it("projects the tracker into providerProgress with separate progress and liveness stamps", () => {
    const queued = applyLocalActivity(startLocalLeg(0), "keepalive", 30_000).state;
    const p = localLegProgress(queued, "local:j1", 31_000);
    assert.deepEqual(p, { runId: "local:j1", stage: "local_queued", observedAt: 0, keepaliveAt: 30_000, receivedAt: 31_000 });
    const gen = applyLocalActivity(queued, "output", 40_000).state;
    assert.equal(localLegProgress(gen, "local:j1", 40_000).stage, "local_generating");
  });
});
