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

  it("extractReviewPolicy pulls the review-rules section, else the first 32 KiB", () => {
    const md = "# Repo\n\nintro\n\n## Code Review Rules\n\n- rule A\n- rule B\n\n## Other\n\nignore me";
    const out = extractReviewPolicy(md);
    assert.match(out, /Code Review Rules/);
    assert.match(out, /rule A/);
    assert.doesNotMatch(out, /ignore me/);
    assert.equal(extractReviewPolicy("x".repeat(40_000)).length, 32 * 1024);
  });

  it("rejects path traversal", () => {
    assert.equal(isSafeRepoPath("../secrets"), false);
    assert.equal(isSafeRepoPath("src/./x"), false);
    assert.equal(isSafeRepoPath("src/payment/webhook.ts"), "src/payment/webhook.ts");
  });
});
