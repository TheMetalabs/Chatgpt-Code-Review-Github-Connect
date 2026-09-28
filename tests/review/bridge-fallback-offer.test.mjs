// verify-clean fallback: waive fresh chat starts, but still recover an already-started chat run.
import test from "node:test";
import assert from "node:assert/strict";
import { bridgeHarness, job } from "./load-source.mjs";

const FALLBACK = {
  localFallbackAt: 1,
  localReviewRole: "verify-clean",
  reviewProviders: ["chatgpt", "local"],
  trigger: "issue_comment.mention",
  chatPrompt: "Review fixture",
};

test("fallback waiver does not offer a fresh chat start with no prior run", () => {
  const { bridge } = bridgeHarness([job({ id: "job1", ...FALLBACK })]);
  assert.equal(bridge.nextBridgeJob("chrome1"), null);
});

test("fallback waiver still offers a chat provider that already has a live generating run", () => {
  const { bridge } = bridgeHarness([
    job({
      id: "job1",
      ...FALLBACK,
      // Not in attemptedProviders — generating alone proves the run started.
      generating: { chatgpt: true },
      providerProgress: {
        chatgpt: { runId: "run-live", stage: "generating", observedAt: Date.now(), receivedAt: Date.now() },
      },
    }),
  ]);
  const next = bridge.nextBridgeJob("chrome1");
  assert.ok(next, "in-flight chatgpt must remain offerable for recovery");
  assert.deepEqual(next.providers, ["chatgpt"]);
});

test("fallback waiver still recovers a bound chat run without attemptedProviders", () => {
  const now = Date.now();
  const { bridge } = bridgeHarness([
    job({
      id: "job1",
      ...FALLBACK,
      bridgeClientId: "chrome1",
      bridgeClaimedAt: now,
      bridgeLeaseId: "lease-1",
      providerProgress: {
        chatgpt: { runId: "run-bound", stage: "generating", observedAt: now, receivedAt: now },
      },
      generating: { chatgpt: true },
    }),
  ]);
  const recovered = bridge.recoverBridgeJob("chrome1", [
    { jobId: "job1", provider: "chatgpt", runId: "run-bound" },
  ]);
  assert.ok(recovered, "reconnect must recover the bound chat run during fallback waiver");
  assert.equal(recovered.provider, "chatgpt");
  assert.equal(recovered.resumeProviders.join(","), "chatgpt");
});
