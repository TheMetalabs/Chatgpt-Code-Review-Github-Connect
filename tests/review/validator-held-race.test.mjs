// Held-local release must not race with a stale validator transition: validator ownership is a
// generation token. Watcher release without a matching generation cannot steal status===validator;
// submitHarborChat must re-check ownership before merge/release/skip.
import test from "node:test";
import assert from "node:assert/strict";
import { source } from "./load-source.mjs";
import { canReleaseHeldLocal, ownsValidatorGeneration } from "../../src/lib/local-fallback.ts";

const harbor = source("src/lib/harbor.server.ts");

function fnBody(name) {
  const start = harbor.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} not found`);
  return harbor.slice(start, harbor.indexOf("\n}\n", start) + 2);
}

test("submitHarborChat bumps validatorGeneration on lock and passes it to releaseHeldLocal", () => {
  const body = fnBody("submitHarborChat");
  assert.match(body, /validatorGeneration = \(j\.validatorGeneration \?\? 0\) \+ 1/);
  assert.match(body, /status: "validator", validatorGeneration/);
  assert.match(body, /releaseHeldLocal\([\s\S]*\{ validatorGeneration \}\)/);
  assert.match(body, /stillOwnsValidator/);
  assert.match(body, /stale validator/);
});

test("releaseHeldLocal refuses validator without matching generation (watcher cannot steal)", () => {
  const body = fnBody("releaseHeldLocal");
  assert.match(body, /canReleaseHeldLocal\(j, opts\)/);
  assert.match(body, /validatorGeneration\?: number/);
});

test("runtime race matrix: stale validator cannot release or overwrite after held-local release", () => {
  let job = { status: "validator", validatorGeneration: 1 };
  assert.equal(ownsValidatorGeneration(job, 1), true);
  assert.equal(canReleaseHeldLocal(job), false);
  assert.equal(canReleaseHeldLocal(job, { validatorGeneration: 1 }), true);
  job = { status: "awaiting_chat", validatorGeneration: 1, localFallbackAt: 99 };
  assert.equal(ownsValidatorGeneration(job, 1), false);
  assert.equal(canReleaseHeldLocal(job, { validatorGeneration: 1 }), false);
  job = { status: "validator", validatorGeneration: 2 };
  assert.equal(ownsValidatorGeneration(job, 1), false);
  assert.equal(ownsValidatorGeneration(job, 2), true);
  assert.equal(canReleaseHeldLocal(job, { validatorGeneration: 1 }), false);
  assert.equal(canReleaseHeldLocal(job, { validatorGeneration: 2 }), true);
});
