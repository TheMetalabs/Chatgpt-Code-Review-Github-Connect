import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerLanes } from "./reviewer-progress.ts";
import type { Job } from "./types.ts";

function job(partial: Partial<Job>): Job {
  return {
    id: "j1",
    deliveryId: "d1",
    trigger: "issue_comment.mention",
    owner: "acme",
    repo: "pay",
    pr: 1,
    title: "t",
    headSha: "abc",
    baseSha: "def",
    sender: "a",
    isFork: false,
    isDraft: false,
    status: "awaiting_chat",
    createdAt: 1,
    updatedAt: 1,
    ingressMs: 1,
    traces: [],
    plan: "",
    candidates: [],
    findings: [],
    investigatedSafe: [],
    assumptions: [],
    ...partial,
  };
}

const json = `{"merge_recommendation":"COMMENT","highest_risk":"","investigated_safe":[],"assumptions":[],"findings":[{"severity":"P1","file":"a.ts","line":1,"side":"RIGHT","title":"t","failure_scenario":"f","root_cause":"r","evidence":"e","recommended_fix":"x","recommended_test":"y"}]}`;

describe("buildReviewerLanes", () => {
  it("omits Grok when the job did not enable it", () => {
    const lanes = buildReviewerLanes(job({ reviewProviders: ["chatgpt", "local"] }));
    assert.deepEqual(
      lanes.map((l) => l.provider),
      ["chatgpt", "local"],
    );
  });

  it("marks ChatGPT answered without exposing the raw JSON", () => {
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["chatgpt"],
        storedLegs: [{ provider: "chatgpt", raw: json }],
      }),
    );
    assert.equal(lanes[0].state, "answered");
    assert.equal(lanes[0].answered, true);
    assert.equal(lanes[0].findingCount, 1);
    assert.equal(lanes[0].detail.includes("JSON back"), true);
    assert.equal(JSON.stringify(lanes).includes("failure_scenario"), false);
  });

  it("shows generating while the tab is answering", () => {
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["chatgpt", "grok"],
        generating: { chatgpt: true, grok: false },
      }),
    );
    assert.equal(lanes.find((l) => l.provider === "chatgpt")?.state, "generating");
    assert.equal(lanes.find((l) => l.provider === "grok")?.state, "empty");
  });

  it("shows local generating from inFlight, skipped from assumptions", () => {
    const racing = buildReviewerLanes(job({ reviewProviders: ["chatgpt", "local"] }), { localInFlight: true });
    assert.equal(racing.find((l) => l.provider === "local")?.state, "generating");
    const skipped = buildReviewerLanes(
      job({
        reviewProviders: ["local"],
        assumptions: ["Skipped local (ECONNREFUSED)"],
      }),
    );
    assert.equal(skipped[0].state, "skipped");
  });

  it("uses settings-enabled list before reviewProviders is stored", () => {
    const lanes = buildReviewerLanes(job({ status: "snapshot", reviewProviders: undefined }), {
      enabled: ["chatgpt"],
    });
    assert.equal(lanes[0].provider, "chatgpt");
    assert.equal(lanes[0].state, "queued");
  });


  it("splits usage limit vs finished without JSON when notes exist", () => {
    const quota = buildReviewerLanes(
      job({
        reviewProviders: ["chatgpt"],
        generating: { chatgpt: false },
        assumptions: ["chatgpt usage limit"],
      }),
    );
    assert.equal(quota[0].detail, "usage limit");
    const empty = buildReviewerLanes(
      job({
        reviewProviders: ["chatgpt"],
        generating: { chatgpt: false },
        assumptions: ["chatgpt finished without JSON"],
      }),
    );
    assert.equal(empty[0].detail, "finished without JSON");
  });

  it("labels non-review JSON as extract failed", () => {
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["local"],
        storedLegs: [{ provider: "local", raw: '{"hello":"world"}' }],
      }),
    );
    assert.equal(lanes[0].state, "answered");
    assert.match(lanes[0].detail, /extract failed/i);
  });

});
