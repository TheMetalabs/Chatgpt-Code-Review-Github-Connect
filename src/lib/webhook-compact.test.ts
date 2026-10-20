import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_TEXT_MAX, TRIGGER_TEXT_MAX, compactWebhookPayload } from "./webhook-compact.ts";
import { parseGitHubPayload } from "./github-payload.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

const hugeKorean = "이 PR은 대규모 리팩터링입니다. ".repeat(4_000); // ~80K chars, ~200 KB UTF-8

const comment = (body: string) => ({
  action: "created",
  installation: { id: 1 },
  repository: { full_name: "o/r" },
  sender: { login: "author" },
  issue: { number: 107, pull_request: {}, title: "Big PR", body: hugeKorean },
  comment: { id: 9, body },
});

describe("compactWebhookPayload", () => {
  it("cuts the embedded PR description of a comment event with a marker, keeps the comment", () => {
    const input = comment("@ashlar-bot review");
    const { payload, truncated } = compactWebhookPayload("issue_comment", input);
    const p = payload as ReturnType<typeof comment>;
    assert.deepEqual(truncated, ["issue.body"]);
    assert.ok(p.issue.body.length < CONTEXT_TEXT_MAX + 100);
    assert.match(p.issue.body, /\[ashlar: truncated \d+ of \d+ characters\]$/);
    assert.equal(p.comment.body, "@ashlar-bot review");
    assert.equal(input.issue.body, hugeKorean, "input not mutated");
  });

  for (const text of ["/review", "@ashlar-bot review"]) {
    it(`a ${text} comment on a PR with a huge description still parses as a review request`, () => {
      const { payload } = compactWebhookPayload("issue_comment", comment(text));
      const parsed = parseGitHubPayload("issue_comment", payload, DEFAULT_SETTINGS, {});
      assert.equal(parsed.ok, true);
      if (parsed.ok && parsed.kind === "review") {
        assert.equal(parsed.trigger, "issue_comment.mention");
        assert.equal(parsed.thread?.userText, text);
      } else assert.fail(`not a review: ${JSON.stringify(parsed)}`);
    });
  }

  it("keeps a pull_request event's body (trigger text) up to GitHub's body limit", () => {
    const body = "설명 ".repeat(20_000) + "@ashlar-bot review"; // 60K chars, mention at the end
    const pr = { action: "opened", pull_request: { number: 1, body } };
    const { payload, truncated } = compactWebhookPayload("pull_request", pr);
    assert.deepEqual(truncated, []);
    assert.equal((payload as typeof pr).pull_request.body, body);
    const over = compactWebhookPayload("pull_request", { pull_request: { body: "x".repeat(TRIGGER_TEXT_MAX + 5) } });
    assert.deepEqual(over.truncated, ["pull_request.body"]);
  });

  it("cuts pull_request.body in a review-comment event (context only there)", () => {
    const { truncated } = compactWebhookPayload("pull_request_review_comment", {
      pull_request: { body: hugeKorean },
      comment: { body: "@ashlar-bot review" },
    });
    assert.deepEqual(truncated, ["pull_request.body"]);
  });

  it("never splits a surrogate pair", () => {
    const text = "a".repeat(CONTEXT_TEXT_MAX - 1) + "😀".repeat(10);
    const { payload } = compactWebhookPayload("issue_comment", { issue: { body: text } });
    const cut = (payload as { issue: { body: string } }).issue.body.split("\n\n[ashlar:")[0];
    assert.equal(cut, "a".repeat(CONTEXT_TEXT_MAX - 1));
  });

  it("passes non-objects and small payloads through", () => {
    assert.deepEqual(compactWebhookPayload("ping", null), { payload: null, truncated: [] });
    const small = { issue: { body: "short" }, comment: { body: "hi" } };
    assert.equal(compactWebhookPayload("issue_comment", small).payload, small);
  });
});
