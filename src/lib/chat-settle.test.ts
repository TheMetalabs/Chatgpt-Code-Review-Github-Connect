import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatGenerationFinished } from "./chat-settle.ts";

describe("chatGenerationFinished", () => {
  it("requires copy/feedback with no visible stop button", () => {
    assert.equal(chatGenerationFinished({ stopVisible: true, replyActionsVisible: true }), false);
    assert.equal(chatGenerationFinished({ stopVisible: false, replyActionsVisible: true }), true);
  });

  it("waits while the stop button is the only signal", () => {
    assert.equal(chatGenerationFinished({ stopVisible: true, replyActionsVisible: false }), false);
  });

  it("does not treat pre-generation (no stop yet) as done", () => {
    assert.equal(chatGenerationFinished({ stopVisible: false, replyActionsVisible: false }), false);
    assert.equal(chatGenerationFinished({ stopVisible: false, replyActionsVisible: false, sawStop: false }), false);
  });

  it("does not settle on stop flicker without the current reply toolbar", () => {
    assert.equal(chatGenerationFinished({ stopVisible: false, replyActionsVisible: false, sawStop: true }), false);
  });
});
