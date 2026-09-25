import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractChatJson, extractChatJsonParts, htmlChatToText, salvageReviewJson } from "./extract-chat-json.ts";

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

describe("extractChatJsonParts: what canonicalizing a reply to its review JSON discards", () => {
  it("nothing when the reply is only the object, bare or fenced", () => {
    assert.deepEqual(extractChatJsonParts(PAYLOAD), { json: PAYLOAD, residual: "" });
    assert.deepEqual(extractChatJsonParts(`  \n\`\`\`json\n${PAYLOAD}\n\`\`\`\n`), { json: PAYLOAD, residual: "" });
    assert.deepEqual(extractChatJsonParts(`\`\`\`${PAYLOAD}\`\`\``), { json: PAYLOAD, residual: "" });
  });

  it("nothing when the object's one complete fence is longer than three markers, or tildes", () => {
    const fence = (open: string, close = open) => extractChatJsonParts(`${open}json\n${PAYLOAD}\n${close}`);
    assert.deepEqual(fence("````"), { json: PAYLOAD, residual: "" });
    assert.deepEqual(fence("`````", "``````"), { json: PAYLOAD, residual: "" }, "a closing run may be longer");
    assert.deepEqual(fence("~~~"), { json: PAYLOAD, residual: "" });
  });

  it("nothing when the object's fence runs to the end of the reply (CommonMark closes it there)", () => {
    for (const open of ["```json", "````", "~~~"]) {
      for (const end of ["", "\n", "\r\n", "\n  \n"]) {
        assert.deepEqual(extractChatJsonParts(`${open}\n${PAYLOAD}${end}`), { json: PAYLOAD, residual: "" }, JSON.stringify(open + end));
      }
    }
  });

  it("nothing when a bare fence line is the only text after the object (it opens an empty block)", () => {
    assert.deepEqual(extractChatJsonParts(`${PAYLOAD}\n\`\`\``), { json: PAYLOAD, residual: "" });
    assert.deepEqual(extractChatJsonParts(`${PAYLOAD}\n~~~~\n`), { json: PAYLOAD, residual: "" });
    assert.deepEqual(extractChatJsonParts(`\`\`\`json\n${PAYLOAD}\n\`\`\`\n\`\`\``), { json: PAYLOAD, residual: "" }, "after a complete pair");
    // a marker with an info string names content, and prose beside a stray marker is still prose
    assert.equal(extractChatJsonParts(`${PAYLOAD}\n\`\`\`json`)?.residual, "```json");
    assert.match(extractChatJsonParts(`P1 a.ts:1 BEFORE\n${PAYLOAD}\n\`\`\``)?.residual ?? "", /^P1 a\.ts:1 BEFORE$/);
  });

  it("an unclosed fence with text after the object is not the object's block: that text is residual", () => {
    assert.match(extractChatJsonParts(`\`\`\`json\n${PAYLOAD}\nP1 a.ts:1 AFTER`)?.residual ?? "", /P1 a\.ts:1 AFTER/);
    assert.match(extractChatJsonParts(`\`\`\`json\n${PAYLOAD}\n~~~`)?.residual ?? "", /^```json\s+~~~$/);
  });

  it("a fence that is not a matching pair around the object is kept, as is every fence in the prose", () => {
    // three backticks do not close a four-backtick fence (CommonMark), so neither run is a fence pair
    assert.match(extractChatJsonParts(`\`\`\`\`json\n${PAYLOAD}\n\`\`\``)?.residual ?? "", /^````json\s+```$/);
    assert.match(extractChatJsonParts(`~~~\n${PAYLOAD}\n\`\`\``)?.residual ?? "", /^~~~\s+```$/);
    // prose outside the fence keeps its own fence markers verbatim
    const prose = "P1 a.ts:1 see ```ts\nwrite(twice)\n``` above";
    assert.equal(extractChatJsonParts(`${prose}\n\`\`\`\`json\n${PAYLOAD}\n\`\`\`\``)?.residual, prose);
  });

  it("the prose around the accepted object, before or after it", () => {
    const before = extractChatJsonParts(`P1 a.ts:1 PROSE-FINDING: a duplicate request writes twice\n\`\`\`json\n${PAYLOAD}\n\`\`\``);
    assert.equal(before?.json, PAYLOAD);
    assert.equal(before?.residual, "P1 a.ts:1 PROSE-FINDING: a duplicate request writes twice");
    assert.equal(extractChatJsonParts(`${PAYLOAD}\nAlso P1 b.ts:2 AFTER`)?.residual, "Also P1 b.ts:2 AFTER");
    // an earlier object the extractor did not take is residual text too
    assert.match(extractChatJsonParts(`{"findings":[{"title":"EARLIER"}]}\n${PAYLOAD}`)?.residual ?? "", /EARLIER/);
  });

  it("the JSON is exactly what extractChatJson returns; no review object is null", () => {
    const text = `Thinking { "scratch": true }\n${PAYLOAD}\nDone.`;
    assert.equal(extractChatJsonParts(text)?.json, extractChatJson(text));
    assert.equal(extractChatJsonParts('{"foo":1}'), null);
    assert.equal(extractChatJsonParts("  "), null);
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
