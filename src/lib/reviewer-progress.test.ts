import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerLanes, emptyReviewSkip, localLegNote } from "./reviewer-progress.ts";
import { isUnlabelledStage, stageIs, type ProviderProgress } from "./review-progress.ts";
import { sanitizeProgressEvents } from "./review-progress.server.ts";
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

  it("shows a stage recorded ahead of its label under the unlabelled fallback, by its hash only", () => {
    // The detail reaches the GitHub ops comment and the unauthenticated harbor snapshot: a stage name
    // passes a lexical check only, so the lane shows the sentinel's hash, never the name.
    const [event] = sanitizeProgressEvents([{source: "page", sequence: 1, stage: "secret_token_abc123", at: 1}]);
    const lanes = buildReviewerLanes(
      job({
        reviewProviders: ["chatgpt"],
        generating: { chatgpt: true },
        providerProgress: {chatgpt: {runId: "run", stage: event.stage, observedAt: Date.now(), receivedAt: Date.now()}},
      }),
    );
    assert.equal(lanes[0].state, "waiting");
    assert.equal(lanes[0].detail, "Unlabelled step · #9699b893");
    assert.equal(JSON.stringify(lanes).includes("secret_token"), false);
  });

  it("shows a progress stage of any other shape as a bare unlabelled step, never by its value", () => {
    // providerProgress is only written through sanitizeProgressEvents or by the server; a stage read back
    // that is neither a label key nor exactly a sentinel is still not shown.
    for (const stage of ["secret_token_abc123", "unlabelled:9699b893x", "unlabelled:9699B893", "unlabelled:secret"]) {
      const lanes = buildReviewerLanes(
        job({
          reviewProviders: ["chatgpt"],
          generating: { chatgpt: true },
          providerProgress: {chatgpt: {runId: "run", stage: stage as ProviderProgress["stage"], observedAt: Date.now(), receivedAt: Date.now()}},
        }),
      );
      assert.equal(lanes[0].detail, "Unlabelled step", stage);
    }
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

  it("emptyReviewSkip does not read a usage limit into a stage that has no label", () => {
    // A stage without a label is not the provider reporting a usage limit, whatever its name says
    // ("quota"); the lane shows only its hash.
    const [event] = sanitizeProgressEvents([{source: "page", sequence: 1, stage: "quota_banner_dismissed", at: 1}]);
    const lanes = buildReviewerLanes(job({
      reviewProviders: ["chatgpt"],
      generating: {chatgpt: false},
      providerErrors: {chatgpt: {code: "error", message: "context_lost: the page lost the conversation"}},
      providerProgress: {chatgpt: {runId: "run", stage: event.stage, observedAt: 1, receivedAt: 1}},
    }));
    assert.equal(lanes[0].detail, "Unlabelled step · #0cb42f85");
    const skip = emptyReviewSkip(lanes);
    assert.equal(skip.usageLimited, false);
    assert.equal(skip.skipReason, "reviewers could not complete — see per-reviewer details");
    assert.doesNotMatch(skip.ops[0], /usage limit/i);
  });

  it("emptyReviewSkip reads the usage limit the lane was built with, not a detail's wording", () => {
    // Each place a lane learns of a usage limit marks it: the provider's own quota stage, a quota skip
    // note, a usage-limit error note, and a job skipped for a usage limit.
    const cases = {
      quotaStage: job({
        reviewProviders: ["chatgpt"],
        generating: {chatgpt: false},
        providerErrors: {chatgpt: {code: "error", message: "stopped"}},
        providerProgress: {chatgpt: {runId: "run", stage: "quota", observedAt: 1, receivedAt: 1}},
      }),
      quotaSkipNote: job({reviewProviders: ["grok"], assumptions: ["Skipped grok: quota: You've reached the limit"]}),
      localErrorNote: job({reviewProviders: ["local"], generating: {local: false}, assumptions: ["local usage limit"]}),
      skippedJob: job({status: "skipped", reviewProviders: ["chatgpt"], skipReason: "reviewers could not complete — usage limit reached"}),
    };
    for (const [name, value] of Object.entries(cases)) {
      const lanes = buildReviewerLanes(value);
      assert.equal(lanes[0].usageLimited, true, name);
      assert.equal(emptyReviewSkip(lanes).usageLimited, true, name);
    }
    const labelled = buildReviewerLanes(job({
      reviewProviders: ["chatgpt"],
      generating: {chatgpt: false},
      providerErrors: {chatgpt: {code: "error", message: "stopped"}},
      providerProgress: {chatgpt: {runId: "run", stage: "waiting_for_json", observedAt: 1, receivedAt: 1}},
    }));
    assert.equal(labelled[0].usageLimited, false, "another stage does not mark the lane");
    // A hand-built lane whose text only mentions a limit is not marked.
    assert.equal(emptyReviewSkip([{provider: "chatgpt", label: "ChatGPT", state: "empty", detail: "usage limit", answered: false}]).usageLimited, false);
  });

  it("a progress stage recorded before the provider's quota error does not mask it", () => {
    // Reported: ChatGPT had reached waiting_for_json when the server recorded its quota error. The lane
    // is built by the progress branch, and its flag still comes from the provider's error.
    const lanes = buildReviewerLanes(job({
      reviewProviders: ["chatgpt"],
      generating: {chatgpt: false},
      providerErrors: {chatgpt: {code: "quota", message: "You've reached the limit"}},
      providerProgress: {chatgpt: {runId: "run", stage: "waiting_for_json", observedAt: 1, receivedAt: 1}},
    }));
    assert.equal(lanes[0].detail, "Response visible · waiting for valid review JSON", "the progress branch built it");
    assert.equal(lanes[0].usageLimited, true);
    const skip = emptyReviewSkip(lanes);
    assert.equal(skip.usageLimited, true);
    assert.equal(skip.skipReason, "reviewers could not complete — usage limit reached");
  });

  it("every lane branch reads a usage limit from the same evidence", () => {
    // The provider's quota error code, or a usage limit its error message reports, marks the lane whichever
    // branch builds it: a skip note or a skipped job's reason that names another cause does not hide it.
    const errors = {
      code: {chatgpt: {code: "quota", message: "You've reached the limit"}},
      message: {chatgpt: {code: "error", message: "usage limit reached for this model"}},
    } as const;
    for (const [evidence, providerErrors] of Object.entries(errors)) {
      const branches = {
        progress: job({reviewProviders: ["chatgpt"], generating: {chatgpt: false}, providerErrors,
          providerProgress: {chatgpt: {runId: "run", stage: "generating", observedAt: 1, receivedAt: 1}}}),
        skipNote: job({reviewProviders: ["chatgpt"], providerErrors, assumptions: ["Skipped chatgpt: tab_closed: review tab was explicitly closed"]}),
        skippedJob: job({status: "cancelled", reviewProviders: ["chatgpt"], providerErrors, skipReason: "cancelled by operator"}),
        empty: job({reviewProviders: ["chatgpt"], generating: {chatgpt: false}, providerErrors}),
        pending: job({reviewProviders: ["chatgpt"], generating: {chatgpt: true}, providerErrors}),
      };
      for (const [branch, value] of Object.entries(branches)) {
        const lanes = buildReviewerLanes(value);
        assert.equal(lanes[0].usageLimited, true, `${evidence} · ${branch}`);
        assert.equal(emptyReviewSkip(lanes).usageLimited, true, `${evidence} · ${branch}`);
      }
    }
    // A skip note that names the limit counts beside a structured error that does not.
    const noted = buildReviewerLanes(job({reviewProviders: ["chatgpt"], providerErrors: {chatgpt: {code: "error", message: "stopped"}},
      assumptions: ["Skipped chatgpt: quota: You've reached the limit"]}));
    assert.equal(noted[0].usageLimited, true);
    // Another provider's quota error is not this lane's.
    const other = buildReviewerLanes(job({reviewProviders: ["chatgpt", "grok"], generating: {chatgpt: false, grok: false},
      providerErrors: {grok: {code: "quota", message: "limit"}},
      providerProgress: {chatgpt: {runId: "run", stage: "waiting_for_json", observedAt: 1, receivedAt: 1}}}));
    assert.deepEqual(other.map((lane) => lane.usageLimited), [false, true]);
  });

});

