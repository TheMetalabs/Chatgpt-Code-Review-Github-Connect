import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_FALLBACK_CLAIMED_MS, LOCAL_FALLBACK_MS, shouldStartLocalFallback } from "./local-fallback.ts";

const base = {
  providers: ["chatgpt", "grok", "local"] as ["chatgpt", "grok", "local"],
  status: "awaiting_chat" as const,
  connected: false,
  claimed: false,
  localDone: false,
  localStarted: false,
  waitedMs: 0,
};

describe("shouldStartLocalFallback", () => {
  it("does not start when only local is configured — that path runs immediately", () => {
    assert.equal(shouldStartLocalFallback({ ...base, providers: ["local"], waitedMs: LOCAL_FALLBACK_MS }), false);
  });

  it("waits for Chrome, then starts local if the bridge never claims", () => {
    assert.equal(shouldStartLocalFallback({ ...base, waitedMs: LOCAL_FALLBACK_MS - 1 }), false);
    assert.equal(shouldStartLocalFallback({ ...base, waitedMs: LOCAL_FALLBACK_MS }), true);
  });

  it("waits longer when Chrome already claimed the job", () => {
    assert.equal(
      shouldStartLocalFallback({ ...base, claimed: true, connected: true, waitedMs: LOCAL_FALLBACK_MS }),
      false,
    );
    assert.equal(
      shouldStartLocalFallback({ ...base, claimed: true, connected: true, waitedMs: LOCAL_FALLBACK_CLAIMED_MS }),
      true,
    );
  });

  it("does not start twice or after local already returned", () => {
    assert.equal(shouldStartLocalFallback({ ...base, localStarted: true, waitedMs: LOCAL_FALLBACK_MS }), false);
    assert.equal(shouldStartLocalFallback({ ...base, localDone: true, waitedMs: LOCAL_FALLBACK_MS }), false);
  });
});
