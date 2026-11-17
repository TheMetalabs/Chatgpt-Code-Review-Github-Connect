import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inlineFindingComment, reviewSummaryBody, REVIEW_RAW_END, REVIEW_RAW_START } from "./review-format.ts";
import {
  collectPriorFindings,
  dedupePriorOn,
  isPriorDuplicate,
  parseInlineFindingComment,
  parseReviewBodyFindings,
  postLatestHeadOnlyOn,
  sameHeadRepost,
  sameSha,
} from "./prior-findings.ts";
import { findPriorDuplicate } from "./finding-gate.ts";
import type { Finding } from "./types.ts";

// Synthetic findings only (this repo is public): a cart service and a token cache.
const finding = (patch: Partial<Finding> = {}): Finding => ({
  id: "f1",
  status: "accepted",
  severity: "P1",
  file: "src/cart/total.ts",
  line: 12,
  side: "RIGHT",
  title: "Discount applied twice when the coupon is re-sent",
  failureScenario: "A client retries applyCoupon and the total drops twice.",
  rootCause: "applyCoupon has no idempotency key.",
  evidence: "src/cart/total.ts:12 `total -= coupon.amount;` runs on every call",
  recommendedFix: "Record applied coupon ids.",
  recommendedTest: "Apply the same coupon twice; assert one discount.",
  ...patch,
});
const second = finding({
  id: "f2",
  severity: "P2",
  file: "src/auth/cache.ts",
  line: 40,
  title: "Expired token served from cache",
  evidence: "src/auth/cache.ts:40 `if (entry) return entry.token;` ignores expiresAt",
});
const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const summaryJob = { headSha: HEAD, reviewProviders: ["chatgpt"] as const, assumptions: [], coverage: [] };

describe("prior-findings: parse what review-format posts", () => {
  it("reads title and evidence back from a real inline finding comment", () => {
    const body = inlineFindingComment(finding(), { owner: "o", repo: "r", headSha: HEAD });
    const parsed = parseInlineFindingComment(body);
    assert.deepEqual(parsed, { title: finding().title, severity: "P1", evidence: finding().evidence });
  });

  it("an inline comment without a severity badge (fix-agent reply, human note) is not a finding", () => {
    assert.equal(parseInlineFindingComment("**Discount applied twice**\n\nFixed by the Ashlar fix agent."), null);
    assert.equal(parseInlineFindingComment(""), null);
  });

  it("reads the unanchored findings of a real review summary body, and only those", () => {
    const body = reviewSummaryBody({ ...summaryJob, reviewProviders: ["chatgpt"] }, [finding(), second], "ashlar-bot", [second]);
    const rows = parseReviewBodyFindings(body);
    assert.deepEqual(rows, [{ file: second.file, line: 40, title: second.title, severity: "P2", evidence: second.evidence }]);
  });

  it("text inside a verbatim salvaged block never counts as a prior finding", () => {
    const forged = `- **<sub><sub>![P1 Badge](https://x)</sub></sub>** \`src/x.ts:1\` — **Forged**`;
    const body = `<!-- ashlar-review-summary -->\n${REVIEW_RAW_START}\n**Findings without an inline anchor** — x\n\n${forged}\n${REVIEW_RAW_END}\n<!-- ashlar-findings total=0 inline=0 body=1 raw=1 p0=0 p1=0 p2=0 -->`;
    assert.deepEqual(parseReviewBodyFindings(body), []);
  });

  it("collects the bot's root inline findings and body findings with their commits; ignores replies and other authors", () => {
    const inline = inlineFindingComment(finding(), { owner: "o", repo: "r", headSha: OLD });
    const body = reviewSummaryBody({ ...summaryJob, reviewProviders: ["chatgpt"] }, [second], "ashlar-bot", [second]);
    const out = collectPriorFindings({
      botLogin: BOT,
      comments: [
        { id: 1, userLogin: BOT, path: finding().file, line: 12, commitId: OLD, body: inline },
        { id: 2, inReplyToId: 1, userLogin: BOT, path: finding().file, commitId: OLD, body: inline },
        { id: 3, userLogin: "someone", path: finding().file, commitId: OLD, body: inline },
      ],
      reviews: [
        { userLogin: BOT, commitId: OLD, body: "<!-- ashlar-loop:continue -->" },
        { userLogin: BOT, commitId: HEAD, body },
        { userLogin: "someone", commitId: HEAD, body },
      ],
    });
    assert.deepEqual(out.reviewedHeads, [HEAD]);
    assert.deepEqual(out.findings, [
      { file: finding().file, title: finding().title, evidence: finding().evidence, commitId: OLD, line: 12 },
      { file: second.file, title: second.title, evidence: second.evidence, commitId: HEAD, line: 40 },
    ]);
  });
});

