import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { normalizePem, pemIsUsable } from "./secrets.server.ts";
import { SECRET_MASK, SECRET_MASK_PEM, isMaskedSecret } from "./types.ts";

describe("github pem", () => {
  it("accepts a real PKCS8 PEM and rejects junk", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.equal(pemIsUsable(pem), true);
    assert.equal(pemIsUsable("not-a-key"), false);
    assert.equal(pemIsUsable(normalizePem(pem.replace(/\n/g, "\\n"))), true);
  });
});

describe("secret mask", () => {
  it("treats bullets and empty as keep-stored", () => {
    assert.equal(isMaskedSecret(""), true);
    assert.equal(isMaskedSecret(SECRET_MASK), true);
    assert.equal(isMaskedSecret(SECRET_MASK_PEM), true);
    assert.equal(isMaskedSecret("real-secret"), false);
  });
});
