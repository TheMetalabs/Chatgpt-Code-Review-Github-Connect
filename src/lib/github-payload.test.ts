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

  it("attaches a parsed review-loop directive to the issue_comment thread", () => {
    const d = parseGitHubPayload("issue_comment", {
      action: "created",
      repository: { full_name: "acme/pay" },
      sender: { login: "bob" },
      issue: { number: 412, pull_request: {}, title: "Handle Stripe" },
      comment: { id: 88, body: "/review-loop apply" },
    });
    assert.equal(d.ok, true);
    if (d.ok && d.kind === "review") {
      assert.deepEqual(d.thread?.loop, { kind: "start", mode: "apply" });
    }
  });

  it("leaves loop undefined for a plain mention", () => {
    const d = parseGitHubPayload("issue_comment", {
      action: "created",
      repository: { full_name: "acme/pay" },
      sender: { login: "bob" },
      issue: { number: 412, pull_request: {}, title: "Handle Stripe" },
      comment: { id: 88, body: "@ashlar-bot review" },
    });
    assert.equal(d.ok, true);
    if (d.ok && d.kind === "review") {
      assert.equal(d.thread?.loop, undefined);
    }
  });

  it("treats a /review-loop directive in a PR body as a review trigger without a mention token", () => {
    const d = parseGitHubPayload("pull_request", {
      action: "opened",
      installation: { id: 7 },
      repository: { full_name: "acme/pay", fork: false },
      sender: { login: "alice" },
      pull_request: {
        number: 500,
        title: "Add retries",
        body: "/review-loop apply",
        draft: false,
        head: { sha: "h1", repo: { fork: false } },
        base: { sha: "b1" },
        user: { login: "alice" },
      },
    });
    assert.equal(d.ok, true);
    if (d.ok && d.kind === "review") {
      assert.equal(d.trigger, "pull_request.body_mention");
      assert.equal(d.thread?.loop?.kind, "start");
      assert.equal(d.thread?.loop?.mode, "apply");
    }
  });

  it("does not re-trigger on an unrelated edit to a PR body that already carried /review-loop", () => {
    const d = parseGitHubPayload("pull_request", {
      action: "edited",
      repository: { full_name: "acme/pay", fork: false },
      sender: { login: "alice" },
      changes: { body: { from: "/review-loop\n\nold" } },
      pull_request: {
        number: 500,
        title: "Add retries",
        body: "/review-loop\n\nnew text",
        draft: false,
        head: { sha: "h1", repo: { fork: false } },
        base: { sha: "b1" },
        user: { login: "alice" },
      },
    });
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.kind, "ignore");
  });

  it("delivers a changed PR-body directive on edit (start -> stop, suggest -> apply)", () => {
    const mk = (from: string, to: string) => parseGitHubPayload("pull_request", {
      action: "edited",
      repository: { full_name: "acme/pay", fork: false },
      sender: { login: "alice" },
      changes: { body: { from } },
      pull_request: { number: 500, title: "t", body: to, draft: false, head: { sha: "h1", repo: { fork: false } }, base: { sha: "b1" }, user: { login: "alice" } },
    });
    for (const [from, to] of [["/review-loop", "/review-loop stop"], ["/review-loop", "/review-loop apply"], ["/review-loop stop", "/review-loop"]]) {
      const d = mk(from, to);
      assert.equal(d.ok, true, `${from} -> ${to}`);
      if (d.ok) assert.equal(d.kind, "review", `${from} -> ${to} should be delivered`);
    }
    // an unchanged retained directive is an unrelated edit
    const same = mk("/review-loop\n\nold", "/review-loop\n\nnew");
    assert.equal(same.ok, true);
    if (same.ok) assert.equal(same.kind, "ignore");
  });

  it("ignores unknown events", () => {
    const d = parseGitHubPayload("star", {});
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.kind, "ignore");
  });
});
