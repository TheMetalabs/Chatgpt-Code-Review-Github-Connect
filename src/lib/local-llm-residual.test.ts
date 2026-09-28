import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractChatJson } from "./extract-chat-json.ts";
import { residualOutsideJson } from "./local-llm.server.ts";

describe("local JSON acceptance keeps residual reply text", () => {
  it("populates residual when prose follows accepted JSON", () => {
    const json = '{"findings":[],"merge_recommendation":"COMMENT","investigated_safe":["ok"]}';
    const reply = `${json}\n\nAlso note P1 a.ts:1 trailing finding prose.`;
    const extracted = extractChatJson(reply);
    assert.equal(extracted, json);
    assert.match(residualOutsideJson(reply, extracted!) ?? "", /trailing finding prose/);
  });

  it("no residual when the reply is only the JSON object", () => {
    const json = '{"findings":[],"merge_recommendation":"COMMENT"}';
    assert.equal(residualOutsideJson(json, extractChatJson(json)!), undefined);
  });
});
