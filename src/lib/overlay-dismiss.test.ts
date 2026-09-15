import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { overlayButtonKind } from "./overlay-dismiss.ts";

describe("overlayButtonKind", () => {
  it("accepts Continue / 확인 and skips Upgrade", () => {
    assert.equal(overlayButtonKind("Continue"), "accept");
    assert.equal(overlayButtonKind("Got it"), "accept");
    assert.equal(overlayButtonKind("확인"), "accept");
    assert.equal(overlayButtonKind("Non-personalized"), "personal");
    assert.equal(overlayButtonKind("Upgrade to ChatGPT Plus"), null);
    assert.equal(overlayButtonKind("Log in"), null);
  });
});
