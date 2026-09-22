import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseReviewLoopDirective,
  escalateComment,
  escalateMarker,
  parseEscalateMarker,
  isEscalateComment,
  isStoppedComment,
  stoppedComment,
  isZeroFindings,
  ESCALATE_DIRECTIVE,
  REVIEW_LOOP_ESCALATE_HUMAN,
  REVIEW_LOOP_STOPPED_HUMAN,
  STOPPED_MARKER,
  type EscalateReason,
} from "./review-loop.ts";

describe("parseReviewLoopDirective", () => {
  it("recognizes the slash and mention start forms as suggest mode", () => {
    for (const body of ["/review-loop", "please /review-loop now", "@ashlar-bot review-loop", "@ashlar review-loop"]) {
      assert.deepEqual(parseReviewLoopDirective(body), { kind: "start", mode: "suggest" }, body);
    }
  });

  it("recognizes apply and stop options", () => {
    assert.deepEqual(parseReviewLoopDirective("/review-loop apply"), { kind: "start", mode: "apply" });
    assert.deepEqual(parseReviewLoopDirective("@ashlar-bot review-loop apply"), { kind: "start", mode: "apply" });
    assert.deepEqual(parseReviewLoopDirective("/review-loop stop"), { kind: "stop" });
  });

  it("is case-insensitive and tolerates trailing text", () => {
    assert.deepEqual(parseReviewLoopDirective("/REVIEW-LOOP APPLY please"), { kind: "start", mode: "apply" });
  });

  it("does not match plain /review or unrelated text", () => {
    assert.equal(parseReviewLoopDirective("/review"), null);
    assert.equal(parseReviewLoopDirective("@ashlar-bot review"), null);
    assert.equal(parseReviewLoopDirective("looks good, no review-loops here in prose"), null);
    assert.equal(parseReviewLoopDirective(""), null);
    assert.equal(parseReviewLoopDirective(undefined), null);
  });

  it("does not treat /review as a loop trigger even though it is a substring", () => {
    // `/review-loop` must be matched by the loop parser, `/review` must fall through to the plain parser.
    assert.equal(parseReviewLoopDirective("/review the code"), null);
  });
});

describe("terminal signals are fixed literals", () => {
  it("keeps the human sentences immutable (detection contract)", () => {
    assert.equal(REVIEW_LOOP_ESCALATE_HUMAN, "Ashlar review-loop halted — human review required");
    assert.equal(REVIEW_LOOP_STOPPED_HUMAN, "Ashlar review-loop stopped by operator");
    assert.equal(STOPPED_MARKER, "<!-- ashlar-loop-stopped -->");
  });

  it("stoppedComment carries both the marker and the immutable sentence", () => {
    const body = stoppedComment();
    assert.ok(body.includes(STOPPED_MARKER));
    assert.ok(body.includes(REVIEW_LOOP_STOPPED_HUMAN));
    assert.equal(isStoppedComment(body), true);
    assert.equal(isStoppedComment("nothing here"), false);
  });

  it("has a directive for every escalate reason", () => {
    const reasons: EscalateReason[] = [
      "whack-a-mole",
      "guard-accretion",
      "oscillation",
      "wrong-scope",
      "re-flag-deferred",
      "diff-too-large",
      "round-cap",
    ];
    for (const r of reasons) {
      assert.ok(ESCALATE_DIRECTIVE[r] && ESCALATE_DIRECTIVE[r].length > 0, r);
    }
  });
});

describe("escalate marker + composer", () => {
  it("emits a machine marker whose attributes round-trip", () => {
    const marker = escalateMarker({ reason: "oscillation", round: 6, pr: 63, head: "20c85f6" });
    assert.equal(marker, "<!-- ashlar-loop-escalate reason=oscillation round=6 pr=63 head=20c85f6 -->");
    const parsed = parseEscalateMarker(marker);
    assert.deepEqual(parsed, { reason: "oscillation", round: 6, pr: 63, head: "20c85f6" });
  });

  it("full comment is deterministic: fixed sentence + directive + re-derive commands", () => {
    const body = escalateComment({
      reason: "whack-a-mole",
      round: 3,
      roundCap: 10,
      pr: 42,
      head: "deadbee",
      repo: "TheMetalabs/Chatgpt-Code-Review-Github-Connect",
      findingTrend: [4, 4, 5],
      repeatedFiles: ["src/lib/harbor.server.ts"],
      reviewedCommitInHead: true,
      unaddressed: 2,
      dirty: false,
      ciState: "green",
      diffLines: 320,
      ledger: { declines: 1, defers: 2, pushbacks: 0 },
    });
    assert.ok(isEscalateComment(body));
    assert.ok(body.includes(REVIEW_LOOP_ESCALATE_HUMAN));
    assert.ok(body.includes("(round 3/10)"));
    assert.ok(body.includes(ESCALATE_DIRECTIVE["whack-a-mole"]));
    assert.ok(body.includes("R1=4 R2=4 R3=5 (increasing)"));
    assert.ok(body.includes("src/lib/harbor.server.ts"));
    // The re-derive-from-API commands are baked in so a stale narrative can't mislead.
    assert.ok(body.includes("gh pr view 42 --repo TheMetalabs/Chatgpt-Code-Review-Github-Connect"));
    assert.ok(body.includes("audit-unaddressed.py 42 --head deadbee"));
    const parsed = parseEscalateMarker(body);
    assert.equal(parsed?.reason, "whack-a-mole");
    assert.equal(parsed?.round, 3);
  });

  it("tolerates missing optional state fields", () => {
    const body = escalateComment({ reason: "round-cap", round: 10, roundCap: 10, pr: 1, head: "abc", repo: "a/b" });
    assert.ok(isEscalateComment(body));
    assert.ok(body.includes("(unknown)"));
    assert.ok(body.includes("(none)"));
  });

  it("parseEscalateMarker rejects non-markers and malformed markers", () => {
    assert.equal(parseEscalateMarker("no marker"), null);
    assert.equal(parseEscalateMarker("<!-- ashlar-loop-escalate round=1 -->"), null); // missing reason/head
  });
});

describe("isZeroFindings (CONVERGED machine side)", () => {
  it("matches the total=0 findings marker only", () => {
    assert.equal(isZeroFindings("<!-- ashlar-findings total=0 inline=0 body=0 p0=0 p1=0 p2=0 -->"), true);
    assert.equal(isZeroFindings("<!-- ashlar-findings total=3 inline=3 body=0 -->"), false);
    assert.equal(isZeroFindings("<!-- ashlar-findings total=10 -->"), false);
    assert.equal(isZeroFindings(""), false);
  });
});
