import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_CONNECTED_MS } from "./types.ts";

describe("bridge connected window", () => {
  it("outlasts Chrome's 1-minute MV3 alarm clamp", () => {
    assert.ok(BRIDGE_CONNECTED_MS >= 60_000);
  });
});
