import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatStalled, localVerifies, racingProviders, releaseLocalAsFallback, shouldStartLocalLeg, shouldStartLocalRace, stillRacing, verifyCleanNote, verifyCleanStep } from "./local-fallback.ts";

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

describe("verify-clean local role", () => {
  const both = ["chatgpt", "local"] as const;
  const base = { status: "awaiting_chat" as const, localDone: false, localStarted: false };

  it("is a verifier only with the role AND both a chat reviewer and local (race / missing role = today)", () => {
    assert.equal(localVerifies({ role: "verify-clean", providers: [...both] }), true);
    assert.equal(localVerifies({ role: "race", providers: [...both] }), false);
    assert.equal(localVerifies({ role: undefined, providers: [...both] }), false);
    assert.equal(localVerifies({ role: "verify-clean", providers: ["local"] }), false, "local only behaves as today");
    assert.equal(localVerifies({ role: "verify-clean", providers: ["chatgpt", "grok"] }), false, "no local: nothing to verify");
  });

  it("holds local back until it is released; race starts it at once", () => {
    assert.equal(shouldStartLocalLeg({ role: "race", providers: [...both], localReleased: false, ...base }), true);
    assert.equal(shouldStartLocalLeg({ role: "verify-clean", providers: [...both], localReleased: false, ...base }), false);
    assert.equal(shouldStartLocalLeg({ role: "verify-clean", providers: [...both], localReleased: true, ...base }), true);
    assert.equal(shouldStartLocalLeg({ role: "verify-clean", providers: ["local"], localReleased: false, ...base }), true);
    assert.equal(shouldStartLocalLeg({ role: "verify-clean", providers: [...both], localReleased: true, ...base, localDone: true }), false);
  });

  it("does not wait on a held-back local leg; waits on it once released", () => {
    assert.deepEqual(racingProviders({ role: "verify-clean", providers: [...both], localReleased: false }), ["chatgpt"]);
    assert.deepEqual(racingProviders({ role: "verify-clean", providers: [...both], localReleased: true }), ["chatgpt", "local"]);
    assert.deepEqual(racingProviders({ role: "race", providers: [...both], localReleased: false }), ["chatgpt", "local"]);
    // The job may post (nothing racing) once chat is done, before local ever started...
    assert.equal(stillRacing({ providers: racingProviders({ role: "verify-clean", providers: [...both], localReleased: false }), payloads: ["chatgpt"], localInFlight: false }), false);
    // ...but not while the released verification leg is still running.
    assert.equal(stillRacing({ providers: racingProviders({ role: "verify-clean", providers: [...both], localReleased: true }), payloads: ["chatgpt"], localInFlight: true }), true);
  });

  it("releases local as today's fallback only when chat finished without a usable result", () => {
    const v = { role: "verify-clean" as const, providers: [...both], localReleased: false };
    assert.equal(releaseLocalAsFallback({ ...v, chatRacing: false, usableChat: false }), true);
    assert.equal(releaseLocalAsFallback({ ...v, chatRacing: true, usableChat: false }), false, "chat still running");
    assert.equal(releaseLocalAsFallback({ ...v, chatRacing: false, usableChat: true }), false, "chat has a result to judge");
    assert.equal(releaseLocalAsFallback({ ...v, localReleased: true, chatRacing: false, usableChat: false }), false);
    assert.equal(releaseLocalAsFallback({ ...v, role: "race", chatRacing: false, usableChat: false }), false);
    assert.equal(releaseLocalAsFallback({ ...v, chatRacing: true, usableChat: false, chatStalled: true }), true, "stalled chat (bridge offline) releases local");
    assert.equal(releaseLocalAsFallback({ ...v, chatRacing: true, usableChat: true, chatStalled: true }), false, "a usable chat result is judged, not replaced");
  });

  it("treats chat as stalled only after the bridge has been disconnected past the grace (never by job age or claim lease)", () => {
    const G = 120_000;
    const s = { chatProgress: false, connected: false, disconnectedAt: 1_000_000, now: 1_000_000, graceMs: G };
    assert.equal(chatStalled(s), false, "just disconnected: within the grace");
    assert.equal(chatStalled({ ...s, now: 1_000_000 + G }), true, "disconnected past BRIDGE_CONNECTED_MS");
    assert.equal(chatStalled({ ...s, now: 1_000_000 + G, chatProgress: true }), false, "progress is never stalled");
    assert.equal(chatStalled({ ...s, disconnectedAt: undefined, now: 9_999_999_999 }), false, "unknown disconnect time never stalls");
    // A connected bridge never releases local by time: past BRIDGE_CLAIM_MS, stale lease, or old job.
    assert.equal(chatStalled({ ...s, connected: true, disconnectedAt: undefined, now: 1_000_000 + 20 * 60_000 + 1 }), false, "connected, no payload, past BRIDGE_CLAIM_MS");
    assert.equal(chatStalled({ ...s, connected: true, disconnectedAt: 0, now: 9_999_999_999 }), false, "connected with a stale claim lease");
    // Job older than the grace, but the bridge only just disconnected: waits for the disconnect itself.
    const now = 5_000_000;
    assert.equal(chatStalled({ ...s, disconnectedAt: now - 1, now }), false, "job age is not the basis");
    assert.equal(chatStalled({ ...s, disconnectedAt: now - 1, now: now - 1 + G }), true);
  });

  it("decides what to post in each case", () => {
    const v = { role: "verify-clean" as const, providers: [...both], verifyStarted: false, fallback: false, salvagedRaw: false, localStructured: false };
    assert.equal(verifyCleanStep({ ...v, findings: 2 }), "post-chat", "chat findings post now");
    assert.equal(verifyCleanStep({ ...v, findings: 0, salvagedRaw: true }), "post-chat", "a salvaged reply is not clean");
    assert.equal(verifyCleanStep({ ...v, findings: 0 }), "start-verify", "clean chat starts the verification round");
    assert.equal(verifyCleanStep({ ...v, verifyStarted: true, findings: 3, localStructured: true }), "post-verified", "local findings post");
    assert.equal(verifyCleanStep({ ...v, verifyStarted: true, findings: 0, localStructured: true }), "post-verified", "both clean: clean review");
    assert.equal(verifyCleanStep({ ...v, verifyStarted: true, findings: 0, localStructured: false }), "post-chat-unverified", "local failed");
    // a salvaged (unparseable) local reply is a payload but no verdict: verification did not complete
    assert.equal(verifyCleanStep({ ...v, verifyStarted: true, findings: 0, salvagedRaw: true, localStructured: false }), "post-chat-unverified", "unparseable local reply");
    assert.equal(verifyCleanStep({ ...v, fallback: true, findings: 0 }), "post", "local as chat-down fallback posts as today");
    assert.equal(verifyCleanStep({ ...v, role: "race", findings: 0 }), "post");
  });

  it("names which reviewer produced the result", () => {
    assert.equal(verifyCleanNote({ chat: ["chatgpt"], step: "post-verified", localFindings: 2 }), "chatgpt found nothing; local verification found 2.");
    assert.equal(verifyCleanNote({ chat: ["chatgpt"], step: "post-verified", localFindings: 0 }), "chatgpt found nothing; local verification agreed.");
    assert.match(verifyCleanNote({ chat: ["chatgpt"], step: "post-chat-unverified", localFindings: 0, localError: "timeout" }), /did not complete \(timeout\)/);
    assert.equal(verifyCleanNote({ chat: ["chatgpt"], step: "post-chat", localFindings: 0 }), "");
  });
});
