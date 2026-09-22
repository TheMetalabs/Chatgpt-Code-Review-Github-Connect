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
  sameDirective,
  stripLoopDirectives,
  type EscalateReason,
} from "./review-loop.ts";

const BOT = { authoredByBot: true } as const;
const USER = { authoredByBot: false } as const;

describe("parseReviewLoopDirective", () => {
  it("recognizes the slash and mention start forms as suggest mode", () => {
    for (const body of ["/review-loop", "please /review-loop", "@ashlar-bot review-loop", "@ashlar review-loop"]) {
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

  it("rejects glued suffixes on the token (no word boundary bypass)", () => {
    for (const body of ["/review-loopx", "/review-looping", "/review-loop-stop", "@ashlar-bot review-loopx"]) {
      assert.equal(parseReviewLoopDirective(body), null, body);
    }
  });

  it("rejects a hyphen-suffixed option (only the exact apply/stop token is valid)", () => {
    for (const body of ["/review-loop apply-later", "@ashlar-bot review-loop stop-now", "/review-loop apply_later"]) {
      assert.equal(parseReviewLoopDirective(body), null, body);
    }
    assert.deepEqual(parseReviewLoopDirective("/review-loop apply"), { kind: "start", mode: "apply" });
  });

  it("returns a later valid directive even if an earlier occurrence is invalid", () => {
    assert.deepEqual(parseReviewLoopDirective("don't /review-loop yet\n/review-loop apply"), { kind: "start", mode: "apply" });
    assert.deepEqual(parseReviewLoopDirective("nope /review-loop maybe\n/review-loop"), { kind: "start", mode: "suggest" });
    assert.deepEqual(parseReviewLoopDirective("skip /review-loop later\n/review-loop stop"), { kind: "stop" });
  });

  it("rejects an unrecognized word right after the token (typo'd control word, mid-prose)", () => {
    assert.equal(parseReviewLoopDirective("/review-loop stopx"), null); // typo'd stop must not run a review
    assert.equal(parseReviewLoopDirective("/review-loop now"), null);
    assert.equal(parseReviewLoopDirective("don't /review-loop yet"), null);
    // a newline-separated tail is fine — the token stands alone on its line
    assert.deepEqual(parseReviewLoopDirective("/review-loop\nthanks"), { kind: "start", mode: "suggest" });
    assert.deepEqual(parseReviewLoopDirective("/review-loop apply please"), { kind: "start", mode: "apply" });
  });
});

describe("stripLoopDirectives", () => {
  it("removes loop directive spans, leaving an independent mention detectable", () => {
    // the mention IS the directive -> nothing independent remains
    assert.equal(/@ashlar-bot\b/.test(stripLoopDirectives("@ashlar-bot review-loop stop")), false);
    // an independent @ashlar-bot review survives the strip of a trailing /review-loop stop
    assert.equal(/@ashlar-bot review\b/.test(stripLoopDirectives("@ashlar-bot review — then /review-loop stop")), true);
  });
});

describe("sameDirective", () => {
  it("compares kind and start mode; null only equals null", () => {
    assert.equal(sameDirective({ kind: "start", mode: "suggest" }, { kind: "start", mode: "suggest" }), true);
    assert.equal(sameDirective({ kind: "start", mode: "suggest" }, { kind: "start", mode: "apply" }), false);
    assert.equal(sameDirective({ kind: "stop" }, { kind: "stop" }), true);
    assert.equal(sameDirective({ kind: "start", mode: "suggest" }, { kind: "stop" }), false);
    assert.equal(sameDirective(null, null), true);
    assert.equal(sameDirective(null, { kind: "stop" }), false);
  });
});

describe("parseReviewLoopDirective is not stateful across calls", () => {
  it("returns the same result on repeated calls (global regex lastIndex reset)", () => {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(parseReviewLoopDirective("/review-loop apply"), { kind: "start", mode: "apply" });
      assert.equal(parseReviewLoopDirective("/review-loopx"), null);
    }
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
    assert.equal(isStoppedComment(body, BOT), true);
    assert.equal(isStoppedComment("nothing here", BOT), false);
    // A user who posts the literal must NOT be able to spoof a stop (untrusted source).
    assert.equal(isStoppedComment(body, USER), false);
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
    const parsed = parseEscalateMarker(marker, BOT);
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
    assert.ok(isEscalateComment(body, BOT));
    assert.ok(body.includes(REVIEW_LOOP_ESCALATE_HUMAN));
    assert.ok(body.includes("(round 3/10)"));
    assert.ok(body.includes(ESCALATE_DIRECTIVE["whack-a-mole"]));
    assert.ok(body.includes("R1=4 R2=4 R3=5 (increasing)"));
    assert.ok(body.includes("src/lib/harbor.server.ts"));
    // The re-derive-from-API commands are baked in so a stale narrative can't mislead.
    assert.ok(body.includes("gh pr view 42 --repo TheMetalabs/Chatgpt-Code-Review-Github-Connect"));
    assert.ok(body.includes("audit-unaddressed.py 42 --head deadbee"));
    const parsed = parseEscalateMarker(body, BOT);
    assert.equal(parsed?.reason, "whack-a-mole");
    assert.equal(parsed?.round, 3);
  });

  it("tolerates missing optional state fields", () => {
    const body = escalateComment({ reason: "round-cap", round: 10, roundCap: 10, pr: 1, head: "abc", repo: "a/b" });
    assert.ok(isEscalateComment(body, BOT));
    assert.ok(body.includes("(unknown)"));
    assert.ok(body.includes("(none)"));
  });

  it("parseEscalateMarker rejects non-markers, malformed markers, and unknown reasons", () => {
    assert.equal(parseEscalateMarker("no marker", BOT), null);
    assert.equal(parseEscalateMarker("<!-- ashlar-loop-escalate round=1 -->", BOT), null); // missing reason/head
    // an unknown/tampered reason must not parse (would index ESCALATE_DIRECTIVE as undefined)
    assert.equal(parseEscalateMarker("<!-- ashlar-loop-escalate reason=malicious round=1 pr=1 head=abc -->", BOT), null);
    // untrusted source never parses, even with a well-formed marker
    assert.equal(parseEscalateMarker("<!-- ashlar-loop-escalate reason=oscillation round=1 pr=1 head=abc -->", USER), null);
  });
});

describe("isZeroFindings (CONVERGED machine side)", () => {
  it("matches the total=0 findings marker only", () => {
    assert.equal(isZeroFindings("<!-- ashlar-findings total=0 inline=0 body=0 p0=0 p1=0 p2=0 -->", BOT), true);
    assert.equal(isZeroFindings("<!-- ashlar-findings total=3 inline=3 body=0 -->", BOT), false);
    assert.equal(isZeroFindings("<!-- ashlar-findings total=10 -->", BOT), false);
    assert.equal(isZeroFindings("", BOT), false);
    // a user-authored comment carrying the marker is not a convergence signal
    assert.equal(isZeroFindings("<!-- ashlar-findings total=0 -->", USER), false);
  });
});