describe("ProgressStage", () => {
  // The @ts-expect-error lines are the pin: `npx tsc --noEmit` fails on an unused one, so widening the
  // type back to string (or letting stageIs take any string) turns the type-check red.
  it("is closed for a stage the server writes or compares, and opened only by a sentinel's shape check", () => {
    // @ts-expect-error a mistyped stage the server writes is not a ProgressStage
    const typo: ProviderProgress = {runId: "local:j1", stage: "eror", observedAt: 1, receivedAt: 1};
    const fromBody: string = "tab_woken";
    // @ts-expect-error an unchecked string is not a ProgressStage until sanitizeProgressEvents passes it
    const unchecked: ProviderProgress = {runId: "run", stage: fromBody, observedAt: 1, receivedAt: 1};
    // @ts-expect-error nor is a string of the sentinel's shape until isUnlabelledStage checks it
    const spelled: ProviderProgress = {runId: "run", stage: "unlabelled:6fac6376", observedAt: 1, receivedAt: 1};
    const sentinel: string = "unlabelled:6fac6376";
    if (isUnlabelledStage(sentinel)) assert.equal(stageIs(sentinel, "generating"), false);
    assert.equal(stageIs(spelled.stage, "generating"), false);
    // @ts-expect-error a comparison names a labelled stage, so a mistyped one fails too
    assert.equal(stageIs(typo.stage, "local_queud"), false);
    const [event] = sanitizeProgressEvents([{source: "page", sequence: 1, stage: fromBody, at: 1}]);
    assert.equal(event.stage, "unlabelled:6fac6376", "kept as the sentinel: the first 8 hex digits of the name's SHA-256");
    const recorded: ProviderProgress = {runId: "run", stage: event.stage, observedAt: 1, receivedAt: 1};
    assert.equal(stageIs(recorded.stage, "generating"), false);
    assert.equal(stageIs(unchecked.stage, "generating"), false);
    const written: ProviderProgress = {runId: "local:j1", stage: "local_queued", observedAt: 1, receivedAt: 1};
    assert.equal(stageIs(written.stage, "local_queued"), true);
    assert.equal(stageIs(undefined, "local_queued"), false);
  });
});
