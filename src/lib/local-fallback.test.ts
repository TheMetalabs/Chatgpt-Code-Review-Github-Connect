import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_FALLBACK_CLAIMED_MS,
  LOCAL_FALLBACK_MS,
  LOCAL_HOLD_MS,
  shouldHoldForChat,
  shouldHoldForLocal,
  shouldStartLocalFallback,
} from "./local-fallback.ts";

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

describe("shouldHoldForLocal", () => {
  it("waits longer than a single local completion so queued jobs can finish", () => {
    assert.ok(LOCAL_HOLD_MS > 210_000);
  });
  it("holds a ChatGPT-only result while local is still running", () => {
    assert.equal(
      shouldHoldForLocal({
        providers: ["chatgpt", "local"],
        haveLocal: false,
        localSkipped: false,
        localInFlight: true,
      }),
      true,
    );
  });

  it("does not hold when local is dead, done, or not configured", () => {
    assert.equal(
      shouldHoldForLocal({
        providers: ["chatgpt", "local"],
        haveLocal: false,
        localSkipped: false,
        localInFlight: false,
      }),
      false,
    );
    assert.equal(
      shouldHoldForLocal({
        providers: ["chatgpt", "local"],
        haveLocal: true,
        localSkipped: false,
        localInFlight: true,
      }),
      false,
    );
    assert.equal(
      shouldHoldForLocal({
        providers: ["chatgpt"],
        haveLocal: false,
        localSkipped: false,
        localInFlight: true,
      }),
      false,
    );
  });
});

describe("shouldHoldForChat", () => {
  it("holds a local-only result while Chrome is still connected", () => {
    assert.equal(
      shouldHoldForChat({
        providers: ["chatgpt", "local"],
        haveChat: false,
        chatSkipped: false,
        claimed: true,
        connected: true,
      }),
      true,
    );
    assert.equal(
      shouldHoldForChat({
        providers: ["chatgpt", "local"],
        haveChat: false,
        chatSkipped: false,
        claimed: false,
        connected: false,
      }),
      false,
    );
  });

  it("does not keep waiting after ChatGPT already ran once (no re-prompt)", () => {
    assert.equal(
      shouldHoldForChat({
        providers: ["chatgpt", "local"],
        haveChat: false,
        chatSkipped: false,
        claimed: false,
        connected: true,
        allChatAttempted: true,
      }),
      false,
    );
    assert.equal(
      shouldHoldForChat({
        providers: ["chatgpt", "local"],
        haveChat: false,
        chatSkipped: false,
        claimed: true,
        connected: true,
        allChatAttempted: true,
      }),
      true,
    );
  });
});
