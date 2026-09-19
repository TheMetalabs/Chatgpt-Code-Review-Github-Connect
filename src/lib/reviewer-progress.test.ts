import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerLanes, emptyReviewSkip } from "./reviewer-progress.ts";
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

  it("shows generating only after a page observation, not an undelivered flag", () => {
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["chatgpt", "grok"],
        generating: { chatgpt: true, grok: false },
        providerProgress: {chatgpt: {runId: "run", stage: "generating", observedAt: Date.now(), receivedAt: Date.now()}},
      }),
    );
    assert.equal(lanes.find((l) => l.provider === "chatgpt")?.state, "generating");
    assert.equal(lanes.find((l) => l.provider === "grok")?.state, "waiting");
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
    assert.equal(lanes[0].state, "empty");
    assert.match(lanes[0].detail, /extract failed/i);
  });

  it("keeps an old client's undelivered flag pending without claiming prompt submission", () => {
    const lane = buildReviewerLanes(job({reviewProviders: ["chatgpt"], generating: {chatgpt: true}}))[0];
    assert.equal(lane.state, "waiting");
    assert.match(lane.detail, /submission not confirmed/);
  });

  it("emptyReviewSkip names the usage limit instead of blaming empty JSON", () => {
    const quota = emptyReviewSkip(
      buildReviewerLanes(job({ reviewProviders: ["chatgpt"], generating: { chatgpt: false }, assumptions: ["chatgpt usage limit"] })),
    );
    assert.equal(quota.usageLimited, true);
    assert.match(quota.skipReason, /usage limit/i);
    assert.match(quota.ops[0], /usage limit/i);
    assert.match(quota.ops.join("\n"), /ChatGPT: usage limit/);
  });

  it("emptyReviewSkip keeps the generic message when a reviewer genuinely returned no JSON", () => {
    const empty = emptyReviewSkip(
      buildReviewerLanes(job({ reviewProviders: ["chatgpt"], generating: { chatgpt: false }, assumptions: ["chatgpt finished without JSON"] })),
    );
    assert.equal(empty.usageLimited, false);
    assert.equal(empty.skipReason, "every enabled reviewer finished with no JSON");
    assert.equal(empty.ops[0], "Enabled reviewers finished without JSON. Nothing to post.");
  });

  it("emptyReviewSkip reports non-quota terminal failures as 'could not complete' via the real skip-note form", () => {
    // Real producer path: failBridgeProvider records "Skipped chatgpt: tab_closed: …" (underscore),
    // which buildReviewerLanes returns verbatim as the lane detail.
    const viaLanes = emptyReviewSkip(
      buildReviewerLanes(job({ reviewProviders: ["chatgpt"], generating: { chatgpt: false }, assumptions: ["Skipped chatgpt: tab_closed: review tab was explicitly closed"] })),
    );
    assert.equal(viaLanes.usageLimited, false);
    assert.match(viaLanes.skipReason, /could not complete/i);
    assert.doesNotMatch(viaLanes.ops[0], /finished without JSON/i);
    // Humanized details are covered too.
    for (const detail of ["review tab closed", "connection unknown · waiting for reconnection", "error: bridge dropped"]) {
      const r = emptyReviewSkip([{ provider: "chatgpt", label: "ChatGPT", state: "empty", detail, answered: false }]);
      assert.match(r.skipReason, /could not complete/i);
      assert.doesNotMatch(r.ops[0], /finished without JSON/i);
    }
  });

});
