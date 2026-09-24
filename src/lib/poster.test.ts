import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFpStep,
  applyPeerReview,
  buildReview,
  consensusFromGates,
  disputedFromUnique,
  filterPublishable,
  findingsAgree,
  gateLiveSubmission,
  isBotMention,
  mergeEvent,
  partitionConsensus,
  partitionFindings,
  partitionMany,
  publishableFindings,
  schemaMergeProviderGates,
  SCHEMA_MERGE_NOTE,
} from "./poster.ts";
import { CANDIDATE_412_DROPPED, FINDING_412, FINDING_421, SAMPLE_PRS } from "./samples.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import type { Finding, Job } from "./types.ts";

function job(findings: Finding[], extra: Partial<Job> = {}): Job {
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
    findings,
    investigatedSafe: [],
    assumptions: [],
    sampleKey: "pay-412",
    ...extra,
  };
}

describe("poster", () => {
  it("matches mention tokens on boundaries, not prefixes", () => {
    assert.equal(isBotMention("please see /reviews", DEFAULT_SETTINGS), false);
    assert.equal(isBotMention("hey @ashlar-botanist", DEFAULT_SETTINGS), false);
    assert.equal(isBotMention("lgtm thanks", DEFAULT_SETTINGS), false);
    assert.equal(isBotMention("please /review the capture path", DEFAULT_SETTINGS), true);
    assert.equal(isBotMention("@ashlar-bot focus on fulfillOrder", DEFAULT_SETTINGS), true);
    assert.equal(isBotMention("Thanks @ashlar-bot.", DEFAULT_SETTINGS), true);
  });
  it("keeps a hedge out of inline comments but surfaces it in the body (never drops it)", () => {
    const hedge = { ...CANDIDATE_412_DROPPED, status: "accepted" as const };
    const { inline, unanchored } = partitionFindings([FINDING_412, hedge], DEFAULT_SETTINGS, SAMPLE_PRS["pay-412"]);
    assert.deepEqual(
      inline.map((f) => f.id),
      [FINDING_412.id],
    ); // the confident finding stays inline
    assert.deepEqual(
      unanchored.map((f) => f.id),
      [hedge.id],
    ); // the hedge is surfaced in the review body, not dropped
    // filterPublishable is inline-only, so the hedge is still excluded from inline comments.
    assert.equal(filterPublishable(job([FINDING_412, hedge]), DEFAULT_SETTINGS).length, 1);
  });

  it("keeps a hedge when precisionOverRecall is off", () => {
    const out = publishableFindings(
      [{ ...CANDIDATE_412_DROPPED, status: "accepted" }],
      { ...DEFAULT_SETTINGS, precisionOverRecall: false },
      SAMPLE_PRS["pay-412"],
    );
    assert.equal(out.length, 1);
  });

  it("does not publish a P1 when publishMinSeverity is P0", () => {
    const out = filterPublishable(job([FINDING_412]), { ...DEFAULT_SETTINGS, publishMinSeverity: "P0" });
    assert.equal(out.length, 0);
  });

  it("REQUEST_CHANGES follows requestChangesMin, not a hardcoded P1", () => {
    assert.equal(mergeEvent([FINDING_412], { ...DEFAULT_SETTINGS, requestChangesMin: "P1" }), "REQUEST_CHANGES");
    assert.equal(mergeEvent([FINDING_412], { ...DEFAULT_SETTINGS, requestChangesMin: "P0" }), "COMMENT");
  });

  it("uses the highest remaining severity, not findings[0]", () => {
    const p2first: Finding = { ...FINDING_412, id: "p2", severity: "P2", title: "noise" };
    const p0: Finding = { ...FINDING_412, id: "p0", severity: "P0" };
    assert.equal(mergeEvent([p2first, p0], DEFAULT_SETTINGS), "REQUEST_CHANGES");
  });

  it("does not post a review on zero findings unless mentioned", () => {
    const silent = buildReview(job([]), [], [], DEFAULT_SETTINGS);
    assert.equal(silent, null);
    const mentioned = buildReview(
      job([], { thread: { kind: "mention", commentId: 1, userText: "@ashlar-bot ping" } }),
      [],
      [],
      DEFAULT_SETTINGS,
    );
    assert.ok(mentioned);
    assert.ok(mentioned);
    assert.equal(mentioned.event, "COMMENT");
    assert.equal(mentioned.body.split("\n")[0], "Didn't find any major issues.");
    assert.match(mentioned.body, /Didn.t find any major issues/);
    assert.match(mentioned.body, /Reviewed commit:/);
    assert.match(mentioned.body, /ashlar-findings total=0/);
  });

  it("posts the clean verdict (CONVERGED) for a /review-loop start even without an @-mention", () => {
    // slash form and the driver's continuation marker are loop starts but not @-mentions
    for (const userText of ["/review-loop apply", "<!-- ashlar-loop-continue mode=apply round=2 pr=1 head=x -->"]) {
      const clean = buildReview(
        job([], { thread: { kind: "mention", commentId: 1, userText, loop: { kind: "start", mode: "apply" } } }),
        [],
        [],
        DEFAULT_SETTINGS,
      );
      assert.ok(clean, `clean verdict posted for ${userText}`);
      assert.match(clean.body, /ashlar-findings total=0/);
    }
    // a stop directive is not a review request: still silent on zero findings
    const stop = buildReview(
      job([], { thread: { kind: "mention", commentId: 1, userText: "/review-loop stop", loop: { kind: "stop" } } }),
      [],
      [],
      DEFAULT_SETTINGS,
    );
    assert.equal(stop, null);
  });

  it("salvages a raw_review reply (parse failed, repair off) and posts it as a non-clean COMMENT", () => {
    const sample = SAMPLE_PRS["pay-412"];
    const gate = gateLiveSubmission(
      { findings: [], merge_recommendation: "COMMENT", raw_review: "P1 verbatim salvaged review text" },
      sample,
      DEFAULT_SETTINGS,
    );
    assert.equal(gate.ok, true);
    if (!gate.ok) return;
    assert.equal(gate.findings.length, 0); // bypassed the empty-findings skip
    assert.equal(gate.rawReview, "P1 verbatim salvaged review text");
    // Zero findings + no mention normally skips; rawReview forces the review to post.
    const review = buildReview(job([], { rawReview: gate.rawReview }), [], [], DEFAULT_SETTINGS);
    assert.ok(review);
    assert.equal(review.event, "COMMENT");
    assert.match(review.body, /verbatim salvaged review text/);
    assert.doesNotMatch(review.body, /Didn.t find any major issues/); // not a clean pass
  });

  it("drops findings whose file is not in changedPaths", () => {
    const fulfill: Finding = {
      ...FINDING_412,
      id: "f-fulfill",
      file: "src/orders/fulfill.ts",
      line: 1,
    };
    const out = publishableFindings([fulfill], DEFAULT_SETTINGS, SAMPLE_PRS["pay-412"]);
    assert.equal(out.length, 0);
  });

  it("surfaces a line that is not in the pull diff as unanchored instead of dropping it", () => {
    const far: Finding = { ...FINDING_412, id: "f-far", line: 200 };
    const split = partitionFindings([far], DEFAULT_SETTINGS, SAMPLE_PRS["pay-412"]);
    // Not inline-anchorable (line 200 is not a commentable diff line) — but never dropped.
    assert.equal(split.inline.length, 0);
    assert.deepEqual(
      split.unanchored.map((f) => f.id),
      ["f-far"],
    );
    // publishableFindings still returns only the inline set, so it stays 0 here.
    assert.equal(publishableFindings([far], DEFAULT_SETTINGS, SAMPLE_PRS["pay-412"]).length, 0);
    const ok = partitionFindings([FINDING_412], DEFAULT_SETTINGS, SAMPLE_PRS["pay-412"]);
    assert.equal(ok.inline.length, 1);
    assert.equal(ok.unanchored.length, 0);
  });

  it("a lone unanchored finding still makes the review REQUEST_CHANGES, not clean", () => {
    // Regression for aicc-center #259: the model returned a real P1 whose reported line did not
    // exist on head; the old pipeline dropped it and posted "Didn't find any major issues".
    const far: Finding = { ...FINDING_412, id: "f-far", severity: "P1", line: 900 };
    const { inline, unanchored } = partitionFindings([far], DEFAULT_SETTINGS, SAMPLE_PRS["pay-412"]);
    assert.equal(inline.length, 0);
    assert.equal(unanchored.length, 1);
    const review = buildReview(job([far]), inline, unanchored, DEFAULT_SETTINGS);
    assert.ok(review);
    assert.equal(review.event, "REQUEST_CHANGES");
    assert.equal(review.comments.length, 0); // no inline comment on a nonexistent line
    assert.doesNotMatch(review.body, /Didn.t find any major issues/);
    assert.match(review.body, /without an inline anchor/i);
    assert.match(review.body, new RegExp(far.title));
    // Machine-readable marker so a consumer that only counts inline comments still sees the finding.
    assert.match(review.body, /ashlar-findings total=1 inline=0 body=1/);
  });

  const SNIP_DIFF = `--- src/foo.ts
@@ -10,2 +10,3 @@
 keep1
+const unique = compute(alpha, beta);
+return null;
@@ -40,1 +80,4 @@
 keep2
+return null;
+another(gamma);
+}
`;
  const snipSample = () => ({
    ...SAMPLE_PRS["pay-412"],
    diff: SNIP_DIFF,
    changedPaths: ["src/foo.ts"],
    files: [{ path: "src/foo.ts", language: "ts" as const, content: "" }],
  });

  it("anchors a finding by its verbatim evidence snippet, not its drifted line number", () => {
    const f = {
      ...FINDING_412,
      status: "accepted" as const,
      id: "snip-1",
      file: "src/foo.ts",
      line: 999, // drifted / out of file bounds — must be ignored in favor of the snippet
      evidence: 'src/foo.ts:999 "const unique = compute(alpha, beta);"',
    };
    const { inline, unanchored } = partitionFindings([f], DEFAULT_SETTINGS, snipSample());
    assert.equal(inline.length, 1);
    assert.equal(inline[0].line, 11); // resolved from the quoted code, not 999
    assert.equal(unanchored.length, 0);
  });

  it("surfaces — never drops or mislocates — a finding whose snippet is ambiguous", () => {
    const f = {
      ...FINDING_412,
      status: "accepted" as const,
      id: "amb-1",
      file: "src/foo.ts",
      line: 999,
      evidence: 'src/foo.ts:999 "return null;"', // appears twice in the diff → cannot pin
    };
    const { inline, unanchored } = partitionFindings([f], DEFAULT_SETTINGS, snipSample());
    assert.equal(inline.length, 0); // ambiguous snippet + out-of-bounds line → not anchored inline
    assert.equal(unanchored.length, 1); // but still surfaced in the body — not dropped
  });

  it("caps inline comments at maxInlineComments including zero", () => {
    const many = [FINDING_412, { ...FINDING_412, id: "b", severity: "P2" as const }];
    assert.equal(publishableFindings(many, { ...DEFAULT_SETTINGS, maxInlineComments: 0 }, SAMPLE_PRS["pay-412"]).length, 0);
    assert.equal(publishableFindings(many, { ...DEFAULT_SETTINGS, maxInlineComments: 1 }, SAMPLE_PRS["pay-412"]).length, 1);
  });
});

