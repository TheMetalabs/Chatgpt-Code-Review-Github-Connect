import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractChatJson, htmlChatToText, salvageReviewJson } from "./extract-chat-json.ts";

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

  it("pulls review JSON out of ChatGPT markdown <p><br> HTML", () => {
    const html = `<p dir="auto">{<br>
"merge_recommendation": "REQUEST_CHANGES",<br>
"highest_risk": "overlap",<br>
"investigated_safe": [<br>
"a.ts: ok <button type="button">cite</button>"<br>
],<br>
"assumptions": [],<br>
"findings": [{"severity":"P2","file":"a.ts","line":1,"title":"t","failure_scenario":"f","root_cause":"r","evidence":"e","recommended_fix":"x","recommended_test":"y"}]<br>
}</p>`;
    const text = htmlChatToText(html);
    const hit = extractChatJson(text);
    assert.ok(hit);
    const parsed = JSON.parse(hit);
    assert.equal(parsed.merge_recommendation, "REQUEST_CHANGES");
    assert.equal(parsed.findings.length, 1);
    assert.equal(String(parsed.investigated_safe[0]).includes("cite"), false);
  });

  it("extracts REQUEST_CHANGES from a live ChatGPT assistant dump", async () => {
    const { readFile } = await import("node:fs/promises");
    let html = "";
    try {
      html = await readFile("/workspace/attachments/pasted-text.txt", "utf8");
    } catch {
      return;
    }
    const i = html.indexOf('data-message-author-role="assistant"');
    assert.ok(i > 0);
    const slice = html.slice(i, html.indexOf("thread-bottom-container"));
    const hit = extractChatJson(htmlChatToText(slice));
    assert.ok(hit);
    const parsed = JSON.parse(hit);
    assert.equal(parsed.merge_recommendation, "REQUEST_CHANGES");
    assert.ok(Array.isArray(parsed.findings) && parsed.findings.length >= 1);
  });
});

describe("salvageReviewJson", () => {
  it("keeps the reply verbatim (no deleted punctuation) and notes detected severities", () => {
    const reply = "Overview: two issues. P1: null deref. Also code: if (P1) { charge(); }";
    const parsed = JSON.parse(salvageReviewJson(reply));
    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.merge_recommendation, "COMMENT");
    assert.match(parsed.raw_review, /Detected severity markers: P1\./);
    assert.ok(parsed.raw_review.includes(reply)); // verbatim: "if (P1) { charge(); }" survives intact
  });

  it("adds no header and keeps the full text when there are no severity markers", () => {
    const reply = "This review has no structured severities, just prose feedback.";
    const parsed = JSON.parse(salvageReviewJson(reply));
    assert.equal(parsed.raw_review, reply);
    assert.deepEqual(parsed.findings, []);
  });

  it("always returns parseable review JSON, even for junk", () => {
    for (const t of ["", "   ", "not json {", "```\n{bad\n```", "no markers here"]) {
      const parsed = JSON.parse(salvageReviewJson(t));
      assert.ok(Array.isArray(parsed.findings));
      assert.equal(typeof parsed.raw_review, "string");
      assert.equal(parsed.merge_recommendation, "COMMENT");
    }
  });
});
