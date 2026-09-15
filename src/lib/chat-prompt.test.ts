import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINDING_412, SAMPLE_PRS } from "./samples.ts";
import { MERGE_FALLBACK_NOTE, REVIEW_OFFLINE_RULE, buildChatPrompt, buildFpPrompt, buildMergePrompt, parseChatSubmission } from "./chat-prompt.ts";

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

describe("buildChatPrompt", () => {
  it("forbids web research so reviewers spend tokens on the snapshot only", () => {
    const out = buildChatPrompt({ sample: SAMPLE_PRS["pay-412"] });
    assert.match(out, /Do not search the web/);
    assert.match(out, /DeepSearch/);
    assert.match(REVIEW_OFFLINE_RULE, /only source of truth/i);
    const fp = buildFpPrompt({ sample: SAMPLE_PRS["pay-412"], findings: [FINDING_412], peer: "grok" });
    assert.match(fp, /Do not search the web/);
    const merge = buildMergePrompt({
      sample: SAMPLE_PRS["pay-412"],
      drafts: [{ provider: "chatgpt", raw: '{"findings":[]}' }],
    });
    assert.match(merge, /Do not search the web/);
  });
});

describe("buildMergePrompt", () => {
  it("asks ChatGPT to merge drafts when local is unavailable", () => {
    const out = buildMergePrompt({
      sample: SAMPLE_PRS["pay-412"],
      drafts: [{ provider: "chatgpt", raw: '{"findings":[]}' }],
    });
    assert.match(out, /local LLM was unavailable/i);
    assert.match(out, /DRAFT chatgpt/);
    assert.match(MERGE_FALLBACK_NOTE, /ChatGPT to merge/);
  });
});

