import test from "node:test";
import assert from "node:assert/strict";

import {
  createLocalModelRouter,
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

