import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocatePolicyText, changedPolicyDocs, extractReviewPolicy, isPolicyDocPath, isSafeRepoPath, nearestPolicyOrder, policyPathsFor, snapshotFileRef } from "./github-snapshot.ts";

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

  it("respects the caller's smaller budget and still keeps the review-rules section", () => {
    // Regression: a file that fits 32 KiB but not the caller's remaining budget must not be returned
    // whole and then blindly prefix-sliced (which drops a review-rules section near the end).
    const md = "top domain\n" + "z".repeat(5000) + "\n## Code Review Rules\n- keep me under a tight budget\n";
    const out = extractReviewPolicy(md, 2000);
    assert.ok(out.length <= 2000, `respects caller budget, got ${out.length}`);
    assert.match(out, /keep me under a tight budget/);
  });

  it("reads the module CLAUDE.md chain beside AGENTS.md as base-read policy", () => {
    const policy = policyPathsFor(["src/payment/webhook.ts"]);
    for (const p of ["CLAUDE.md", "src/CLAUDE.md", "src/payment/CLAUDE.md", "src/payment/AGENTS.md"]) assert.ok(policy.includes(p), p);
    assert.equal(snapshotFileRef("src/payment/CLAUDE.md", policy, "base", "head"), "base");
    assert.ok(isPolicyDocPath("src/payment/CLAUDE.md") && isPolicyDocPath("AGENTS.md") && isPolicyDocPath("code_review.md"));
    assert.ok(!isPolicyDocPath("src/code_review.md") && !isPolicyDocPath("src/payment/webhook.ts") && !isPolicyDocPath("docs/CLAUDE.md.bak"));
  });

  it("a changed policy doc is also fetched at head as context (changedPolicyDocs)", () => {
    const changed = ["src/mail/CLAUDE.md", "src/mail/send.ts", "README.md"];
    assert.deepEqual(changedPolicyDocs(changed, policyPathsFor(changed)), ["src/mail/CLAUDE.md"]);
  });

  it("orders policy nearest-first per changed module, root last", () => {
    const available = ["AGENTS.md", "CLAUDE.md", "code_review.md", "backend/AGENTS.md", "backend/src/mail/CLAUDE.md", "frontend/AGENTS.md", "unrelated/AGENTS.md"];
    const order = nearestPolicyOrder(["backend/src/mail/send.ts", "frontend/src/app.ts", "backend/src/mail/other.ts"], available);
    assert.deepEqual(order, [
      "backend/src/mail/CLAUDE.md", // nearest doc of area 1
      "frontend/AGENTS.md", // nearest doc of area 2, before area 1's second-nearest
      "backend/AGENTS.md",
      "AGENTS.md",
      "CLAUDE.md",
      "code_review.md",
      "unrelated/AGENTS.md", // reached by no changed path: appended
    ]);
    // A shallow area reaching the root early does not put root docs ahead of a deep area's module doc.
    assert.deepEqual(
      nearestPolicyOrder(["frontend/app.ts", "backend/src/x.ts"], ["AGENTS.md", "frontend/AGENTS.md", "backend/src/CLAUDE.md", "backend/AGENTS.md"]),
      ["frontend/AGENTS.md", "backend/src/CLAUDE.md", "backend/AGENTS.md", "AGENTS.md"],
    );
  });

  it("allocatePolicyText: whole when it fits; otherwise a fair share each, leftover to the nearest", () => {
    const small = [{ path: "a/AGENTS.md", content: "A rules" }, { path: "AGENTS.md", content: "root rules" }];
    assert.equal(allocatePolicyText(small, 1_000), "--- a/AGENTS.md\nA rules\n\n--- AGENTS.md\nroot rules");
    const big = (t: string) => `${t} head\n${"q".repeat(5_000)}\n## Code Review Rules\n- ${t} rule\n`;
    const out = allocatePolicyText([{ path: "a/AGENTS.md", content: big("A") }, { path: "b/AGENTS.md", content: big("B") }, { path: "AGENTS.md", content: "root rules" }], 3_000);
    assert.ok(out.length <= 3_000, `bounded (${out.length})`);
    for (const t of ["A", "B"]) {
      assert.match(out, new RegExp(`${t} head`));
      assert.match(out, new RegExp(`- ${t} rule`));
    }
    assert.match(out, /--- AGENTS\.md\nroot rules/, "the small root file is whole");
    assert.ok(out.length > 2_900, "leftover from the small file is reused");
    assert.equal(allocatePolicyText([{ path: "x/CLAUDE.md", content: "same" }, { path: "x/AGENTS.md", content: "same" }], 100), "--- x/CLAUDE.md\nsame");
  });

  it("rejects path traversal", () => {
    assert.equal(isSafeRepoPath("../secrets"), false);
    assert.equal(isSafeRepoPath("src/./x"), false);
    assert.equal(isSafeRepoPath("src/payment/webhook.ts"), "src/payment/webhook.ts");
  });
});
