import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commitFiles, type GitDataApi } from "./fix-commit.ts";

function fakeApi(): { api: GitDataApi; calls: string[] } {
  const calls: string[] = [];
  const api: GitDataApi = {
    async baseTreeSha(commitSha) {
      calls.push(`baseTree(${commitSha})`);
      return `tree-of-${commitSha}`;
    },
    async createBlob(content) {
      calls.push(`blob(${content.length}b)`);
      return `blob-${content.slice(0, 3)}`;
    },
    async createTree(baseTreeSha, entries) {
      calls.push(`tree(${baseTreeSha};${entries.map((e) => `${e.path}=${e.sha}`).join(",")})`);
      return "new-tree";
    },
    async createCommit(message, treeSha, parentSha) {
      calls.push(`commit("${message}";${treeSha};${parentSha})`);
      return "new-commit";
    },
    async updateBranchRef(branch, commitSha, expectedOldSha) {
      calls.push(`ref(${branch}:${expectedOldSha}->${commitSha})`);
    },
  };
  return { api, calls };
}

describe("commitFiles", () => {
  it("does blob→tree→commit→ref in order and returns the commit sha", async () => {
    const { api, calls } = fakeApi();
    const res = await commitFiles(api, {
      branch: "feature",
      baseCommitSha: "base1",
      message: "fix: apply review",
      files: [
        { path: "src/a.ts", content: "aaa" },
        { path: "src/b.ts", content: "bbbb" },
      ],
    });
    assert.deepEqual(res, { ok: true, commitSha: "new-commit" });
    assert.deepEqual(calls, [
      "baseTree(base1)",
      "blob(3b)",
      "blob(4b)",
      "tree(tree-of-base1;src/a.ts=blob-aaa,src/b.ts=blob-bbb)",
      'commit("fix: apply review";new-tree;base1)',
      "ref(feature:base1->new-commit)", // conditional on the reviewed base
    ]);
  });

  it("refuses an empty change set", async () => {
    const { api, calls } = fakeApi();
    const res = await commitFiles(api, { branch: "f", baseCommitSha: "b", message: "m", files: [] });
    assert.deepEqual(res, { ok: false, error: "no files to commit" });
    assert.deepEqual(calls, []);
  });

  it("fails closed (no ref move) when a step throws", async () => {
    const { api, calls } = fakeApi();
    api.createTree = async () => {
      throw new Error("tree API 422");
    };
    const res = await commitFiles(api, {
      branch: "f",
      baseCommitSha: "b",
      message: "m",
      files: [{ path: "a.ts", content: "x" }],
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /tree API 422/);
    assert.ok(!calls.some((c) => c.startsWith("ref(")), "branch ref must not move on failure");
  });
});
