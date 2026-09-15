import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubPayload } from "./github-payload.ts";

describe("parseGitHubPayload", () => {
  it("parses ping", () => {
    const d = parseGitHubPayload("ping", {});
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.kind, "ping");
  });

  it("parses pull_request.opened", () => {
    const d = parseGitHubPayload("pull_request", {
      action: "opened",
      installation: { id: 42 },
      repository: { full_name: "acme/pay", fork: false },
      sender: { login: "alice" },
      pull_request: {
        number: 412,
        title: "Handle Stripe webhook retries",
        body: "untrusted",
        draft: false,
        head: { sha: "abc", repo: { fork: false } },
        base: { sha: "def" },
        user: { login: "alice" },
      },
    });
    assert.equal(d.ok, true);
    if (d.ok && d.kind === "review") {
      assert.equal(d.trigger, "pull_request.opened");
      assert.equal(d.target.pr, 412);
      assert.equal(d.installationId, 42);
      assert.equal(d.untrustedBody, "untrusted");
    }
  });

  it("ignores issue comments that are not on a pull request", () => {
    const d = parseGitHubPayload("issue_comment", {
      action: "created",
      repository: { full_name: "acme/pay" },
      issue: { number: 9 },
      comment: { id: 1, body: "@ashlar-bot please" },
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.kind, "ignore");
  });

  it("parses a PR issue_comment as a mention trigger", () => {
    const d = parseGitHubPayload("issue_comment", {
      action: "created",
      repository: { full_name: "acme/pay" },
      sender: { login: "bob" },
      issue: { number: 412, pull_request: {}, title: "Handle Stripe" },
      comment: { id: 88, body: "@ashlar-bot focus on fulfillOrder" },
    });
    assert.equal(d.ok, true);
    if (d.ok && d.kind === "review") {
      assert.equal(d.trigger, "issue_comment.mention");
      assert.equal(d.thread?.userText, "@ashlar-bot focus on fulfillOrder");
      assert.equal(d.target.headSha, "");
    }
  });

  it("ignores unknown events", () => {
    const d = parseGitHubPayload("star", {});
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.kind, "ignore");
  });
});
