import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractChatJsonRange } from "./extract-chat-json.ts";
import { residualOutsideJson } from "./local-llm.server.ts";

describe("local JSON acceptance keeps residual reply text", () => {
  it("populates residual when prose follows accepted JSON", () => {
    const json = '{"findings":[],"merge_recommendation":"COMMENT","investigated_safe":["ok"]}';
    const reply = `${json}\n\nAlso note P1 a.ts:1 trailing finding prose.`;
    const hit = extractChatJsonRange(reply);
    assert.equal(hit?.json, json);
    assert.match(residualOutsideJson(reply, hit!.start, hit!.end) ?? "", /trailing finding prose/);
  });

  it("no residual when the reply is only the JSON object", () => {
    const json = '{"findings":[],"merge_recommendation":"COMMENT"}';
    const hit = extractChatJsonRange(json)!;
    assert.equal(residualOutsideJson(json, hit.start, hit.end), undefined);
  });

  it("residual uses the final accepted JSON when an earlier identical copy appears in prose", () => {
    const json = '{"findings":[],"merge_recommendation":"COMMENT","keep":["safe"]}';
    const reply = [
      `For example the shape looks like ${json} in the explanation.`,
      "",
      "Final answer:",
      json,
      "",
      "P1 leftover.ts:1 trailing finding outside the final object.",
    ].join("\n");
    const hit = extractChatJsonRange(reply);
    assert.equal(hit?.json, json);
    // Must be the last occurrence: prose before the final object + trailing line, not the final JSON itself.
    const residual = residualOutsideJson(reply, hit!.start, hit!.end) ?? "";
    assert.match(residual, /For example the shape looks like/);
    assert.match(residual, /trailing finding outside the final object/);
    assert.doesNotMatch(residual, /^\{"findings"/);
    assert.equal(residual.includes(json), true, "earlier prose copy remains in residual");
    // The accepted final slice must not be double-counted as residual "after".
    const afterOnly = reply.slice(hit!.end).trim();
    assert.match(afterOnly, /trailing finding outside the final object/);
    assert.doesNotMatch(afterOnly, /merge_recommendation/);
  });
});