describe("gateLiveSubmission", () => {
  it("coerces APPROVE with remaining P0/P1 to REQUEST_CHANGES", () => {
    const gate = gateLiveSubmission(
      {
        merge_recommendation: "APPROVE",
        findings: [
          {
            severity: "P1",
            file: FINDING_412.file,
            line: FINDING_412.line,
            title: FINDING_412.title,
            failure_scenario: FINDING_412.failureScenario,
            root_cause: FINDING_412.rootCause,
            evidence: FINDING_412.evidence,
            recommended_fix: FINDING_412.recommendedFix,
            recommended_test: FINDING_412.recommendedTest,
          },
        ],
      },
      SAMPLE_PRS["pay-412"],
      DEFAULT_SETTINGS,
    );
    assert.equal(gate.ok, true);
    if (gate.ok) {
      assert.equal(gate.mergeRecommendation, "REQUEST_CHANGES");
      assert.equal(gate.findings.length, 1);
      assert.ok(gate.dropped.some((d) => /APPROVE/.test(d)));
    }
  });

  it("drops phantom files and hedges", () => {
    const gate = gateLiveSubmission(
      {
        merge_recommendation: "REQUEST_CHANGES",
        findings: [
          {
            severity: "P0",
            file: "does/not/exist.ts",
            line: 1,
            title: "consider renaming this, it might be wrong",
            failure_scenario: "could be bad",
            root_cause: "style",
            evidence: "none",
            recommended_fix: "maybe refactor",
            recommended_test: "none",
          },
        ],
      },
      SAMPLE_PRS["pay-412"],
      DEFAULT_SETTINGS,
    );
    assert.equal(gate.ok, true);
    if (gate.ok) {
      assert.equal(gate.findings.length, 0);
      assert.equal(gate.mergeRecommendation, "COMMENT");
    }
  });

  it("rejects empty findings that never inspected the snapshot", () => {
    const gate = gateLiveSubmission(
      { merge_recommendation: "COMMENT", findings: [] },
      SAMPLE_PRS["pay-412"],
      DEFAULT_SETTINGS,
    );
    assert.equal(gate.ok, false);
  });

  it("keeps the #421 auth finding and never approves", () => {
    const gate = gateLiveSubmission(
      {
        merge_recommendation: "APPROVE",
        findings: [
          {
            severity: FINDING_421.severity,
            file: FINDING_421.file,
            line: FINDING_421.line,
            title: FINDING_421.title,
            failure_scenario: FINDING_421.failureScenario,
            root_cause: FINDING_421.rootCause,
            evidence: FINDING_421.evidence,
            recommended_fix: FINDING_421.recommendedFix,
            recommended_test: FINDING_421.recommendedTest,
          },
        ],
      },
      SAMPLE_PRS["pay-421"],
      DEFAULT_SETTINGS,
    );
    assert.equal(gate.ok, true);
    if (gate.ok) {
      assert.equal(gate.findings.length, 1);
      assert.equal(gate.mergeRecommendation, "REQUEST_CHANGES");
    }
  });
});

