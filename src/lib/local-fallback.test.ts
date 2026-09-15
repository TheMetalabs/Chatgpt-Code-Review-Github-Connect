import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldStartLocalRace, stillRacing } from "./local-fallback.ts";

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
});

describe("stillRacing", () => {
  it("holds ChatGPT while it is generating even if local already finished", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt", "local"],
        payloads: ["local"],
        localInFlight: false,
        generating: { chatgpt: true },
      }),
      true,
    );
  });

  it("does not wait on Grok when Grok is not in providers", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt", "local"],
        payloads: ["chatgpt", "local"],
        localInFlight: false,
        generating: { chatgpt: false },
      }),
      false,
    );
  });

  it("treats an explicit quota outcome as finished, not a bare false flag", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt", "grok"],
        payloads: ["chatgpt"],
        localInFlight: false,
        generating: { chatgpt: false, grok: false },
        providerErrors: {grok: {code: "quota", message: "usage limit"}},
      }),
      false,
    );
  });

  it("holds local until skip or JSON, even before inFlight is set", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt", "local"],
        payloads: ["chatgpt"],
        localInFlight: false,
        generating: { chatgpt: false },
      }),
      true,
    );
  });

  it("holds before any ping — unknown generating is still running", () => {
    assert.equal(
      stillRacing({
        providers: ["chatgpt"],
        payloads: [],
        localInFlight: false,
      }),
      true,
    );
  });
});
