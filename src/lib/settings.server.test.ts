import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { botSettingsToEnv, sanitizeBotSettings } from "./settings.server.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

describe("sanitizeBotSettings", () => {
  it("keeps local LLM fields from a saved document", () => {
    const s = sanitizeBotSettings({
      reviewLocal: true,
      reviewChatgpt: false,
      reviewGrok: false,
      localLlmBaseUrl: "http://127.0.0.1:1234/v1",
      localLlmModel: "qwen2.5-coder",
      localLlmApiKey: "sk-local",
    });
    assert.equal(s.reviewLocal, true);
    assert.equal(s.reviewChatgpt, false);
    assert.equal(s.localLlmModel, "qwen2.5-coder");
    assert.equal(s.localLlmApiKey, "sk-local");
    assert.equal(s.localLlmBaseUrl, "http://127.0.0.1:1234/v1");
  });

  it("falls back to defaults and refuses zero reviewers", () => {
    const s = sanitizeBotSettings({ reviewChatgpt: false, reviewGrok: false, reviewLocal: false });
    assert.equal(s.reviewChatgpt, true);
    assert.equal(s.username, DEFAULT_SETTINGS.username);
  });

  it("round-trips reviewer flags into env keys", () => {
    const env = botSettingsToEnv({
      ...DEFAULT_SETTINGS,
      reviewLocal: true,
      reviewChatgpt: false,
      reviewGrok: true,
      localLlmModel: "qwen",
    });
    assert.equal(env.ASHLAR_REVIEW_LOCAL, "true");
    assert.equal(env.ASHLAR_REVIEW_CHATGPT, "false");
    assert.equal(env.ASHLAR_LOCAL_LLM_MODEL, "qwen");
  });
});
