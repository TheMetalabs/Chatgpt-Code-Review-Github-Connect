import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { botSettingsToEnv, diskReviewerFlagsWin, overlayEnv, persistableSettings, sanitizeBotSettings } from "./settings.server.ts";
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
    const defaults = botSettingsToEnv(DEFAULT_SETTINGS);
    assert.equal(defaults.ASHLAR_CHATGPT_REASONING, "pro");
    assert.equal(defaults.ASHLAR_GROK_REASONING, "heavy");
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

  it("keeps Settings reviewer toggles over env overlays", () => {
    const merged = diskReviewerFlagsWin(
      { reviewGrok: false, reviewChatgpt: true, reviewLocal: true },
      { reviewGrok: true, reviewChatgpt: true, reviewLocal: true },
    );
    assert.equal(merged.reviewGrok, false);
    assert.equal(merged.reviewChatgpt, true);
  });

  it("defaults the fix agent to disabled (no auto-fix) with safe delivery/mode", () => {
    const s = sanitizeBotSettings({});
    assert.equal(s.fixAgent.provider, null);
    assert.equal(s.fixAgent.delivery, "script-apply");
    assert.equal(s.fixAgent.mode, "suggest");
    assert.ok(s.fixAgent.parallelPrs >= 1);
  });

  it("normalizes fix agent config and rejects unknown values", () => {
    const ok = sanitizeBotSettings({ fixAgent: { provider: "local", delivery: "script-apply", mode: "apply", parallelPrs: 5 } });
    assert.deepEqual(ok.fixAgent, { provider: "local", delivery: "script-apply", mode: "apply", parallelPrs: 5 });
    const bad = sanitizeBotSettings({ fixAgent: { provider: "bogus", delivery: "diff", mode: "yolo", parallelPrs: 999 } });
    assert.equal(bad.fixAgent.provider, null); // unknown provider -> default (disabled)
    assert.equal(bad.fixAgent.delivery, "script-apply");
    assert.equal(bad.fixAgent.mode, "suggest");
    assert.equal(bad.fixAgent.parallelPrs, 20); // clamped
  });

  it("defaults localReviewRole to race, rejects unknown values, and round-trips ASHLAR_LOCAL_REVIEW_ROLE", () => {
    assert.equal(DEFAULT_SETTINGS.localReviewRole, "race");
    assert.equal(sanitizeBotSettings({}).localReviewRole, "race");
    assert.equal(sanitizeBotSettings({ localReviewRole: "bogus" }).localReviewRole, "race");
    const verify = sanitizeBotSettings({ localReviewRole: "verify-clean" });
    assert.equal(verify.localReviewRole, "verify-clean");
    // Distinct from localReviewMode (single/multiturn/auto), which keeps its own env key.
    assert.equal(verify.localReviewMode, DEFAULT_SETTINGS.localReviewMode);
    const env = botSettingsToEnv(verify);
    assert.equal(env.ASHLAR_LOCAL_REVIEW_ROLE, "verify-clean");
    assert.equal(botSettingsToEnv(DEFAULT_SETTINGS).ASHLAR_LOCAL_REVIEW_ROLE, "race");
    const prev = process.env.ASHLAR_LOCAL_REVIEW_ROLE;
    try {
      process.env.ASHLAR_LOCAL_REVIEW_ROLE = env.ASHLAR_LOCAL_REVIEW_ROLE;
      assert.equal(sanitizeBotSettings(overlayEnv({})).localReviewRole, "verify-clean");
      process.env.ASHLAR_LOCAL_REVIEW_ROLE = "nonsense";
      assert.equal(sanitizeBotSettings(overlayEnv({ localReviewRole: "verify-clean" })).localReviewRole, "race");
    } finally {
      if (prev === undefined) delete process.env.ASHLAR_LOCAL_REVIEW_ROLE; else process.env.ASHLAR_LOCAL_REVIEW_ROLE = prev;
    }
  });

  it("serializes fixAgent to env keys so it survives the env-only persistence fallback (H6)", () => {
    const s = sanitizeBotSettings({ fixAgent: { provider: "chatgpt", delivery: "chat-push", mode: "apply", parallelPrs: 4 } });
    const env = botSettingsToEnv(s);
    assert.equal(env.ASHLAR_FIX_PROVIDER, "chatgpt");
    assert.equal(env.ASHLAR_FIX_DELIVERY, "chat-push");
    assert.equal(env.ASHLAR_FIX_MODE, "apply");
    assert.equal(env.ASHLAR_FIX_PARALLEL_PRS, "4");
    // a disabled fix agent serializes provider as "" AND round-trips to null through the read
    // path (an explicit empty ASHLAR_FIX_PROVIDER disables a persisted provider) (J2/J8)
    assert.equal(botSettingsToEnv(sanitizeBotSettings({})).ASHLAR_FIX_PROVIDER, "");
    const prev = process.env.ASHLAR_FIX_PROVIDER;
    try {
      process.env.ASHLAR_FIX_PROVIDER = "";
      const base = sanitizeBotSettings({ fixAgent: { provider: "chatgpt", delivery: "chat-push", mode: "suggest", parallelPrs: 3 } }) as unknown as Record<string, unknown>;
      const disabled = sanitizeBotSettings(overlayEnv(base));
      assert.equal(disabled.fixAgent.provider, null, "empty env provider disables the persisted one");
    } finally {
      if (prev === undefined) delete process.env.ASHLAR_FIX_PROVIDER; else process.env.ASHLAR_FIX_PROVIDER = prev;
    }
  });

  it("enforces the provider→delivery matrix, disabling incompatible pairs (F7)", () => {
    // chatgpt/grok support script-apply | chat-push
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "chatgpt", delivery: "chat-push" } }).fixAgent.provider, "chatgpt");
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "grok", delivery: "script-apply" } }).fixAgent.provider, "grok");
    // local => script-apply only; chat-push is invalid => disabled
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "local", delivery: "chat-push" } }).fixAgent.provider, null);
    // coding-agent => coding-agent only; script-apply is invalid => disabled
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "coding-agent", delivery: "script-apply" } }).fixAgent.provider, null);
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "coding-agent", delivery: "coding-agent" } }).fixAgent.provider, "coding-agent");
  });
});

describe("prompt budgets", () => {
  it("applies budget defaults and honors validated overrides", () => {
    assert.equal(sanitizeBotSettings({}).promptDiffMaxChars, DEFAULT_SETTINGS.promptDiffMaxChars);
    const s = sanitizeBotSettings({ promptDiffMaxChars: 123456, contextPadLines: 5 });
    assert.equal(s.promptDiffMaxChars, 123456);
    assert.equal(s.contextPadLines, 5);
    assert.equal(sanitizeBotSettings({ promptContextMaxChars: -1 }).promptContextMaxChars, 0);
  });

  it("round-trips prompt budgets into env keys", () => {
    const env = botSettingsToEnv(DEFAULT_SETTINGS);
    assert.equal(env.ASHLAR_PROMPT_DIFF_MAX_CHARS, "300000");
    assert.equal(env.ASHLAR_CONTEXT_PAD_LINES, "20");
  });
});
