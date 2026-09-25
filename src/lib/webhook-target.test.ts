import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ignoredTarget } from "./webhook-target.ts";

describe("ignoredTarget: the repo#pr an ignored webhook delivery is about", () => {
  const repository = { full_name: "TheMetalabs/aicc-center" };
  it("names the PR of a PR comment, a review, a review comment and a pull_request event", () => {
    assert.equal(ignoredTarget({ repository, issue: { number: 455, pull_request: {} } }), "TheMetalabs/aicc-center#455 ");
    assert.equal(ignoredTarget({ repository, pull_request: { number: 455 } }), "TheMetalabs/aicc-center#455 ");
  });
  it("names only the repository for a push or a plain issue", () => {
    assert.equal(ignoredTarget({ repository, ref: "refs/heads/x" }), "TheMetalabs/aicc-center ");
    assert.equal(ignoredTarget({ repository, issue: { number: 3 } }), "TheMetalabs/aicc-center ");
  });
  it("uses nothing untrusted or malformed", () => {
    assert.equal(ignoredTarget(null), "");
    assert.equal(ignoredTarget({ repository: { full_name: "a b/c" }, pull_request: { number: 1 } }), "");
    assert.equal(ignoredTarget({ repository, pull_request: { number: "7; rm" } }), "TheMetalabs/aicc-center ");
  });
});
