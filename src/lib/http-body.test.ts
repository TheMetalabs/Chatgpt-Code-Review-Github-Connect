import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_WEBHOOK_BODY, readBodyCapped } from "./http-body.ts";

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("http://ashlar.test/api/webhook", { method: "POST", headers, body });
}

describe("readBodyCapped", () => {
  it("reads a small JSON body", async () => {
    const body = "{\"ok\":true}";
    const out = await readBodyCapped(post(body, { "content-length": String(body.length) }));
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.body, body);
  });

  it("rejects a declared Content-Length over the cap without consuming a huge body", async () => {
    const out = await readBodyCapped(post("tiny", { "content-length": String(MAX_WEBHOOK_BODY + 1) }), MAX_WEBHOOK_BODY);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.reason, "payload too large");
  });

  it("rejects a body over the cap when Content-Length is omitted", async () => {
    const out = await readBodyCapped(post("x".repeat(80), {}), 64);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.reason, "payload too large");
  });

  it("accepts a body exactly at the cap with no Content-Length", async () => {
    const body = "y".repeat(32);
    const out = await readBodyCapped(post(body, {}), 32);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.body, body);
  });
});