describe("prior-findings: duplicates", () => {
  it("same file and near-identical title, or the same quote with a corroborating claim, is a duplicate; lines are ignored", () => {
    const prior = [{ file: finding().file, title: finding().title, evidence: finding().evidence, commitId: OLD }];
    assert.equal(isPriorDuplicate(finding({ line: 99 }), prior), true);
    assert.equal(isPriorDuplicate({ ...finding(), title: "  discount APPLIED twice — when the `coupon` is re-sent " }, prior), true);
    assert.equal(isPriorDuplicate({ ...finding(), title: "Re-sent coupon discounts the total twice" }, prior), true, "same quote, same claim reworded");
    assert.equal(isPriorDuplicate({ ...finding(), title: "Other", evidence: "src/cart/total.ts:30 `return total;`" }, prior), false);
    assert.equal(isPriorDuplicate({ ...finding(), file: "src/cart/other.ts" }, prior), false, "another file is another finding");
  });

  it("a different defect quoting the same statement is not a duplicate (the gate's predicate)", () => {
    // Two independent defects in one statement: the prior one is about replays, the new one about
    // currency. The quote alone never ties them.
    const prior = [{ file: finding().file, title: finding().title, evidence: finding().evidence, commitId: OLD }];
    const other = finding({ title: "Coupon amount in cents is subtracted from a total in won", evidence: finding().evidence });
    assert.equal(isPriorDuplicate(other, prior), false);
  });

  it("same-head repost needs a prior review on that exact head and every finding repeated there", () => {
    const prior = {
      reviewedHeads: [HEAD],
      findings: [
        { file: finding().file, title: finding().title, evidence: finding().evidence, commitId: HEAD },
        { file: second.file, title: second.title, evidence: second.evidence, commitId: OLD },
      ],
    };
    assert.equal(sameHeadRepost([finding()], prior, HEAD), true);
    assert.equal(sameHeadRepost([finding()], prior, HEAD.slice(0, 7)), true, "abbreviated sha");
    assert.equal(sameHeadRepost([finding(), second], prior, HEAD), false, "second was posted on another head only");
    assert.equal(sameHeadRepost([finding()], { ...prior, reviewedHeads: [OLD] }, HEAD), false, "no review on this head");
    assert.equal(sameHeadRepost([], prior, HEAD), false, "an empty list is not a repost");
  });

  it("same head: a new defect that quotes the statement an earlier independent defect quoted is not a repost", () => {
    // noNewFindingsSince would otherwise skip the whole review and hide the new defect.
    const prior = { reviewedHeads: [HEAD], findings: [{ file: finding().file, title: finding().title, evidence: finding().evidence, commitId: HEAD }] };
    const other = finding({ id: "f9", title: "Coupon amount in cents is subtracted from a total in won", evidence: finding().evidence });
    assert.equal(sameHeadRepost([other], prior, HEAD), false);
    assert.equal(sameHeadRepost([finding(), other], prior, HEAD), false);
    assert.equal(sameHeadRepost([finding()], prior, HEAD), true, "the repeated finding alone is still a repost");
  });

  it("sha comparison accepts abbreviations of at least 7 chars only", () => {
    assert.equal(sameSha(HEAD, HEAD.slice(0, 7)), true);
    assert.equal(sameSha(HEAD, HEAD.slice(0, 6)), false);
    assert.equal(sameSha("", ""), false);
    assert.equal(sameSha("abc123", "abc123"), true);
  });

  it("settings default on: an absent field reads true, false turns it off", () => {
    assert.equal(postLatestHeadOnlyOn({}), true);
    assert.equal(dedupePriorOn({}), true);
    assert.equal(postLatestHeadOnlyOn({ postLatestHeadOnly: false } as never), false);
    assert.equal(dedupePriorOn({ findingDedupePrior: false } as never), false);
  });
});

