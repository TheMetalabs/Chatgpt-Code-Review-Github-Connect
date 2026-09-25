import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPS_COMMENT_MARK, buildOpsComment, llmWorkAllowed, opsCommentAllowed, reviewPostedNotes } from "./ops-comment.ts";

describe("buildOpsComment", () => {
  it("says reviewers run in parallel and names a disconnected bridge", () => {
    const body = buildOpsComment({
      phase: "blocked",
      providers: ["chatgpt", "grok", "local"],
      notes: ["Chrome bridge is not connected. ChatGPT/Grok start when the extension reconnects."],
    });
    assert.match(body, new RegExp(OPS_COMMENT_MARK));
    assert.match(body, /chatgpt \+ grok in parallel \(Chrome\)/);
    assert.match(body, /local racing/);
    assert.match(body, /not connected/);
    assert.doesNotMatch(body, /127\.0\.0\.1|jwhy\.net|Qwen|sk-/);
  });

  it("a verify-clean job released as the fallback reads local runs as the fallback, never that it verifies a clean result", () => {
    const header = (localFallback?: boolean) =>
      buildOpsComment({ phase: "posted", providers: ["chatgpt", "local"], role: "verify-clean", localFallback, notes: [] })
        .split("\n").find((l) => l.startsWith("Reviewers:"));
    assert.equal(header(true), "Reviewers: chatgpt (Chrome); local runs as the fallback.");
    assert.equal(header(false), "Reviewers: chatgpt (Chrome); local verifies a clean result.");
    assert.equal(header(), "Reviewers: chatgpt (Chrome); local verifies a clean result.");
  });

  it("does not mention Grok when the setting is off", () => {
    const body = buildOpsComment({
      phase: "running",
      providers: ["chatgpt", "local"],
      notes: ["Chrome bridge claimed this job. ChatGPT is running the review."],
    });
    assert.match(body, /chatgpt \(Chrome\)/);
    assert.doesNotMatch(body, /grok/i);
  });

  it("only posts ops comments on @ashlar-bot mention or inline follow-up", () => {
    assert.equal(opsCommentAllowed({ trigger: "issue_comment.mention" }), true);
    assert.equal(opsCommentAllowed({ trigger: "pull_request_review_comment.followup" }), true);
    assert.equal(opsCommentAllowed({ trigger: "pull_request.opened" }), false);
    assert.equal(opsCommentAllowed({ trigger: "pull_request.synchronize" }), false);
    assert.equal(opsCommentAllowed({ trigger: "pull_request.ready_for_review" }), false);
  });

  it("allows LLM work only on mention / follow-up", () => {
    assert.equal(llmWorkAllowed({ trigger: "issue_comment.mention" }), true);
    assert.equal(llmWorkAllowed({ trigger: "pull_request_review_comment.followup" }), true);
    assert.equal(llmWorkAllowed({ trigger: "pull_request.opened" }), false);
    assert.equal(llmWorkAllowed({ trigger: "pull_request.synchronize" }), false);
  });
});

describe("reviewPostedNotes", () => {
  it("summarizes prompt sizes, coverage and dropped findings", () => {
    const notes = reviewPostedNotes(
      {
        headSha: "abcdef012345",
        promptStats: { diffChars: 1000, contextChars: 2000, policyChars: 300, diffFilesFull: 3, diffFilesTotal: 4 },
        coverageDeterministic: [{ path: "a.ts", inDiff: true, inContext: true }, { path: "b.ts", inDiff: false, inContext: false }],
        coverage: [{ file: "a.ts", status: "cleared", reason: "" }, { file: "b.ts", status: "not_cleared", reason: "x" }],
        droppedCount: 2,
      },
      1,
    );
    assert.equal(notes[0], "Reviewed abcdef0");
    assert.ok(notes.some((n) => /Prompt: diff 1000 chars \(3\/4 files full\), context 2000 chars, policy 300 chars/.test(n)));
    assert.ok(notes.some((n) => /Coverage \(deterministic\): 1\/2 code files with full diff, 1\/2 with context/.test(n)));
    assert.ok(notes.some((n) => /Coverage \(model\): not_cleared = b\.ts/.test(n)));
    assert.ok(notes.some((n) => /Findings: 1 returned, 2 dropped by precision policy/.test(n)));
    assert.ok(notes.length <= 8);
  });

  it("notes when HEAD moved and stays minimal without stats", () => {
    const moved = reviewPostedNotes({ headSha: "abcdef012345", headMovedTo: "999888777666" }, 0);
    assert.match(moved[0], /Reviewed abcdef0 \(HEAD moved to 9998887\)/);
    assert.deepEqual(reviewPostedNotes({ headSha: "abcdef012345" }, 0), ["Reviewed abcdef0"]);
  });
});
