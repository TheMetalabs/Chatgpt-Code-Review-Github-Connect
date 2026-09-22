import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acceptedDeliveryIds, decideIngress } from "./ingress.ts";
import { SAMPLE_PRS } from "./samples.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import type { Job } from "./types.ts";

function job(partial: Partial<Job> = {}): Job {
  const sample = SAMPLE_PRS["pay-412"];
  return {
    id: "job-1",
    deliveryId: "d-1",
    trigger: "pull_request.opened",
    owner: sample.owner,
    repo: sample.repo,
    pr: sample.pr,
    title: sample.title,
    headSha: sample.headSha,
    baseSha: sample.baseSha,
    sender: sample.sender,
    isFork: false,
    isDraft: false,
    status: "posted",
    createdAt: 1,
    updatedAt: 1,
    ingressMs: 10,
    traces: [],
    plan: "",
    candidates: [],
    findings: [],
    investigatedSafe: [],
    assumptions: [],
    sampleKey: "pay-412",
    ...partial,
  };
}

const base = {
  hmacOk: true,
  settings: DEFAULT_SETTINGS,
  existing: [] as Job[],
  deliveryId: "d-new",
};

describe("decideIngress", () => {
  it("rejects HMAC mismatch with 403 and no job", () => {
    const d = decideIngress({
      ...base,
      hmacOk: false,
      sample: SAMPLE_PRS["pay-418"],
      trigger: "pull_request.opened",
    });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.status, 403);
      assert.equal(d.reason, "HMAC mismatch");
    }
  });

  it("skips drafts when skipDrafts is on", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-430"],
      trigger: "pull_request.opened",
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.skip, "draft");
  });

  it("skips forks with an untrusted-body reason", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-421"],
      trigger: "pull_request.opened",
    });
    assert.equal(d.ok, true);
    if (d.ok) {
      assert.match(d.skip ?? "", /fork/);
      assert.match(d.skip ?? "", /PR body not promoted/);
    }
  });

  it("still skips PR open/push for forks even when skipForks is off — LLM needs @ashlar-bot", () => {
    const d = decideIngress({
      ...base,
      settings: { ...DEFAULT_SETTINGS, skipForks: false },
      sample: SAMPLE_PRS["pay-421"],
      trigger: "pull_request.opened",
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.skip, "LLM only on explicit @ashlar-bot mention");
  });

  it("skips PR open/push/reopen without an explicit @ashlar-bot mention (no LLM)", () => {
    for (const trigger of [
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.reopened",
      "pull_request.ready_for_review",
    ] as const) {
      const d = decideIngress({
        ...base,
        sample: SAMPLE_PRS["pay-418"],
        trigger,
        deliveryId: `d-${trigger}`,
      });
      assert.equal(d.ok, true, trigger);
      if (d.ok) assert.equal(d.skip, "LLM only on explicit @ashlar-bot mention", trigger);
    }
  });

  it("dedupes delivery ids from knownDeliveries even when no job exists", () => {
    const d = decideIngress({
      ...base,
      deliveryId: "dup",
      knownDeliveries: ["dup"],
      sample: SAMPLE_PRS["pay-418"],
      trigger: "pull_request.opened",
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.match(d.skip ?? "", /duplicate delivery_id/);
  });

  it("does not treat a 403 delivery_id as accepted, so a HMAC retry can proceed (still mention-gated)", () => {
    const events = [
      { deliveryId: "d-retry", httpStatus: 403 as const },
      { deliveryId: "d-ok", httpStatus: 202 as const },
    ];
    assert.deepEqual(acceptedDeliveryIds(events), ["d-ok"]);
    const d = decideIngress({
      ...base,
      hmacOk: true,
      deliveryId: "d-retry",
      knownDeliveries: acceptedDeliveryIds(events),
      sample: SAMPLE_PRS["pay-418"],
      trigger: "pull_request.opened",
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.skip, "LLM only on explicit @ashlar-bot mention");
  });

  it("skips mention comments that lack a mention token", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-412"],
      trigger: "issue_comment.mention",
      thread: { kind: "mention", commentId: 1, userText: "lgtm thanks" },
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.skip, "not a mention");
  });

  it("skips prefix lookalikes of mention tokens", () => {
    for (const userText of ["please see /reviews", "hey @ashlar-botanist"]) {
      const d = decideIngress({
        ...base,
        sample: SAMPLE_PRS["pay-412"],
        trigger: "issue_comment.mention",
        thread: { kind: "mention", commentId: 1, userText },
      });
      assert.equal(d.ok, true, userText);
      if (d.ok) assert.equal(d.skip, "not a mention", userText);
    }
  });

  it("queues a mention when the comment includes @ashlar-bot", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-412"],
      trigger: "issue_comment.mention",
      existing: [job()],
      thread: { kind: "mention", commentId: 1, userText: "@ashlar-bot focus on fulfillOrder" },
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.ok(d.job);
  });

  it("queues a review-loop start directive even without an @-mention token", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-412"],
      trigger: "issue_comment.mention",
      thread: { kind: "mention", commentId: 1, userText: "/review-loop", loop: { kind: "start", mode: "suggest" } },
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.ok(d.job);
  });

  it("recognizes a review-loop start from the raw body when loop was not pre-parsed", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-412"],
      trigger: "issue_comment.mention",
      thread: { kind: "mention", commentId: 1, userText: "/review-loop apply" },
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.ok(d.job);
  });

  it("does not run a review for a review-loop stop directive", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-412"],
      trigger: "issue_comment.mention",
      thread: { kind: "mention", commentId: 1, userText: "/review-loop stop" },
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.skip, "review-loop stop (no active loop engine)");
  });

});