describe("schemaMergeProviderGates", () => {
  it("schema-merges one-sided findings when LLM merge is unavailable", () => {
    const left = {
      ok: true as const,
      findings: [{ ...FINDING_412, id: "a" }],
      mergeRecommendation: "REQUEST_CHANGES" as const,
      highestRisk: FINDING_412.title,
      investigatedSafe: ["checked auth"],
      assumptions: [],
      dropped: [],
    };
    const right = {
      ok: true as const,
      findings: [{ ...FINDING_421, id: "b", file: "src/auth/session.ts" }],
      mergeRecommendation: "REQUEST_CHANGES" as const,
      highestRisk: FINDING_421.title,
      investigatedSafe: [],
      assumptions: [],
      dropped: [],
    };
    const merged = schemaMergeProviderGates(
      [
        { provider: "chatgpt", gate: left },
        { provider: "grok", gate: right },
      ],
      DEFAULT_SETTINGS,
    );
    assert.equal(merged.findings.length, 2);
    assert.ok(merged.assumptions.some((a) => a.includes("Schema-merged")));
    assert.match(SCHEMA_MERGE_NOTE, /Schema-merged/);
  });
});

describe("merged finding ids are unique (they key the loop's thread replies)", () => {
  it("two providers' own live-0 findings on different lines keep distinct ids", () => {
    const gate = (f: typeof FINDING_412) => ({
      ok: true as const,
      findings: [{ ...f, id: "live-0" }],
      mergeRecommendation: "REQUEST_CHANGES" as const,
      highestRisk: f.title,
      investigatedSafe: [],
      assumptions: [],
      dropped: [],
    });
    const merged = schemaMergeProviderGates(
      [
        { provider: "local", gate: gate(FINDING_412) },
        { provider: "chatgpt", gate: gate({ ...FINDING_421, file: "src/auth/session.ts" }) },
      ],
      DEFAULT_SETTINGS,
    );
    assert.equal(merged.findings.length, 2);
    assert.deepEqual(merged.findings.map((f) => f.id), ["live-0", "live-0~2"]);
  });
});

