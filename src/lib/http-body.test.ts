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

describe("MAX_WEBHOOK_BODY", () => {
  it("admits an 85 KB PR description event (WalkieBoard #107) and keeps a hard cap", async () => {
    assert.ok(MAX_WEBHOOK_BODY >= 1024 * 1024, "a cap far above GitHub's per-body limits");
    assert.ok(MAX_WEBHOOK_BODY <= 25 * 1024 * 1024, "never above GitHub's own 25 MB delivery cap");
    const body = JSON.stringify({ issue: { body: "가".repeat(28_000) }, comment: { body: "/review" } });
    assert.ok(new TextEncoder().encode(body).byteLength > 65_536);
    const out = await readBodyCapped(post(body, {}));
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.body, body);
  });

  it("reports how many bytes were seen when refusing", async () => {
    const declared = await readBodyCapped(post("tiny", { "content-length": "999" }), 10);
    assert.deepEqual(declared, { ok: false, reason: "payload too large", bytes: 999 });
    const streamed = await readBodyCapped(post("z".repeat(50), {}), 10);
    assert.equal(streamed.ok, false);
    if (!streamed.ok) assert.ok(streamed.bytes > 10);
  });
});
