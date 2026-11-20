// The Codex reviewer leg (src/lib/codex-reviewer.server.ts) over the real local transport and a real
// HTTP server standing in for the proxy (ChatMock / CLIProxyAPI). Synthetic PR content only.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  buildCodexPrompt,
  codexCooldownUntil,
  codexCoolingDown,
  codexQuotaNote,
  codexQuotaResetAt,
  codexResponseFormatDropped,
  noteCodexCooldown,
  resetCodexStateForTest,
  runCodexReview,
} from "../../src/lib/codex-reviewer.server.ts";
import {
  LocalChatHttpError,
  LocalChatStreamError,
  localHttpSlot,
} from "../../src/lib/local-chat-request.server.ts";
import { buildChatParts, chatPromptText } from "../../src/lib/chat-prompt.ts";
import { DEFAULT_SETTINGS } from "../../src/lib/types.ts";

const review = JSON.stringify({
  merge_recommendation: "COMMENT",
  highest_risk: "",
  investigated_safe: ["a.ts: constant only"],
  assumptions: [],
  findings: [],
});

async function proxy(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = {
      url: req.url,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
      req,
      res,
    };
    requests.push(request);
    await handler(request, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

/** An SSE reply in two content chunks (the shape ChatMock streams). */
function sse(res, content, finish = "stop") {
  const data = (o) => `data: ${JSON.stringify(o)}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(data({ choices: [{ delta: { role: "assistant" } }] }));
  res.write(data({ choices: [{ delta: { content: content.slice(0, 7) } }] }));
  res.end(
    data({ choices: [{ delta: { content: content.slice(7) }, finish_reason: finish }] }) +
      "data: [DONE]\n\n",
  );
}

const settings = (base, patch = {}) => ({
  ...DEFAULT_SETTINGS,
  codexBaseUrl: base,
  reviewCodex: true,
  ...patch,
});

test("the Codex request: streamed, the model and reasoning_effort, response_format json_schema; no sampling fields, no max_tokens, no service_tier", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, ({ res }) => sse(res, review));
  const out = await runCodexReview("Review this diff.", settings(p.base));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.raw, review);
  assert.equal(p.requests.length, 1);
  const { url, body, headers } = p.requests[0];
  assert.equal(url, "/v1/chat/completions");
  assert.equal(headers.authorization, "Bearer local", "an empty proxy key sends a dummy bearer");
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.stream, true);
  assert.equal(body.reasoning_effort, "medium");
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ["system", "user"],
  );
  assert.equal(body.messages[1].content, "Review this diff.");
  for (const field of [
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "max_tokens",
    "service_tier",
    "max_completion_tokens",
    "chat_template_kwargs",
  ]) {
    assert.equal(field in body, false, `${field} must not be sent`);
  }
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "ashlar_review");
  assert.equal(body.response_format.json_schema.strict, false);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.properties.findings.maxItems, 8, "at most 8 findings (the gate cap)");
  assert.deepEqual(schema.properties.findings.items.required.sort(), [
    "evidence",
    "failure_scenario",
    "file",
    "line",
    "recommended_fix",
    "recommended_test",
    "root_cause",
    "severity",
    "side",
    "title",
  ]);
});

test("structured output off sends no response_format; max_completion_tokens only when set; the proxy key is the bearer", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, ({ res }) => sse(res, review));
  await runCodexReview(
    "x",
    settings(p.base, {
      codexStructuredOutput: false,
      codexMaxOutputTokens: 4096,
      codexReasoningEffort: "high",
      codexApiKey: " proxy-key ",
    }),
  );
  const { body, headers } = p.requests[0];
  assert.equal("response_format" in body, false);
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(body.reasoning_effort, "high");
  assert.equal("max_tokens" in body, false);
  assert.equal(headers.authorization, "Bearer proxy-key");
});

test("a 400 naming response_format: the request goes once more without it, and the process sends none after that", async (t) => {
  resetCodexStateForTest();
  const logs = [];
  const p = await proxy(t, ({ body, res }) => {
    if (body.response_format) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Unsupported parameter: response_format.json_schema is not supported",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    sse(res, review);
  });
  const first = await runCodexReview("x", settings(p.base), { log: (l) => logs.push(l) });
  assert.equal(first.ok, true, first.error);
  assert.equal(p.requests.length, 2, "exactly one retry");
  assert.ok(p.requests[0].body.response_format);
  assert.equal("response_format" in p.requests[1].body, false);
  assert.equal(codexResponseFormatDropped(), true);
  assert.ok(logs.some((l) => /rejected response_format/.test(l)));
  const second = await runCodexReview("x", settings(p.base));
  assert.equal(second.ok, true);
  assert.equal(p.requests.length, 3, "the next review sends one request");
  assert.equal("response_format" in p.requests[2].body, false, "remembered for the process");
});

test("a 400 that does not name response_format is a failure (no retry), reported in fixed text", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, ({ res }) => {
    res.writeHead(400);
    res.end('{"error":{"message":"ChatGPT session disconnected"}}');
  });
  const out = await runCodexReview("x", settings(p.base));
  assert.equal(out.ok, false);
  assert.equal(p.requests.length, 1);
  assert.equal(out.error, "HTTP 400 from the Codex proxy");
  assert.doesNotMatch(out.error, /chatgpt|disconnected|local/i, "never the backend text");
  assert.equal(codexResponseFormatDropped(), false);
});

test("a Codex request never takes the local slot lock (ASHLAR_LOCAL_SLOT_LOCK) the local model holds", async (t) => {
  resetCodexStateForTest();
  const previous = process.env.ASHLAR_LOCAL_SLOT_LOCK;
  process.env.ASHLAR_LOCAL_SLOT_LOCK = "true";
  const release = await localHttpSlot().acquire();
  t.after(() => {
    release();
    if (previous === undefined) delete process.env.ASHLAR_LOCAL_SLOT_LOCK;
    else process.env.ASHLAR_LOCAL_SLOT_LOCK = previous;
  });
  assert.equal(localHttpSlot().snapshot().busy, true, "the local model holds the slot");
  const p = await proxy(t, ({ res }) => sse(res, review));
  const out = await Promise.race([
    runCodexReview("x", settings(p.base)),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000)),
  ]);
  assert.notEqual(out, "blocked", "the Codex request waited for the local slot");
  assert.equal(out.ok, true);
  assert.equal(p.requests.length, 1);
});

test("one Codex request at a time: a second review waits for the first, then goes", async (t) => {
  resetCodexStateForTest();
  const held = [];
  const p = await proxy(t, ({ res }) => {
    held.push(res);
  });
  const stages = [];
  const a = runCodexReview("a", settings(p.base));
  const b = runCodexReview("b", settings(p.base), { onStage: (s) => stages.push(s) });
  const deadline = Date.now() + 2000;
  while (p.requests.length < 1 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(p.requests.length, 1, "the second request is queued, not sent");
  assert.deepEqual(stages, ["codex_queued"]);
  sse(held[0], review);
  assert.equal((await a).ok, true);
  while (held.length < 2 && Date.now() < deadline + 2000)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.requests.length, 2);
  sse(held[1], review);
  assert.equal((await b).ok, true);
  assert.deepEqual(stages, ["codex_queued", "codex_running", "codex_generating"]);
});

test("a cancelled review aborts its request (and a queued one leaves the queue without sending)", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, () => {});
  const first = new AbortController();
  const second = new AbortController();
  const a = runCodexReview("a", settings(p.base), { signal: first.signal });
  const b = runCodexReview("b", settings(p.base), { signal: second.signal });
  while (p.requests.length < 1) await new Promise((r) => setTimeout(r, 10));
  second.abort();
  assert.deepEqual(await b, { ok: false, error: "cancelled" });
  first.abort();
  assert.deepEqual(await a, { ok: false, error: "cancelled" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(p.requests.length, 1);
  assert.ok(
    p.requests[0].req.destroyed || p.requests[0].res.destroyed,
    "the in-flight request was aborted",
  );
});

test("a reply cut off (finish_reason length) is evidence, never a verdict; a reply that is not JSON gets no correction call", async (t) => {
  resetCodexStateForTest();
  const cut =
    '{"merge_recommendation":"REQUEST_CHANGES","findings":[{"severity":"P1","file":"a.ts"';
  let n = 0;
  const p = await proxy(t, ({ res }) => {
    n += 1;
    if (n === 1) sse(res, cut, "length");
    else sse(res, "I could not review this diff.");
  });
  const truncated = await runCodexReview("x", settings(p.base));
  assert.equal(truncated.ok, false);
  assert.equal(truncated.unparsedText, cut);
  assert.match(truncated.error, /cut off \(length\)/);
  const prose = await runCodexReview("x", settings(p.base));
  assert.equal(prose.ok, false);
  assert.equal(prose.unparsedText, "I could not review this diff.");
  assert.equal(p.requests.length, 2, "no second full-prompt correction call");
});

test("a leading <think> reasoning block (proxy think-tags mode) is not text around the review JSON", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, ({ res }) => sse(res, `<think>Reading a.ts.</think>\n${review}`));
  const out = await runCodexReview("x", settings(p.base));
  assert.equal(out.ok, true);
  assert.equal(out.raw, review);
  assert.equal(out.residualReplies, undefined);
});

test("usage limit: HTTP 429 with resets_at / resets_in_seconds / Retry-After / x-codex headers / nothing (cooldown setting)", () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const err = (body, headers = {}, retry) =>
    new LocalChatHttpError(
      429,
      typeof body === "string" ? body : JSON.stringify(body),
      retry,
      headers,
    );
  const limit = {
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      plan_type: "free",
    },
  };
  assert.equal(
    codexQuotaResetAt(
      err(
        { error: { ...limit.error, resets_at: now / 1000 + 7200, resets_in_seconds: 5 } },
        {},
        1000,
      ),
      now,
      60,
    ),
    now + 7_200_000,
    "resets_at wins",
  );
  assert.equal(
    codexQuotaResetAt(err({ error: { ...limit.error, resets_in_seconds: 90 } }, {}, 1000), now, 60),
    now + 90_000,
  );
  assert.equal(
    codexQuotaResetAt(
      err(limit, { "retry-after": "120", "x-codex-primary-reset-after-seconds": "300" }, 120_000),
      now,
      60,
    ),
    now + 120_000,
    "Retry-After before the x-codex headers",
  );
  assert.equal(
    codexQuotaResetAt(err(limit, { "x-codex-primary-reset-after-seconds": "300" }), now, 60),
    now + 300_000,
  );
  assert.equal(
    codexQuotaResetAt(
      err(limit, { "x-codex-primary-reset-at": String(now / 1000 + 3600) }),
      now,
      60,
    ),
    now + 3_600_000,
  );
  assert.equal(
    codexQuotaResetAt(err("Too Many Requests"), now, 45),
    now + 45 * 60_000,
    "no reset time: the cooldown setting",
  );
  // A forwarded usage error with another status, in a 200 stream's error chunk, and a non-quota error.
  assert.equal(
    codexQuotaResetAt(
      new LocalChatHttpError(403, JSON.stringify({ error: { type: "usage_not_included" } })),
      now,
      60,
    ),
    now + 60 * 60_000,
  );
  assert.equal(
    codexQuotaResetAt(
      new LocalChatStreamError(
        JSON.stringify({ error: { type: "rate_limit_exceeded", resets_in_seconds: 600 } }),
      ),
      now,
      60,
    ),
    now + 600_000,
  );
  assert.equal(
    codexQuotaResetAt(new LocalChatHttpError(500, '{"error":{"type":"server_error"}}'), now, 60),
    undefined,
  );
  assert.equal(codexQuotaResetAt(new Error("boom"), now, 60), undefined);
  assert.equal(
    codexQuotaNote(Date.UTC(2026, 10, 20, 14, 5)),
    "Codex skipped (usage limit, resets at 14:05 UTC)",
  );
});

test("a 429 from the proxy is a usage-limit result with its reset time and fixed text; a stream error chunk is one too", async (t) => {
  resetCodexStateForTest();
  let n = 0;
  const p = await proxy(t, ({ res }) => {
    n += 1;
    if (n === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "600" });
      res.end(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "ChatGPT usage limit; you are disconnected",
            resets_in_seconds: 3600,
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  const now = Date.UTC(2026, 10, 20, 9, 0, 0);
  const out = await runCodexReview("x", settings(p.base), { now: () => now });
  assert.equal(out.ok, false);
  assert.equal(out.quotaResetAt, now + 3_600_000);
  assert.equal(out.error, "Codex skipped (usage limit, resets at 10:00 UTC)");
  resetCodexStateForTest(); // the first limit's cooldown would stop the second request before it is sent
  const streamed = await runCodexReview("x", settings(p.base), { now: () => now });
  assert.equal(streamed.quotaResetAt, now + 60_000);
});

test("the process-wide cooldown only extends", () => {
  resetCodexStateForTest();
  const now = Date.now();
  assert.equal(codexCoolingDown(now), false);
  noteCodexCooldown(now + 60_000);
  noteCodexCooldown(now + 1_000);
  assert.equal(codexCooldownUntil(), now + 60_000);
  assert.equal(codexCoolingDown(now), true);
  assert.equal(codexCoolingDown(now + 60_001), false);
  resetCodexStateForTest();
});

test("the Codex prompt is the chat prompt fitted to codexPromptMaxChars (code context cut, diff kept) plus the at-most-8 rule", () => {
  const big = Array.from(
    { length: 6000 },
    (_, i) => `export const value${i} = ${i}; // padding line ${i}`,
  ).join("\n");
  const sample = {
    key: "fixture",
    owner: "fixture",
    repo: "fixture",
    pr: 1,
    title: "Fixture",
    body: "",
    sender: "author",
    headSha: "abc123",
    baseSha: "def456",
    isFork: false,
    isDraft: false,
    labels: [],
    changedPaths: ["a.ts"],
    files: [{ path: "a.ts", content: `${big}\nexport const answer = 42;\n`, language: "ts" }],
    diff: "--- a.ts\n@@ -6001 +6001 @@\n-export const answer = 41;\n+export const answer = 42;",
  };
  const opts = {
    sample,
    extra: "",
    untrustedBody: "",
    priorThreads: [],
    contextMaxChars: 400_000,
    contextPadLines: 20,
    policyMaxChars: 32_768,
  };
  const chat = chatPromptText(buildChatParts(opts));
  assert.ok(chat.length > 200_000, `fixture prompt is large (${chat.length})`);
  const roomy = buildCodexPrompt(opts, 1_000_000);
  assert.ok(
    roomy.includes("padding line 10\n") && roomy.includes("padding line 5999"),
    "a prompt that fits keeps the whole context",
  );
  const fitted = buildCodexPrompt(opts, 200_000);
  assert.ok(fitted.length <= 200_000, `fitted to the budget (${fitted.length})`);
  assert.ok(fitted.includes("+export const answer = 42;"), "the diff is never cut");
  assert.ok(!fitted.includes("padding line 10\n"), "the code context was cut to fit");
  assert.match(fitted, /Return at most 8 findings/);
  assert.match(fitted, /Return the JSON object directly/);
  assert.match(
    fitted,
    /<<<ATTACH:ashlar-diff\.patch>>>/,
    "attachments inline, as an API model reads them",
  );
});

