import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChatSubmission } from "./chat-prompt.ts";

describe("parseChatSubmission", () => {
  it("reads a bare JSON object", () => {
    const out = parseChatSubmission(`{"merge_recommendation":"COMMENT","findings":[]}`);
    assert.equal(out?.merge_recommendation, "COMMENT");
  });

  it("strips markdown fences", () => {
    const out = parseChatSubmission("```json\n{\"findings\":[]}\n```");
    assert.ok(Array.isArray(out?.findings));
  });

  it("rejects empty and non-objects", () => {
    assert.equal(parseChatSubmission(""), null);
    assert.equal(parseChatSubmission("[1]"), null);
    assert.equal(parseChatSubmission("not json"), null);
  });
});
