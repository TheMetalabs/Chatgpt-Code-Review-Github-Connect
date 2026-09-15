import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commentableRightLines, isReviewLineError, snapToCommentableLine } from "./review-diff.ts";

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
