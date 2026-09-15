import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { overlayButtonKind, overlayButtonKindFromParts, overlayIsLive } from "./overlay-dismiss.ts";

describe("overlayButtonKind", () => {
  it("accepts Continue / 확인 and skips Upgrade", () => {
    assert.equal(overlayButtonKind("Continue"), "accept");
    assert.equal(overlayButtonKind("Got it"), "accept");
    assert.equal(overlayButtonKind("확인"), "accept");
    assert.equal(overlayButtonKind("Non-personalized"), "personal");
    assert.equal(overlayButtonKind("Upgrade to ChatGPT Plus"), null);
    assert.equal(overlayButtonKind("Log in"), null);
  });

  it("matches aria-label and text separately so Continue Continue still counts", () => {
    assert.equal(overlayButtonKind("Continue Continue"), null);
    assert.equal(overlayButtonKindFromParts("Continue", "Continue"), "accept");
    assert.equal(overlayButtonKindFromParts("", "Continue\nThis is a temporary chat"), "accept");
    assert.equal(overlayButtonKindFromParts("", "Don’t personalize"), "personal");
  });
});

describe("overlayIsLive", () => {
  it("ignores leftover hidden dialogs", () => {
    assert.equal(overlayIsLive({ width: 400, height: 300 }), true);
    assert.equal(overlayIsLive({ hidden: true, width: 400, height: 300 }), false);
    assert.equal(overlayIsLive({ ariaHidden: "true", width: 400, height: 300 }), false);
    assert.equal(overlayIsLive({ dataState: "closed", width: 400, height: 300 }), false);
    assert.equal(overlayIsLive({ display: "none", width: 400, height: 300 }), false);
    assert.equal(overlayIsLive({ width: 0, height: 0 }), false);
  });
});
