import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { botSettingsToEnv, persistableSettings, sanitizeBotSettings } from "./settings.server.ts";
import { DEFAULT_SETTINGS, providersFromSettings } from "./types.ts";

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

  it("persists skip/severity policy fields", () => {
    const s = sanitizeBotSettings({
      skipForks: false,
      skipDrafts: false,
      precisionOverRecall: false,
      maxInlineComments: 3,
      publishMinSeverity: "P0",
      requestChangesMin: "P0",
    });
    assert.equal(s.skipForks, false);
    assert.equal(s.maxInlineComments, 3);
    assert.equal(s.publishMinSeverity, "P0");
  });

  it("keeps at least one reviewer if env disables local on a local-only disk", () => {
    const s = sanitizeBotSettings({
      reviewChatgpt: false,
      reviewGrok: false,
      reviewLocal: false,
      localLlmBaseUrl: "http://127.0.0.1:8000/v1",
      localLlmModel: "qwen",
    });
    assert.ok(providersFromSettings(s).length >= 1);
    assert.equal(s.reviewChatgpt, true);
  });

  it("does not copy an env-only API key onto disk", () => {
    const runtime = sanitizeBotSettings({
      ...DEFAULT_SETTINGS,
      localLlmApiKey: "env-secret",
    });
    const disk = persistableSettings(runtime, { ASHLAR_LOCAL_LLM_API_KEY: "env-secret" }, {});
    assert.equal(disk.localLlmApiKey, "");
  });

  it("keeps the disk key when env is rotated, without treating rotation as a UI save", () => {
    const runtime = sanitizeBotSettings({ ...DEFAULT_SETTINGS, localLlmApiKey: "rotated-B" });
    const disk = persistableSettings(runtime, { ASHLAR_LOCAL_LLM_API_KEY: "rotated-B" }, { localLlmApiKey: "old-A" });
    assert.equal(disk.localLlmApiKey, "old-A");
  });
});