describe("consensusFromGates", () => {
  it("keeps a finding both reviewers reported", () => {
    const shared = { ...FINDING_412, id: "a" };
    const left = {
      ok: true as const,
      findings: [shared],
      mergeRecommendation: "REQUEST_CHANGES" as const,
      highestRisk: shared.title,
      investigatedSafe: [],
      assumptions: [],
      dropped: [],
    };
    const right = {
      ...left,
      findings: [{ ...shared, id: "b", line: shared.line, title: "Webhook can capture twice on Stripe retry" }],
    };
    const out = consensusFromGates([left, right], DEFAULT_SETTINGS);
    assert.equal(out.findings.length, 1);
    assert.equal(out.mergeRecommendation, "REQUEST_CHANGES");
  });

  it("does not drop a one-sided finding until a peer check rejects it", () => {
    const left = {
      ok: true as const,
      findings: [{ ...FINDING_412, id: "a" }],
      mergeRecommendation: "REQUEST_CHANGES" as const,
      highestRisk: FINDING_412.title,
      investigatedSafe: [],
      assumptions: [],
      dropped: [],
    };
    const right = {
      ok: true as const,
      findings: [{ ...FINDING_421, id: "b", file: "src/auth/session.ts" }],
      mergeRecommendation: "REQUEST_CHANGES" as const,
      highestRisk: FINDING_421.title,
      investigatedSafe: [],
      assumptions: [],
      dropped: [],
    };
    const part = partitionConsensus(left, right);
    assert.equal(part.agreed.length, 0);
    assert.equal(part.chatgptOnly.length, 1);
    assert.equal(part.grokOnly.length, 1);
    const kept = applyPeerReview(part, { chatgpt: null, grok: null }, DEFAULT_SETTINGS);
    assert.equal(kept.findings.length, 2);
    const rejected = applyPeerReview(
      part,
      {
        chatgpt: {
          keep: [],
          drop: [{ file: "src/auth/session.ts", line: FINDING_421.line, title: FINDING_421.title, reason: "fp" }],
        },
        grok: { keep: [FINDING_412], drop: [] },
      },
      DEFAULT_SETTINGS,
    );
    assert.equal(rejected.findings.length, 1);
    assert.equal(rejected.findings[0].title, FINDING_412.title);
    assert.ok(rejected.dropped.some((d) => d.includes("rejected")));
  });

  it("matches the same file+title even if the line is off by one", () => {
    assert.equal(
      findingsAgree(
        { ...FINDING_412, line: 10 },
        { ...FINDING_412, id: "x", line: 11, title: FINDING_412.title },
      ),
      true,
    );
  });

  it("treats two-of-three as agreed and sends the rest down the order", () => {
    const gate = (finding: typeof FINDING_412, extra: Partial<typeof FINDING_412> = {}) => ({
      ok: true as const,
      findings: [{ ...finding, ...extra }],
      mergeRecommendation: "REQUEST_CHANGES" as const,
      highestRisk: finding.title,
      investigatedSafe: [],
      assumptions: [],
      dropped: [],
    });
    const part = partitionMany([
      { provider: "local", gate: gate(FINDING_412) },
      { provider: "chatgpt", gate: gate(FINDING_412, { id: "c" }) },
      { provider: "grok", gate: gate(FINDING_421, { id: "g", file: "src/auth/session.ts" }) },
    ]);
    assert.equal(part.agreed.length, 1);
    assert.equal(part.unique.grok?.length, 1);
    const disputed = disputedFromUnique(part.unique);
    const afterLocal = applyFpStep({ agreed: part.agreed, disputed }, "local", {
      keep: [],
      drop: [{ file: "src/auth/session.ts", line: FINDING_421.line, title: FINDING_421.title, reason: "fp" }],
    });
    assert.equal(afterLocal.agreed.length, 1);
    assert.equal(afterLocal.disputed.length, 0);
    assert.ok(afterLocal.dropped.some((d) => d.includes("rejected")));
  });
});

