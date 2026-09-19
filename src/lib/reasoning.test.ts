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
  it("defaults unknown values to the current highest tier (extra_high, since gpt-6-pro is gone)", () => {
    assert.equal(normalizeChatgptReasoning(undefined), "extra_high");
    assert.equal(normalizeChatgptReasoning("nope"), "extra_high");
    assert.equal(normalizeChatgptReasoning("high"), "high");
    assert.equal(DEFAULT_CHATGPT_REASONING, "extra_high");
    assert.equal(normalizeGrokReasoning(""), "heavy");
    assert.equal(normalizeGrokReasoning("expert"), "expert");
    assert.equal(DEFAULT_GROK_REASONING, "heavy");
  });

  it("never pins a model slug in the ChatGPT URL", () => {
    assert.doesNotMatch(chatgptUrl("extra_high"), /model=/);
    assert.doesNotMatch(chatgptUrl("pro"), /model=/); // legacy value must not force a dead slug
    assert.match(chatgptUrl("extra_high"), /temporary-chat=true/);
  });

  it("matches current ChatGPT effort labels (EN + KO), keeping extra-high distinct from high", () => {
    assert.equal(chatgptReasoningMatches("extra_high", "Extra High"), true);
    assert.equal(chatgptReasoningMatches("extra_high", "매우 높음"), true);
    assert.equal(chatgptReasoningMatches("extra_high", "매우높음"), true);
    assert.equal(chatgptReasoningMatches("high", "매우 높음"), false); // very-high must not read as high
    assert.equal(chatgptReasoningMatches("high", "High (Thinking-Extended)"), true);
    assert.equal(chatgptReasoningMatches("high", "Extra High"), false);
    assert.equal(chatgptReasoningMatches("medium", "중간"), true);
    assert.equal(chatgptReasoningMatches("medium", "Medium"), true);
    assert.equal(chatgptReasoningMatches("instant", "Instant"), true);
    assert.equal(chatgptReasoningMatches("pro", "6 Pro"), true); // legacy token still recognized if it returns
    assert.equal(grokReasoningMatches("fast", "빠른"), true);
    assert.equal(grokReasoningMatches("heavy", "헤비"), true);
    assert.equal(grokReasoningMatches("heavy", "빠른"), false);
  });
});
