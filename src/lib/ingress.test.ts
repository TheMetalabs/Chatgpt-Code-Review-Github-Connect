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

  it("queues a fork when skipForks is off", () => {
    const d = decideIngress({
      ...base,
      settings: { ...DEFAULT_SETTINGS, skipForks: false },
      sample: SAMPLE_PRS["pay-421"],
      trigger: "pull_request.opened",
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.ok(d.job);
  });

  it("is idempotent on posted (repo, pr, head, trigger)", () => {
    const d = decideIngress({
      ...base,
      sample: SAMPLE_PRS["pay-412"],
      trigger: "pull_request.opened",
      existing: [job()],
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.match(d.skip ?? "", /idempotent/);
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

  it("does not treat a 403 delivery_id as accepted, so a HMAC retry can queue", () => {
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
    if (d.ok) assert.ok(d.job);
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
});
