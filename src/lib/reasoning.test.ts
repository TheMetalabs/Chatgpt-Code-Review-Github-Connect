import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHATGPT_REASONING,
  DEFAULT_GROK_REASONING,
  chatgptReasoningMatches,
  chatgptUrl,
  grokReasoningMatches,
  normalizeChatgptReasoning,
  normalizeGrokReasoning,
} from "./reasoning.ts";

describe("reasoning defaults", () => {
  it("defaults unknown values to the highest tier", () => {
    assert.equal(normalizeChatgptReasoning(undefined), "pro");
    assert.equal(normalizeChatgptReasoning("nope"), "pro");
    assert.equal(normalizeChatgptReasoning("high"), "high");
    assert.equal(DEFAULT_CHATGPT_REASONING, "pro");
    assert.equal(normalizeGrokReasoning(""), "heavy");
    assert.equal(normalizeGrokReasoning("expert"), "expert");
    assert.equal(DEFAULT_GROK_REASONING, "heavy");
    assert.match(chatgptUrl("pro"), /model=gpt-6-pro/);
    assert.equal(chatgptReasoningMatches("pro", "6 Pro"), true);
    assert.equal(chatgptReasoningMatches("pro", "6Pro"), true);
    assert.equal(chatgptReasoningMatches("pro", "Instant"), false);
    assert.equal(chatgptReasoningMatches("instant", "Instant"), true);
    assert.equal(grokReasoningMatches("fast", "빠른"), true);
    assert.equal(grokReasoningMatches("fast", "모델 선택 빠른"), true);
    assert.equal(grokReasoningMatches("heavy", "헤비"), true);
    assert.equal(grokReasoningMatches("heavy", "빠른"), false);
    assert.equal(chatgptReasoningMatches("high", "High (Thinking-Extended)"), true);
    assert.equal(chatgptReasoningMatches("high", "Extra High"), false);
  });
});
