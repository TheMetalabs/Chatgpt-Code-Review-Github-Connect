import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPS_COMMENT_MARK, buildOpsComment } from "./ops-comment.ts";

describe("buildOpsComment", () => {
  it("says reviewers run in parallel and names a disconnected bridge", () => {
    const body = buildOpsComment({
      phase: "blocked",
      providers: ["chatgpt", "grok", "local"],
      notes: ["Chrome bridge is not connected. ChatGPT/Grok start when the extension reconnects."],
    });
    assert.match(body, new RegExp(OPS_COMMENT_MARK));
    assert.match(body, /chatgpt \+ grok in parallel/);
    assert.match(body, /optional, never blocks/);
    assert.match(body, /not connected/);
    assert.doesNotMatch(body, /127\.0\.0\.1|jwhy\.net|Qwen|sk-/);
  });
});