describe("gateLiveSubmission coverage", () => {
  const sample = SAMPLE_PRS["pay-412"];
  const okBase = { merge_recommendation: "COMMENT", findings: [] as unknown[], investigated_safe: ["all changed files reviewed"] };

  it("defaults to [] when coverage is absent or not an array", () => {
    const g1 = gateLiveSubmission(okBase, sample, DEFAULT_SETTINGS);
    assert.ok(g1.ok);
    if (!g1.ok) return;
    assert.deepEqual(g1.coverage, []);
    const g2 = gateLiveSubmission({ ...okBase, coverage: "nope" }, sample, DEFAULT_SETTINGS);
    assert.ok(g2.ok);
    if (!g2.ok) return;
    assert.deepEqual(g2.coverage, []);
  });

  it("parses entries and coerces an unknown status to not_cleared", () => {
    const g = gateLiveSubmission(
      { ...okBase, coverage: [{ file: "src/ledger.ts", status: "cleared", reason: "ok" }, { file: "src/payment/webhook.ts", status: "weird" }] },
      sample,
      DEFAULT_SETTINGS,
    );
    assert.ok(g.ok);
    if (!g.ok) return;
    assert.equal(g.coverage?.length, 2);
    assert.equal(g.coverage?.find((c) => c.file === "src/payment/webhook.ts")?.status, "not_cleared");
  });

  it("never changes the verdict: coverage with zero findings stays a clean pass", () => {
    const g = gateLiveSubmission({ ...okBase, coverage: [{ file: "src/ledger.ts", status: "not_cleared", reason: "x" }] }, sample, DEFAULT_SETTINGS);
    assert.ok(g.ok);
    if (!g.ok) return;
    assert.equal(g.findings.length, 0);
  });

  it("widens investigated_safe/assumptions truncation to 400 chars x 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => `${i}-${"z".repeat(500)}`);
    const g = gateLiveSubmission({ ...okBase, investigated_safe: many, assumptions: many }, sample, DEFAULT_SETTINGS);
    assert.ok(g.ok);
    if (!g.ok) return;
    assert.equal(g.investigatedSafe.length, 12);
    assert.ok(g.investigatedSafe.every((s) => s.length <= 400));
    assert.equal(g.assumptions.length, 12);
  });
});

