import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signHub256, verifyHub256 } from "./hmac.ts";

describe("hmac", () => {
  it("accepts a matching signature", async () => {
    const body = "{\"ok\":true}";
    const sig = await signHub256("ashlar-dev-secret", body);
    assert.equal(await verifyHub256("ashlar-dev-secret", body, sig), true);
  });

  it("rejects a flipped nibble", async () => {
    const body = "{\"ok\":true}";
    const sig = await signHub256("ashlar-dev-secret", body);
    const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    assert.equal(await verifyHub256("ashlar-dev-secret", body, flipped), false);
  });

  it("rejects empty secret, missing header, and truncated hex", async () => {
    const body = "x";
    const sig = await signHub256("secret", body);
    assert.equal(await verifyHub256("", body, sig), false);
    assert.equal(await verifyHub256("secret", body, null), false);
    assert.equal(await verifyHub256("secret", body, "sha256=deadbeef"), false);
    assert.equal(await verifyHub256("secret", body, "sha1=" + sig.slice(7)), false);
  });

  it("accepts the first sha256= token in a GitHub multi-sig header", async () => {
    const body = "x";
    const sig = await signHub256("secret", body);
    assert.equal(await verifyHub256("secret", body, `${sig},sha256=${"aa".repeat(32)}`), true);
  });
});
