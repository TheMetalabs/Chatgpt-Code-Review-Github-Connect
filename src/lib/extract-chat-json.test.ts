import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractChatJson } from "./extract-chat-json.ts";

const PAYLOAD = `{
"merge_recommendation": "APPROVE",
"highest_risk": "none",
"investigated_safe": ["src/lib/ashlar-probe.ts: probeAdd returns a + b."],
"assumptions": ["no CI config"],
"findings": []
}`;

describe("extractChatJson", () => {
  it("reads a bare review object", () => {
    assert.equal(JSON.parse(extractChatJson(PAYLOAD) || "{}").merge_recommendation, "APPROVE");
  });

  it("does not let thinking braces swallow the payload", () => {
    const thinking = `Thinking { "scratch": true } still going { not json\n${PAYLOAD}\nDone.`;
    const hit = extractChatJson(thinking);
    assert.ok(hit);
    assert.equal(JSON.parse(hit).findings.length, 0);
    assert.equal(JSON.parse(hit).investigated_safe.length, 1);
  });

  it("prefers a fenced JSON block after prose", () => {
    const text = `Sure.\n\`\`\`json\n${PAYLOAD}\n\`\`\`\n`;
    assert.equal(JSON.parse(extractChatJson(text) || "{}").merge_recommendation, "APPROVE");
  });

  it("returns null for unrelated JSON", () => {
    assert.equal(extractChatJson('{"foo":1}'), null);
  });
});
