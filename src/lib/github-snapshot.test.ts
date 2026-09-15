import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeRepoPath, policyPathsFor, snapshotFileRef } from "./github-snapshot.ts";

describe("github snapshot refs", () => {
  it("loads AGENTS.md and code_review.md from base, source from head", () => {
    const policy = policyPathsFor(["src/payment/webhook.ts"]);
    assert.ok(policy.includes("AGENTS.md"));
    assert.ok(policy.includes("code_review.md"));
    assert.ok(policy.includes("src/payment/AGENTS.md"));
    assert.equal(snapshotFileRef("AGENTS.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/payment/AGENTS.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/payment/webhook.ts", policy, "base", "head"), "head");
  });

  it("still uses base for AGENTS.md even when the PR changes it", () => {
    const policy = policyPathsFor(["AGENTS.md", "src/invoices/routes.ts"]);
    assert.equal(snapshotFileRef("AGENTS.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/invoices/routes.ts", policy, "base", "head"), "head");
  });

  it("rejects path traversal", () => {
    assert.equal(isSafeRepoPath("../secrets"), false);
    assert.equal(isSafeRepoPath("src/./x"), false);
    assert.equal(isSafeRepoPath("src/payment/webhook.ts"), "src/payment/webhook.ts");
  });
});
