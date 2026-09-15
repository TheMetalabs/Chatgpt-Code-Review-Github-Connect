import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeRepoPath, policyPathsFor, snapshotFileRef } from "./github-snapshot.ts";

describe("github snapshot refs", () => {
  it("loads code_review.md from base, source from head, skips root sandbox AGENTS.md", () => {
    const policy = policyPathsFor(["src/payment/webhook.ts"]);
    assert.equal(policy.includes("AGENTS.md"), false);
    assert.ok(policy.includes("code_review.md"));
    assert.ok(policy.includes("src/payment/AGENTS.md"));
    assert.equal(snapshotFileRef("code_review.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/payment/AGENTS.md", policy, "base", "head"), "base");
    assert.equal(snapshotFileRef("src/payment/webhook.ts", policy, "base", "head"), "head");
  });

  it("uses head for a changed root AGENTS.md because it is not review policy", () => {
    const policy = policyPathsFor(["AGENTS.md", "src/invoices/routes.ts"]);
    assert.equal(snapshotFileRef("AGENTS.md", policy, "base", "head"), "head");
    assert.equal(snapshotFileRef("src/invoices/routes.ts", policy, "base", "head"), "head");
  });

  it("rejects path traversal", () => {
    assert.equal(isSafeRepoPath("../secrets"), false);
    assert.equal(isSafeRepoPath("src/./x"), false);
    assert.equal(isSafeRepoPath("src/payment/webhook.ts"), "src/payment/webhook.ts");
  });
});
