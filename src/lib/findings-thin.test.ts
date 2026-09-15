import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findingsJsonTooThin } from "./findings-thin.ts";

describe("findingsJsonTooThin", () => {
  it("rejects empty findings with no investigated_safe", () => {
    assert.equal(findingsJsonTooThin('{"findings":[],"merge_recommendation":"COMMENT"}'), true);
    assert.equal(findingsJsonTooThin('{"findings":[],"investigated_safe":[]}'), true);
  });

  it("accepts empty findings that list checked files, or any real finding", () => {
    assert.equal(
      findingsJsonTooThin('{"findings":[],"investigated_safe":["src/lib/overlay.js: dismiss path is safe"]}'),
      false,
    );
    assert.equal(findingsJsonTooThin('{"findings":[{"title":"x"}]}'), false);
  });
});
