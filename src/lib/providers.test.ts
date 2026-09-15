import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, claimedReviewerNote, localLlmReady, providersFromSettings } from "./types.ts";

describe("providersFromSettings", () => {
  it("skips local when the toggle is off or URL/model is empty", () => {
    assert.equal(localLlmReady({ ...DEFAULT_SETTINGS, reviewLocal: true, localLlmModel: "" }), false);
    assert.deepEqual(providersFromSettings({ ...DEFAULT_SETTINGS, reviewLocal: true, localLlmModel: "" }), [
      "chatgpt",
      "grok",
    ]);
    assert.deepEqual(providersFromSettings({ ...DEFAULT_SETTINGS, reviewChatgpt: false, reviewGrok: false, reviewLocal: true }), []);
  });

  it("includes local only when configured", () => {
    const s = { ...DEFAULT_SETTINGS, reviewLocal: true, localLlmBaseUrl: "http://127.0.0.1:8000/v1", localLlmModel: "qwen" };
    assert.equal(localLlmReady(s), true);
    assert.deepEqual(providersFromSettings(s), ["chatgpt", "grok", "local"]);
  });

  it("omits a reviewer whose setting flag is false", () => {
    assert.deepEqual(providersFromSettings({ ...DEFAULT_SETTINGS, reviewGrok: false }), ["chatgpt"]);
    assert.deepEqual(
      providersFromSettings({
        ...DEFAULT_SETTINGS,
        reviewGrok: false,
        reviewLocal: true,
        localLlmBaseUrl: "http://127.0.0.1:8000/v1",
        localLlmModel: "qwen",
      }),
      ["chatgpt", "local"],
    );
    assert.deepEqual(providersFromSettings({ ...DEFAULT_SETTINGS, reviewChatgpt: false, reviewGrok: true }), ["grok"]);
  });
});

describe("claimedReviewerNote", () => {
  it("names only the enabled chat reviewers", () => {
    assert.match(claimedReviewerNote(["chatgpt", "local"]), /ChatGPT is running/);
    assert.doesNotMatch(claimedReviewerNote(["chatgpt", "local"]), /Grok/);
    assert.match(claimedReviewerNote(["chatgpt", "grok"]), /ChatGPT and Grok run in parallel/);
  });
});