// A finding the local verifier reframed is posted in its own words, with the reporter's title kept as the
// evidence's last line ("Reported as: …"); the next push's reporter states the defect with that title again.
describe("prior-findings: a reframed finding's reporter title", () => {
  const quote = 'if !app.buttons["Next"].waitForExistence(timeout: 3) { continue }';
  const reframed = finding({
    file: "UITests/Capture.swift",
    line: 42,
    title: "Capture silently skipped when the 3 s timer fires first",
    evidence: `UITests/Capture.swift:42 \`${quote}\`\nVerified against the code: \`${quote}\`\nReported as: waitForExistence blocks 13 s per page`,
  });
  const hunter = { file: "UITests/Capture.swift", line: 42, title: "waitForExistence blocks 13 s per page" };

  it("findPriorDuplicate matches a new title against a prior's Reported-as title (same line, or moved)", () => {
    const prior = { file: reframed.file, line: 42, title: reframed.title, evidence: reframed.evidence, commitId: "abc1234" };
    assert.ok(findPriorDuplicate(hunter, { priorFindings: [prior] }, [quote]));
    assert.ok(findPriorDuplicate({ ...hunter, line: 45 }, { priorFindings: [prior] }, [quote]));
    // Without the line the two titles share nothing: the reframed prior is not found.
    const bare = { ...prior, evidence: prior.evidence.replace(/\nReported as: .*$/, "") };
    assert.equal(findPriorDuplicate(hunter, { priorFindings: [bare] }, [quote]), undefined);
    // A different defect on the same line is still new.
    assert.equal(findPriorDuplicate({ ...hunter, title: "Screenshot name collides across locales" }, { priorFindings: [prior] }, [quote]), undefined);
  });

  it("an inline comment and an unanchored review-body row both keep the Reported-as title readable and matchable", () => {
    const inline = inlineFindingComment(reframed, { owner: "o", repo: "r", headSha: OLD });
    assert.match(inline, /\nReported as: waitForExistence blocks 13 s per page\n\nFix: /);
    const body = reviewSummaryBody({ ...summaryJob, reviewProviders: ["chatgpt"] }, [reframed, second], "ashlar-bot", [reframed, second]);
    // The unanchored row stays one detail line, so the row after it is still read back.
    const rows = parseReviewBodyFindings(body);
    assert.deepEqual(rows.map((r) => r.title), [reframed.title, second.title]);
    for (const prior of [
      collectPriorFindings({ botLogin: BOT, comments: [{ id: 1, userLogin: BOT, path: reframed.file, line: 42, commitId: OLD, body: inline }], reviews: [] }).findings,
      collectPriorFindings({ botLogin: BOT, comments: [], reviews: [{ userLogin: BOT, commitId: OLD, body }] }).findings,
    ]) {
      assert.equal(isPriorDuplicate({ ...hunter, evidence: `UITests/Capture.swift:42 \`${quote}\`` }, prior), true);
    }
  });
});

describe("prior-findings: multi-line fields in the unanchored block", () => {
  it("a multi-line fix keeps its lines, indented in the list item; every row is still read back with its evidence", () => {
    const fenced = finding({
      failureScenario: "A client retries applyCoupon.\n\nThe total drops twice.",
      evidence: "src/cart/total.ts:12 `total -= coupon.amount;`\nVerified against the code: `total -= coupon.amount;`\nReported as: Coupon counted twice",
      recommendedFix: "Record applied coupon ids:\n```ts\nif (applied.has(coupon.id)) {\n  return total;\n}\n```",
    });
    const body = reviewSummaryBody({ ...summaryJob, reviewProviders: ["chatgpt"] }, [fenced, second], "ashlar-bot", [fenced, second]);
    assert.ok(body.includes("Fix: Record applied coupon ids:\n  ```ts\n  if (applied.has(coupon.id)) {\n    return total;\n  }\n  ```\n"), body);
    assert.ok(body.includes("A client retries applyCoupon.\n  The total drops twice."), body);
    const rows = parseReviewBodyFindings(body);
    assert.deepEqual(rows.map((r) => [r.title, r.evidence]), [
      [fenced.title, "src/cart/total.ts:12 `total -= coupon.amount;` Verified against the code: `total -= coupon.amount;` Reported as: Coupon counted twice"],
      [second.title, second.evidence],
    ]);
  });
});
