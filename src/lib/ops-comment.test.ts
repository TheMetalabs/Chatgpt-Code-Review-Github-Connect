import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPS_COMMENT_MARK, buildOpsComment, llmWorkAllowed, opsCommentAllowed } from "./ops-comment.ts";

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
