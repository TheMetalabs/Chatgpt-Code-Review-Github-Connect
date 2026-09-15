import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBridgeToken } from "./bridge-token.ts";

describe("resolveBridgeToken", () => {
  it("reuses the env token across restarts and only persists when missing", () => {
    const generated = resolveBridgeToken("", () => "new-token-1");
    assert.deepEqual(generated, { token: "new-token-1", persist: true });
    const reused = resolveBridgeToken("  kept-token  ", () => "new-token-2");
    assert.deepEqual(reused, { token: "kept-token", persist: false });
  });
});
