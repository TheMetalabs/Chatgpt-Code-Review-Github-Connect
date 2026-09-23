import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "./types.ts";
import { localReviewSkipRepos, providersForRepo } from "./local-review-scope.server.ts";

const settings = { ...DEFAULT_SETTINGS, reviewChatgpt: true, reviewGrok: false, reviewLocal: true, localLlmBaseUrl: "http://local/v1", localLlmModel: "m" };
const env = (v?: string) => (v === undefined ? {} : { ASHLAR_LOCAL_REVIEW_SKIP_REPOS: v }) as NodeJS.ProcessEnv;

describe("localReviewSkipRepos", () => {
  it("parses owner/repo entries separated by commas or whitespace, case-insensitively; drops malformed ones", () => {
    assert.deepEqual([...localReviewSkipRepos(env(" Acme/Pay, acme/web\nnot-a-repo,,a/b/c "))].sort(), ["acme/pay", "acme/web"]);
    assert.equal(localReviewSkipRepos(env()).size, 0);
    assert.equal(localReviewSkipRepos(env("")).size, 0);
  });
});

describe("providersForRepo", () => {
  it("unset → the global reviewers, unchanged", () => {
    assert.deepEqual(providersForRepo(settings, "acme", "pay", env()), ["chatgpt", "local"]);
  });

  it("a listed repository drops the local leg; other repositories keep it", () => {
    assert.deepEqual(providersForRepo(settings, "ACME", "Pay", env("acme/pay")), ["chatgpt"]);
    assert.deepEqual(providersForRepo(settings, "acme", "web", env("acme/pay")), ["chatgpt", "local"]);
  });

  it("never drops local when it is the only reviewer (the job would go unreviewed)", () => {
    const localOnly = { ...settings, reviewChatgpt: false };
    assert.deepEqual(providersForRepo(localOnly, "acme", "pay", env("acme/pay")), ["local"]);
  });

  it("is a no-op when the local leg is not enabled at all", () => {
    assert.deepEqual(providersForRepo({ ...settings, reviewLocal: false }, "acme", "pay", env("acme/pay")), ["chatgpt"]);
  });
});
