import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReviewPolicy, isSafeRepoPath, policyPathsFor, snapshotFileRef } from "./github-snapshot.ts";

describe("github snapshot refs", () => {
  it("includes root + nested AGENTS.md and code_review.md as base-read policy", () => {
    const policy = policyPathsFor(["src/payment/webhook.ts"]);
    // Root AGENTS.md is now policy at the path level; sandbox content is filtered
    // separately by isSandboxPolicyFile at fetch time.
    assert.ok(policy.includes("AGENTS.md"));
    assert.ok(policy.includes("code_review.md"));
    assert.ok(policy.includes("src/payment/AGENTS.md"));
    assert.equal(snapshotFileRef("code_review.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/payment/AGENTS.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("AGENTS.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/payment/webhook.ts", policy, "base", "head"), "head");
  });

  it("reads root AGENTS.md from base as policy even when the PR changes it", () => {
    const policy = policyPathsFor(["AGENTS.md", "src/invoices/routes.ts"]);
    assert.equal(snapshotFileRef("AGENTS.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/invoices/routes.ts", policy, "base", "head"), "head");
  });

  it("extractReviewPolicy keeps the whole policy file when it fits (domain contracts survive)", () => {
    // Regression: the old behavior sliced to the review-rules heading and dropped the domain
    // sections above it. A reviewer must see domain invariants/contracts, not only "Code Review".
    const md = "# Repo\n\n## Domain\n\n- invariant X\n\n## Code Review Rules\n\n- rule A\n\n## Other\n\ndetail";
    const out = extractReviewPolicy(md);
    assert.match(out, /invariant X/); // domain section is no longer dropped
    assert.match(out, /Code Review Rules/);
    assert.match(out, /rule A/);
    assert.match(out, /detail/);
  });

  it("extractReviewPolicy caps oversized files at 32 KiB but keeps the review-rules section", () => {
    assert.equal(extractReviewPolicy("x".repeat(40_000)).length, 32 * 1024); // no heading → first 32 KiB
    // Oversized file whose review-rules section sits PAST the 32 KiB mark: the section is still kept,
    // and the top of the file (where domain contracts live) is retained too.
    const md = "top domain contract\n" + "y".repeat(40_000) + "\n## Code Review Rules\n- keep this rule\n";
    const out = extractReviewPolicy(md);
    assert.ok(out.length <= 32 * 1024);
    assert.match(out, /keep this rule/);
    assert.match(out, /top domain contract/);
  });

  it("rejects path traversal", () => {
    assert.equal(isSafeRepoPath("../secrets"), false);
    assert.equal(isSafeRepoPath("src/./x"), false);
    assert.equal(isSafeRepoPath("src/payment/webhook.ts"), "src/payment/webhook.ts");
  });
});
