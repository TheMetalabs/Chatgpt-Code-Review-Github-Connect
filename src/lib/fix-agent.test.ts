import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFixPrompt, runFixRound } from "./fix-agent.ts";
import type { GitDataApi } from "./fix-commit.ts";

function fakeApi(): { api: GitDataApi; committed: boolean } {
  const state = { committed: false };
  const api: GitDataApi = {
    async baseTreeSha() {
      return "base-tree";
    },
    async createBlob() {
      return "blob";
    },
    async createTree() {
      return "tree";
    },
    async createCommit() {
      return "commit-sha";
    },
    async updateBranchRef() {
      state.committed = true;
    },
  };
  return { api, get committed() { return state.committed; } } as { api: GitDataApi; committed: boolean };
}

const FIX_JSON = '{"summary":"remove bad state","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}';

describe("buildFixPrompt", () => {
  it("embeds the findings, the schema, and the §6 rules", () => {
    const p = buildFixPrompt({ findings: "P1: null deref at a.ts:3", files: [{ path: "src/a.ts", content: "export const a = 1;\n" }], reviewer: "chatgpt" });
    assert.match(p, /null deref at a\.ts:3/);
    assert.match(p, /"files": \[ \{ "path"/);
    assert.match(p, /never a diff/);
    assert.match(p, /src\/a\.ts/);
    assert.match(p, /export const a = 1;/); // head-pinned content embedded
    assert.match(p, /\(chatgpt\)/);
  });
});

describe("runFixRound", () => {
  const base = { prompt: "p", branch: "feat", baseCommitSha: "base1", message: "fix: x", allowedPaths: ["src/a.ts"] };

  it("apply mode commits the parsed change set and returns the commit sha", async () => {
    const { api, committed } = fakeApi();
    void committed;
    const res = await runFixRound({ requestFix: async () => FIX_JSON, api }, { ...base, mode: "apply" });
    assert.equal(res.ok, true);
    assert.equal(res.outcome, "applied");
    assert.equal(res.commitSha, "commit-sha");
    assert.deepEqual(res.files, [{ path: "src/a.ts", content: "export const a = 2;\n" }]);
  });

  it("suggest mode returns the change set WITHOUT committing", async () => {
    const f = fakeApi();
    const res = await runFixRound({ requestFix: async () => FIX_JSON, api: f.api }, { ...base, mode: "suggest" });
    assert.equal(res.outcome, "suggested");
    assert.deepEqual(res.files?.map((x) => x.path), ["src/a.ts"]);
    assert.equal(f.committed, false, "suggest must not push");
  });

  it("fails closed on an unparseable reply (no commit)", async () => {
    const f = fakeApi();
    const res = await runFixRound({ requestFix: async () => "sorry, I cannot", api: f.api }, { ...base, mode: "apply" });
    assert.equal(res.ok, false);
    assert.equal(res.outcome, "parse-failed");
    assert.equal(f.committed, false);
  });

  it("rejects an out-of-scope path before any commit (scope containment)", async () => {
    const f = fakeApi();
    const evil = '{"summary":"x","files":[{"path":".github/workflows/ci.yml","content":"pwn"}]}';
    const res = await runFixRound({ requestFix: async () => evil, api: f.api }, { ...base, mode: "apply" });
    assert.equal(res.ok, false);
    assert.equal(res.outcome, "scope-violation");
    assert.match(res.error ?? "", /\.github\/workflows/);
    assert.equal(f.committed, false, "out-of-scope fix must not push");
  });

  it("reports commit-failed without a partial success when the push throws", async () => {
    const f = fakeApi();
    f.api.createTree = async () => {
      throw new Error("422 tree");
    };
    const res = await runFixRound({ requestFix: async () => FIX_JSON, api: f.api }, { ...base, mode: "apply" });
    assert.equal(res.ok, false);
    assert.equal(res.outcome, "commit-failed");
    assert.match(res.error ?? "", /422 tree/);
    assert.equal(f.committed, false);
  });
});
