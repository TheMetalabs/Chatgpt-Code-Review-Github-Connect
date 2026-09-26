import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prScopeSection, PR_SCOPE_MAX_CHARS } from "./pr-scope.ts";

// Live aicc #457: the lane's PR body put SENDING recovery out of scope (DESIGN), and a bot fix added
// it back — the fix prompt never saw the PR body, and the review prompt saw its first 800 chars only.
describe("prScopeSection", () => {
  const body = [
    "## Summary",
    "MSG-1/2 sender.",
    "",
    "## Scope",
    "- In: MessagingService send path",
    "### Out of scope",
    "- SENDING recovery (DESIGN, #470) — do not add it in this PR",
    "",
    "## Test plan",
    "- jest",
  ].join("\n");

  it("takes a scope heading's section with its subsections, not the next same-level section", () => {
    assert.equal(prScopeSection(body), "## Scope\n- In: MessagingService send path\n### Out of scope\n- SENDING recovery (DESIGN, #470) — do not add it in this PR");
  });

  it("takes Korean scope headings and stray out-of-scope lines outside any section", () => {
    const ko = "## 개요\n발송기\n범위 밖: SENDING 복구 — 이 PR에서 추가 금지\n\n## 범위\n- 발송만\n\n## 테스트\n- jest";
    assert.equal(prScopeSection(ko), "범위 밖: SENDING 복구 — 이 PR에서 추가 금지\n## 범위\n- 발송만");
  });

  it("is empty for a body without a scope statement, and bounded", () => {
    assert.equal(prScopeSection("## Summary\nfix a bug"), "");
    assert.equal(prScopeSection(""), "");
    const long = `## Scope\n${"x".repeat(PR_SCOPE_MAX_CHARS * 2)}`;
    assert.equal(prScopeSection(long).length, PR_SCOPE_MAX_CHARS);
  });

  it("ignores a scope word inside a fenced code block", () => {
    assert.equal(prScopeSection("## Notes\n```\n## Scope\nnot a heading\n```"), "");
  });
});