test("a usage limit stops the reviews already queued for the Codex slot: only one request is sent", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, ({ res }) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 1800 } }));
  });
  const now = Date.now();
  const first = runCodexReview("a", settings(p.base), { now: () => now });
  const second = runCodexReview("b", settings(p.base), { now: () => now });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.quotaResetAt, now + 1_800_000);
  assert.equal(b.ok, false);
  assert.equal(b.quotaResetAt, now + 1_800_000, "the queued review returns the usage limit");
  assert.match(b.error, /^Codex skipped \(usage limit, resets at \d\d:\d\d UTC\)$/);
  assert.equal(p.requests.length, 1, "the queued review sent nothing");
  resetCodexStateForTest();
});

test("usage-limit reset times are clamped: ms epochs, past, unreadable and huge values", () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const limit = (fields, headers = {}, retry) =>
    new LocalChatHttpError(
      429,
      JSON.stringify({ error: { type: "usage_limit_reached", ...fields } }),
      retry,
      headers,
    );
  const week = 7 * 24 * 60 * 60_000;
  assert.equal(
    codexQuotaResetAt(limit({ resets_at: now + 3_600_000 }), now, 60),
    now + 3_600_000,
    "an epoch in ms is read as ms",
  );
  assert.equal(
    codexQuotaResetAt(limit({}, { "x-codex-primary-reset-at": String(now + 7_200_000) }), now, 60),
    now + 7_200_000,
    "an ms epoch header too",
  );
  assert.equal(
    codexQuotaResetAt(limit({ resets_at: now / 1000 - 600 }), now, 45),
    now + 45 * 60_000,
    "a past reset: the cooldown setting",
  );
  assert.equal(
    codexQuotaResetAt(limit({ resets_in_seconds: -30 }), now, 45),
    now + 45 * 60_000,
    "a negative relative reset: the cooldown setting",
  );
  assert.equal(
    codexQuotaResetAt(limit({ resets_at: "soon" }), now, 45),
    now + 45 * 60_000,
    "unreadable (NaN): the cooldown setting",
  );
  assert.equal(
    codexQuotaResetAt(limit({ resets_in_seconds: 1e12 }), now, 60),
    now + week,
    "a huge relative reset: at most a week",
  );
  assert.equal(
    codexQuotaResetAt(limit({ resets_at: now / 1000 + 365 * 86_400 }), now, 60),
    now + week,
    "a far epoch: at most a week",
  );
  assert.equal(
    codexQuotaResetAt(limit({}, { "x-codex-primary-reset-after-seconds": "1e15" }), now, 60),
    now + week,
  );
  assert.equal(
    codexQuotaResetAt(limit({}, {}, 5_000_000_000), now, 60),
    now + week,
    "Retry-After too",
  );
  assert.equal(
    codexQuotaResetAt(limit({ resets_in_seconds: 5 }), now, 60),
    now + 60_000,
    "never sooner than a minute",
  );
});

