import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commentableRightLines, isReviewLineError, resolveLineFromSnippet, rightSideLines, snapToCommentableLine } from "./review-diff.ts";

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
