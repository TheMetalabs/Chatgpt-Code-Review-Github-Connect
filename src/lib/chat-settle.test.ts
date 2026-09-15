import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatGenerationFinished } from "./chat-settle.ts";

describe("chatGenerationFinished", () => {
  it("treats the copy/feedback toolbar as done even if a leftover stop node exists", () => {
    assert.equal(chatGenerationFinished({ stopVisible: true, replyActionsVisible: true }), true);
    assert.equal(chatGenerationFinished({ stopVisible: false, replyActionsVisible: true }), true);
  });

  it("waits while the stop button is the only signal", () => {
    assert.equal(chatGenerationFinished({ stopVisible: true, replyActionsVisible: false }), false);
  });

  it("settles when stop is gone", () => {
    assert.equal(chatGenerationFinished({ stopVisible: false, replyActionsVisible: false }), true);
  });
});
