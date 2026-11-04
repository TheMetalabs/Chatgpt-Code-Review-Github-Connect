import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commentableRightLines, diffFileBlocks, isReviewLineError, resolveLineFromSnippet, rightSideLines, SNAPSHOT_DIFF_SEP, snapshotDiffBlock, snapToCommentableLine, toSnapshotDiff } from "./review-diff.ts";

// Two hunks whose NEW-side line numbers are far apart (10s and 80s), with a line that appears in
// both hunks ("return null;"), a unique specific line, and a lone "}" — enough to exercise every
// guard in resolveLineFromSnippet.
const SNIPPET_DIFF = `--- src/foo.ts
@@ -10,2 +10,3 @@
 keep1
+const unique = compute(alpha, beta);
+return null;
@@ -40,1 +80,4 @@
 keep2
+return null;
+another(gamma);
+}
`;

describe("rightSideLines", () => {
  it("captures new-side line numbers and marker-stripped content", () => {
    const rl = rightSideLines(SNIPPET_DIFF).get("src/foo.ts");
    assert.ok(rl);
    assert.deepEqual(rl, [
      { line: 10, content: "keep1" },
      { line: 11, content: "const unique = compute(alpha, beta);" },
      { line: 12, content: "return null;" },
      { line: 80, content: "keep2" },
      { line: 81, content: "return null;" },
      { line: 82, content: "another(gamma);" },
      { line: 83, content: "}" },
    ]);
  });
});

describe("resolveLineFromSnippet", () => {
  const rl = rightSideLines(SNIPPET_DIFF);

  it("resolves a unique specific line to its real number (ignores any drifted model line)", () => {
    assert.equal(resolveLineFromSnippet("src/foo.ts", "const unique = compute(alpha, beta);", rl), 11);
    assert.equal(resolveLineFromSnippet("src/foo.ts", "another(gamma);", rl), 82);
  });

  it("declines an ambiguous snippet that matches more than one line (never guesses)", () => {
    // "return null;" is at both line 12 and line 81 — no mislocation, decline to the caller's fallback.
    assert.equal(resolveLineFromSnippet("src/foo.ts", "return null;", rl), null);
  });

  it("declines a trivial single line even when it is unique", () => {
    assert.equal(resolveLineFromSnippet("src/foo.ts", "}", rl), null);
  });

  it("declines when the snippet matches nothing (e.g. a hallucinated quote)", () => {
    assert.equal(resolveLineFromSnippet("src/foo.ts", "nonexistent_call(zzz);", rl), null);
  });

  it("declines for a file that has no diff", () => {
    assert.equal(resolveLineFromSnippet("src/other.ts", "const unique = compute(alpha, beta);", rl), null);
  });

  it("matches ignoring leading diff markers and surrounding whitespace", () => {
    assert.equal(resolveLineFromSnippet("src/foo.ts", "+  const unique = compute(alpha, beta);", rl), 11);
  });
});

describe("commentableRightLines", () => {
  it("accepts every line of a new-file GitHub patch", () => {
    const diff = `--- frontend/src/page-lib/store/classes/components/ClassCreateDialog.js
@@ -0,0 +1,3 @@
+one
+two
+three
`;
    const map = commentableRightLines(diff);
    const set = map.get("frontend/src/page-lib/store/classes/components/ClassCreateDialog.js");
    assert.ok(set);
    assert.equal(set.has(1), true);
    assert.equal(set.has(3), true);
    assert.equal(snapToCommentableLine("frontend/src/page-lib/store/classes/components/ClassCreateDialog.js", 2, map), 2);
  });

  it("rejects a line that is not in any hunk", () => {
    const diff = `--- src/pages/store/classes/index.js
@@ -270,4 +270,4 @@
 const x = 1
-old
+new
 keep
`;
    const map = commentableRightLines(diff);
    assert.equal(snapToCommentableLine("src/pages/store/classes/index.js", 10, map), null);
    assert.equal(snapToCommentableLine("src/pages/store/classes/index.js", 271, map), 271);
  });
});

describe("isReviewLineError", () => {
  it("matches GitHub 422 copy", () => {
    assert.equal(isReviewLineError('pull_request_review_thread.line must be part of the diff'), true);
    assert.equal(isReviewLineError("not found"), false);
  });
});

describe("diffFileBlocks", () => {
  // `--- removed sql comment` is the removed line `-- removed sql comment`: the hunk counts (old side 3
  // lines) say it belongs to the hunk, so it is not read as the next file.
  const PATCH_A = "@@ -1,3 +1,2 @@\n-- old comment\n+-- new comment\n select 1;\n--- removed sql comment";
  const PATCH_B = "@@ -0,0 +1,2 @@\n+export const x = 1;\n+export const y = 2;";

  it("reads the live snapshot's compact `--- path` blocks (fetchPullSnapshot), paths verbatim", () => {
    const live = [snapshotDiffBlock("db/q.sql", PATCH_A), snapshotDiffBlock("a/lib.ts", PATCH_B)].join(SNAPSHOT_DIFF_SEP);
    const blocks = diffFileBlocks(live);
    assert.deepEqual(blocks.map((b) => b.path), ["db/q.sql", "a/lib.ts"], "a real path that begins with a/ keeps it");
    assert.deepEqual(blocks[0].lines, PATCH_A.split("\n"), "a removed `-- x` line inside the hunk stays in it");
    assert.deepEqual(blocks[1].lines, PATCH_B.split("\n"));
  });

  it("reads git diff output: headers, new/deleted/renamed files, a/ b/ prefixes", () => {
    const git = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-export {};",
      "diff --git a/src/born.ts b/src/born.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/born.ts",
      "@@ -0,0 +1,2 @@",
      "+export const x = 1;",
      "+export const y = 2;",
      "",
    ].join("\n");
    const blocks = diffFileBlocks(git);
    assert.deepEqual(blocks.map((b) => b.path), ["src/new.ts", "src/gone.ts", "src/born.ts"]);
    assert.deepEqual(blocks[0].lines, ["@@ -1 +1 @@", "-const a = 1;", "+const a = 2;"]);
    assert.deepEqual(blocks[2].lines, PATCH_B.split("\n"));
    // Converted to the live shape, the same files and hunks come back.
    assert.deepEqual(diffFileBlocks(toSnapshotDiff(git)), blocks);
    assert.match(toSnapshotDiff(git), /^--- src\/new\.ts\n@@ -1 \+1 @@\n/);
  });

  it("reads `---`/`+++` headers without `diff --git` lines (diff -u)", () => {
    const blocks = diffFileBlocks("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n");
    assert.deepEqual(blocks.map((b) => [b.path, b.lines.length]), [["x.ts", 3], ["y.ts", 3]]);
  });
});
