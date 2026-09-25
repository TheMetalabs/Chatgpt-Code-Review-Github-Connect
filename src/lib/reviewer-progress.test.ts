import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerLanes, emptyReviewSkip, localLegNote } from "./reviewer-progress.ts";
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

  it("shows a stage recorded ahead of its label under the unlabelled fallback", () => {
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["chatgpt"],
        generating: { chatgpt: true },
        providerProgress: {chatgpt: {runId: "run", stage: "tab_woken", observedAt: Date.now(), receivedAt: Date.now()}},
      }),
    );
    assert.equal(lanes[0].state, "waiting");
    assert.equal(lanes[0].detail, "Unlabelled step · tab_woken");
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

  it("local in-flight lane flags a stalled heartbeat (older than the stale window)", () => {
    // Binary, not a live counter: the detail feeds the ops-comment change key, so it must flip at
    // most once (fresh -> stale) rather than change every tick with the elapsed age.
    const now = 1_000_000;
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["local"],
        providerProgress: {
          local: { runId: "local:j1", stage: "generating", observedAt: now - 400_000, receivedAt: now - 400_000 },
        },
      }),
      { localInFlight: true, now, staleMs: 300_000 },
    );
    const lane = lanes.find((l) => l.provider === "local");
    assert.equal(lane?.state, "generating");
    assert.equal(lane?.detail, "calling local LLM · no recent progress");
  });

  it("local in-flight lane stays plain while the heartbeat is fresh", () => {
    const now = 1_000_000;
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["local"],
        providerProgress: {
          local: { runId: "local:j1", stage: "generating", observedAt: now - 3_000, receivedAt: now - 3_000 },
        },
      }),
      { localInFlight: true, now, staleMs: 300_000 },
    );
    const lane = lanes.find((l) => l.provider === "local");
    assert.equal(lane?.detail, "calling local LLM");
  });

  it("local in-flight lane falls back to the plain label when no heartbeat has landed yet", () => {
    const lanes = buildReviewerLanes(job({ reviewProviders: ["local"] }), { localInFlight: true });
    const lane = lanes.find((l) => l.provider === "local");
    assert.equal(lane?.detail, "calling local LLM");
  });

  it("a queued local leg whose server is alive is reported as queued, not stalled, however old its progress", () => {
    // Regression: a concurrency-1 server serves other jobs first. An hour in the queue with fresh
    // keepalives is normal and must not read as "no recent progress" (nor be aborted).
    const now = 10_000_000;
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["local"],
        providerProgress: {
          local: { runId: "local:j1", stage: "local_queued", observedAt: now - 3_600_000, keepaliveAt: now - 2_000, receivedAt: now - 2_000 },
        },
      }),
      { localInFlight: true, now, staleMs: 300_000 },
    );
    const lane = lanes.find((l) => l.provider === "local");
    assert.equal(lane?.state, "generating");
    assert.equal(lane?.detail, "queued at local LLM · server alive, no output yet");
    assert.equal(localLegNote({ runId: "local:j1", stage: "local_queued", observedAt: now - 3_600_000, keepaliveAt: now - 2_000, receivedAt: now }, now, 300_000),
      "local reviewer: queued at the local LLM (server alive, no output yet — a concurrency-1 server serves earlier jobs first)");
  });

  it("a queued local leg with no sign of life past the stale window reads as no response from the server", () => {
    const now = 10_000_000;
    const progress = { runId: "local:j1", stage: "local_queued" as const, observedAt: now - 400_000, keepaliveAt: now - 400_000, receivedAt: now - 400_000 };
    const lanes = buildReviewerLanes(job({ reviewProviders: ["local"], providerProgress: { local: progress } }), { localInFlight: true, now, staleMs: 300_000 });
    assert.equal(lanes.find((l) => l.provider === "local")?.detail, "waiting for local LLM · no response from server");
    assert.equal(localLegNote(progress, now, 300_000), "local reviewer: no response from the local LLM server (still waiting; cancel manually if stalled)");
  });

  it("a generating local leg with fresh output needs no ops note; stale output keeps the original note", () => {
    const now = 10_000_000;
    const fresh = { runId: "local:j1", stage: "local_generating" as const, observedAt: now - 1_000, keepaliveAt: now - 1_000, receivedAt: now };
    assert.equal(localLegNote(fresh, now, 300_000), null);
    const stale = { ...fresh, observedAt: now - 400_000 };
    assert.equal(localLegNote(stale, now, 300_000), "local reviewer: no recent progress (still waiting; cancel manually if stalled)");
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
