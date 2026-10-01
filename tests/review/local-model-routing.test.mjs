import test from "node:test";
import assert from "node:assert/strict";

import {
  createLocalModelRouter,
  LocalModelRateLimiter,
  parseLocalModelRateLimits,
  modelRateLimitsProblem,
  parseLocalModelPriority,
} from "../../src/lib/local-model-routing.server.ts";
import { LocalChatHttpError } from "../../src/lib/local-chat-request.server.ts";

test("priority settings put the primary model first and deduplicate aliases", () => {
  assert.deepEqual(
    parseLocalModelPriority("ashlar-review", "ashlar-review-qwen, ashlar-review, ashlar-review-local"),
    ["ashlar-review", "ashlar-review-qwen", "ashlar-review-local"],
  );
});

test("router advances to the next model only after a 429", async () => {
  const calls = [];
  let attempts = 0;
  const router = createLocalModelRouter(
    ["primary", "fallback"],
    async (_baseUrl, _apiKey, _path, body) => {
      calls.push(body.model);
      attempts += 1;
      if (attempts === 1) throw new LocalChatHttpError(429, "rate limited");
      return { choices: [{ message: { content: "ok" } }] };
    },
  );

  const result = await router.request("http://proxy/v1", "key", "chat/completions", {
    model: "primary",
    messages: [],
  });

  assert.equal(result.choices[0].message.content, "ok");
  assert.deepEqual(calls, ["primary", "fallback"]);
  assert.equal(router.currentModel(), "fallback");
});

test("router does not hide non-rate-limit failures", async () => {
  const calls = [];
  const router = createLocalModelRouter(
    ["primary", "fallback"],
    async (_baseUrl, _apiKey, _path, body) => {
      calls.push(body.model);
      throw new LocalChatHttpError(500, "upstream failed");
    },
  );

  await assert.rejects(
    router.request("http://proxy/v1", "key", "chat/completions", { model: "primary", messages: [] }),
    (error) => error instanceof LocalChatHttpError && error.status === 500,
  );
  assert.deepEqual(calls, ["primary"]);
});

test("model rate limits parse human-readable intervals and reject malformed entries", () => {
  assert.deepEqual(
    parseLocalModelRateLimits("gemini=0\nqwen=500ms, gpt-4o-mini=60s\nslow=1m"),
    { gemini: 0, qwen: 500, "gpt-4o-mini": 60_000, slow: 60_000 },
  );
  assert.equal(modelRateLimitsProblem("qwen=60s\nmissing-value"), "model rate limit must use model=duration (for example qwen=60s)");
  assert.equal(modelRateLimitsProblem("qwen=-1s"), "model rate limit must use model=duration (for example qwen=60s)");
});

test("reserved object property names remain valid model aliases", async () => {
  const configured = parseLocalModelRateLimits("__proto__=60s, constructor=20s");
  assert.equal(Object.hasOwn(configured, "__proto__"), true);
  assert.equal(configured.__proto__, 60_000);
  assert.equal(configured.constructor, 20_000);

  let now = 0;
  const waits = [];
  const limiter = new LocalModelRateLimiter({}, {
    now: () => now,
    sleep: async (ms) => {
      assert.equal(Number.isFinite(ms), true);
      waits.push(ms);
      now += ms;
    },
  });
  await limiter.wait("__proto__");
  await limiter.wait("__proto__");
  assert.deepEqual(waits, []);
});

test("same model requests wait for the configured interval while other models stay independent", async () => {
  let now = 1_000;
  const sleeps = [];
  const limiter = new LocalModelRateLimiter(
    { primary: 60, fallback: 60 },
    {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    },
  );

  await limiter.wait("primary");
  now = 1_001;
  await limiter.wait("primary");
  await limiter.wait("fallback");

  assert.deepEqual(sleeps, [59]);
});

test("a rate-limit backoff extends the next start and an aborted wait leaves the queue", async () => {
  let now = 0;
  const waits = [];
  const limiter = new LocalModelRateLimiter(
    { primary: 100 },
    {
      now: () => now,
      sleep: async (ms, signal) => {
        waits.push(ms);
        if (signal?.aborted) throw signal.reason;
        now += ms;
      },
    },
  );
  await limiter.wait("primary");
  limiter.noteRateLimit("primary", 250);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(limiter.wait("primary", controller.signal), /cancelled/);
  await limiter.wait("primary");
  assert.deepEqual(waits, [250]);
});

test("a retry-after update also delays a waiter that was already sleeping", async () => {
  let now = 0;
  let injectBackoff = false;
  const waits = [];
  let limiter;
  limiter = new LocalModelRateLimiter(
    { primary: 100 },
    {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        if (injectBackoff) {
          injectBackoff = false;
          limiter.noteRateLimit("primary", 250);
        }
        now += ms;
      },
    },
  );

  await limiter.wait("primary");
  injectBackoff = true;
  await limiter.wait("primary");

  assert.deepEqual(waits, [100, 150]);
  assert.equal(now, 250);
});

test("router gates each request before transport and advances after a 429", async () => {
  let now = 10;
  const waits = [];
  const limiter = new LocalModelRateLimiter(
    { primary: 100 },
    { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } },
  );
  const calls = [];
  const router = createLocalModelRouter(
    ["primary", "fallback"],
    async (_baseUrl, _apiKey, _path, body) => {
      calls.push({ model: body.model, at: now });
      if (body.model === "primary") throw new LocalChatHttpError(429, "rate limited");
      return { ok: true };
    },
    { limiter },
  );

  assert.deepEqual(await router.request("http://proxy/v1", "key", "chat/completions", { messages: [] }), { ok: true });
  assert.deepEqual(calls, [
    { model: "primary", at: 10 },
    { model: "fallback", at: 10 },
  ]);
  assert.deepEqual(waits, []);
});
