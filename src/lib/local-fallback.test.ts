import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldHoldForChat, shouldHoldForLocal, shouldStartLocalRace, stillRacing } from "./local-fallback.ts";

describe("shouldStartLocalRace", () => {
  it("starts local immediately when the setting is on", () => {
    assert.equal(
      shouldStartLocalRace({
        providers: ["chatgpt", "local"],
        status: "awaiting_chat",
        localDone: false,
        localStarted: false,
      }),
      true,
    );
    assert.equal(
      shouldStartLocalRace({
        providers: ["chatgpt"],
        status: "awaiting_chat",
        localDone: false,
        localStarted: false,
      }),
      false,
    );
  });

  it("does not start twice or after local already returned", () => {
    assert.equal(
      shouldStartLocalRace({
        providers: ["chatgpt", "local"],
        status: "awaiting_chat",
        localDone: false,
        localStarted: true,
      }),
      false,
    );
    assert.equal(
      shouldStartLocalRace({
        providers: ["chatgpt", "local"],
        status: "awaiting_chat",
        localDone: true,
        localStarted: false,
      }),
      false,
    );
  });
});

describe("stillRacing", () => {
  it("holds while ChatGPT is generating even if local already finished", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt", "local"],
        payloads: ["local"],
        localInFlight: false,
        generating: { chatgpt: true },
        claimed: true,
        connected: true,
      }),
      true,
    );
  });

  it("does not wait on Grok when Grok is not enabled", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt", "local"],
        payloads: ["chatgpt", "local"],
        localInFlight: false,
        generating: { chatgpt: false },
        claimed: true,
        connected: true,
      }),
      false,
    );
  });

  it("posts as soon as generating is false, with no time gate", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt"],
        payloads: ["chatgpt"],
        localInFlight: false,
        generating: { chatgpt: false },
        claimed: true,
        connected: true,
      }),
      false,
    );
  });

  it("holds while local is still generating", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt", "local"],
        payloads: ["chatgpt"],
        localInFlight: true,
        generating: { chatgpt: false },
        claimed: true,
        connected: true,
      }),
      true,
    );
  });
});

describe("shouldHoldForLocal", () => {
  it("holds a ChatGPT result while local is still running", () => {
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
  it("holds a local-only result while ChatGPT is still generating", () => {
    assert.equal(
      shouldHoldForChat({
        providers: ["chatgpt", "local"],
        haveChat: false,
        chatSkipped: false,
        claimed: true,
        connected: true,
        generating: { chatgpt: true },
      }),
      true,
    );
  });

  it("does not wait on a disabled Grok tab", () => {
    assert.equal(
      shouldHoldForChat({
        providers: ["chatgpt", "local"],
        haveChat: true,
        chatSkipped: false,
        claimed: true,
        connected: true,
        payloads: ["chatgpt"],
        generating: { chatgpt: false },
      }),
      false,
    );
  });
});
