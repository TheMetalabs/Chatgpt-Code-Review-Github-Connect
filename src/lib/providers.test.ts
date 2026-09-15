import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, localLlmReady, providersFromSettings } from "./types.ts";

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
});
