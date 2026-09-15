import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composerAccepted } from "./composer-has.ts";

describe("composerAccepted", () => {
  it("rejects a prefix-only paste of a long prompt", () => {
    const want = "A".repeat(80) + "TAILTAILTAILTAILTAILTAILTAILTAILTAILTAIL";
    assert.equal(composerAccepted(want.slice(0, 48), want), false);
    assert.equal(composerAccepted(want, want), true);
  });
});
