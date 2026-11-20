// Codex reviewer settings through the production Settings route (/api/harbor action=settings) and the
// Settings screen: the proxy key is a secret like the local LLM key, the derived flags are read-only,
// the diff-vs-Codex-prompt rule is a 400, and every Codex field is on the screen and in its save.
import test from "node:test";
import assert from "node:assert/strict";
import { source, types } from "./load-source.mjs";
import { settingsHarness as harness } from "./settings-harness.mjs";

const CODEX_FIELDS = [
  "reviewCodex",
  "codexBaseUrl",
  "codexApiKey",
  "codexModel",
  "codexReasoningEffort",
  "codexStructuredOutput",
  "codexPromptMaxChars",
  "codexMaxOutputTokens",
  "codexTimeoutMinutes",
  "codexQuotaCooldownMinutes",
];

test("the Codex proxy key: a non-string is a 400; blank, whitespace-only or masked keeps the stored key; a new string replaces it", async () => {
  const h = harness({ codexApiKey: "proxy-stored" });
  for (const value of [null, 0, false, ["k"], {}]) {
    const res = await h.post({ codexApiKey: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.match((await res.json()).error, /codex\.api_key must be a string/);
  }
  assert.equal(h.saves.length, 0);
  for (const value of ["", "   ", types.SECRET_MASK]) {
    assert.equal((await h.post({ codexApiKey: value })).status, 200, JSON.stringify(value));
    assert.equal(
      h.state.settings.codexApiKey,
      "proxy-stored",
      `${JSON.stringify(value)} keeps the stored key`,
    );
  }
  assert.equal((await h.post({ codexApiKey: " proxy-fresh " })).status, 200);
  assert.equal(h.state.settings.codexApiKey, "proxy-fresh");
});

test("the derived Codex flags are read-only (400)", async () => {
  const h = harness();
  for (const body of [{ codexApiKeySet: true }, { codexCooldownUntil: 0 }]) {
    const res = await h.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, /is not a writable settings field/);
  }
  assert.equal(h.saves.length, 0);
});

test("turning Codex on with a diff budget the Codex prompt cannot hold is a 400 and nothing changes", async () => {
  const h = harness({ promptDiffMaxChars: 500_000 });
  const live = structuredClone(h.state.settings);
  const res = await h.post({ reviewCodex: true });
  assert.equal(res.status, 400);
  assert.match(
    (await res.json()).error,
    /prompt\.diff_max_chars \(500000\) must be at most codex\.prompt_max_chars − 150000 \(450000\) while review_codex is on/,
  );
  assert.deepEqual(h.state.settings, live);
  assert.equal(
    (await h.post({ reviewCodex: true, codexPromptMaxChars: 650_000 })).status,
    200,
    "a larger Codex budget fits",
  );
  assert.equal(h.state.settings.reviewCodex, true);
  assert.equal(
    (await h.post({ promptDiffMaxChars: 500_001 })).status,
    400,
    "the rule holds on a later save too",
  );
  assert.equal(
    (
      await h.post({
        reviewCodex: true,
        reviewChatgpt: false,
        reviewGrok: false,
        reviewLocal: false,
      })
    ).status,
    200,
    "Codex alone is a valid reviewer set",
  );
});

test("every Codex setting is on the Settings screen and in its save request", () => {
  const screen = source("src/routes/settings.tsx");
  const store = source("src/lib/store.ts");
  for (const field of CODEX_FIELDS) {
    assert.ok(Object.hasOwn(types.DEFAULT_SETTINGS, field), `${field} has a default`);
    assert.match(screen, new RegExp(`\\b${field}\\b`), `${field} is edited on the Settings screen`);
    if (field !== "codexApiKey")
      assert.match(
        store,
        new RegExp(`\\b${field}: next\\.${field}\\b`),
        `${field} is sent by the Settings save`,
      );
  }
  assert.match(store, /body\.codexApiKey = next\.codexApiKey/, "a typed proxy key is sent");
  for (const label of [
    "review_codex",
    "codex.base_url",
    "codex.api_key",
    "codex.model",
    "codex.reasoning_effort",
    "codex.structured_output",
    "codex.prompt_max_chars",
    "codex.max_output_tokens",
    "codex.timeout_minutes",
    "codex.quota_cooldown_minutes",
  ]) {
    assert.ok(screen.includes(`label="${label}"`), `field ${label} on the screen`);
  }
  assert.match(screen, /Cooling down until/, "the cooldown status is shown read-only");
});

test("review_codex sits with the other reviewer toggles, so Codex can be turned on as the only reviewer from the top list", () => {
  const screen = source("src/routes/settings.tsx");
  const list = screen.match(
    /<Toggle label="review_chatgpt"[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(list, "the reviewer toggle list is on the screen");
  for (const p of ["review_chatgpt", "review_grok", "review_local", "review_codex"])
    assert.ok(list.includes(`label="${p}"`), `${p} is in the reviewer toggle list`);
  assert.match(
    list,
    /label="review_codex" checked=\{draft\.reviewCodex\} onChange=\{\(v\) => toggle\("reviewCodex", v\)\}/,
    "the top toggle edits reviewCodex through the same last-reviewer guard as the others",
  );
});