/** Fails fast instead of waiting out a production-length timer. */
const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no result within ${ms} ms`)), ms),
    ),
  ]);

/** A proxy that answers headers and then only SSE comment heartbeats, every `every` ms, until `stop()`. */
function heartbeats(res, every) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const timer = setInterval(() => res.write(": ping\n\n"), every);
  return () => clearInterval(timer);
}

test("SSE comment heartbeats keep a slow reply alive past the silence window", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, ({ res }) => {
    const stop = heartbeats(res, 40);
    setTimeout(() => {
      stop();
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: review }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    }, 600);
  });
  const out = await within(runCodexReview("x", settings(p.base), { livenessMs: 200 }), 3000);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.raw, review);
});

test("a truly silent stream is aborted after the silence window", async (t) => {
  resetCodexStateForTest();
  const p = await proxy(t, ({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
  });
  const started = Date.now();
  const out = await within(runCodexReview("x", settings(p.base), { livenessMs: 200 }), 3000);
  assert.equal(out.ok, false);
  assert.equal(out.error, "the Codex proxy sent nothing for the liveness window");
  assert.ok(Date.now() - started < 3000);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(p.requests[0].req.destroyed || p.requests[0].res.destroyed, "the request was aborted");
});

test("the hard timeout ends a request that keeps heartbeating but never answers", async (t) => {
  resetCodexStateForTest();
  const stops = [];
  const p = await proxy(t, ({ res }) => {
    stops.push(heartbeats(res, 30));
  });
  t.after(() => stops.forEach((stop) => stop()));
  const out = await within(
    runCodexReview("x", settings(p.base), { livenessMs: 10_000, timeoutMs: 300 }),
    3000,
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, "no reply within 20 min (codexTimeoutMinutes)");
});
