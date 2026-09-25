// Settings API (/api/harbor action=settings) for the fix agent / review loop: the route forwards
// the whole fixAgent block, the production rules (settings-rules — the same ones the Settings
// screen runs) validate it, and the response and the next GET carry what was actually saved — the
// Settings screen is the loop's only switch. A rejected value is a 400 and a failed persist a 500;
// neither changes the live settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import {types} from './load-source.mjs';
import {settingsHarness as harness} from './settings-harness.mjs';

test('fixAgent round-trips through the Settings API and is live at once', async () => {
  const h = harness();
  assert.equal((await h.get()).fixAgent.enabled, false, 'default: the loop is off');
  const wanted = {enabled: true, provider: 'chatgpt', delivery: 'script-apply', mode: 'apply', parallelPrs: 2,
    roundCap: 4, attempts: 3, timeoutMs: 30 * 60_000, queueMaxMs: 60 * 60_000, chatTimeoutMs: 45 * 60_000, chatMaxPromptChars: 200_000};
  const res = await h.post({fixAgent: wanted});
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).settings.fixAgent, wanted, 'the response carries what was saved');
  assert.deepEqual(h.state.settings.fixAgent, wanted, 'the live settings changed in this process (no restart)');
  assert.deepEqual((await h.get()).fixAgent, wanted, 'the next GET reads it back');
  // A partial patch keeps the other fields; switching off is one field.
  await h.post({fixAgent: {enabled: false}});
  assert.deepEqual(h.state.settings.fixAgent, {...wanted, enabled: false});
});

const K = types.FIX_AGENT_KNOBS;
// Every fixAgent field: a value the Settings screen rejects is rejected by the API too (400, no
// save, live settings unchanged) — never clamped or rewritten into something the operator did not type.
const INVALID = [
  ['enabled', 'true'], ['enabled', 1], ['provider', 'skynet'], ['delivery', 'teleport'], ['mode', 'yolo'],
  ...Object.keys(K).flatMap(key => [[key, K[key].max + 1], [key, K[key].min - 1], [key, 'x'], [key, null], [key, K[key].min + 0.5]]),
];

test('every invalid fixAgent value is rejected (400) and nothing is saved', async () => {
  const h = harness();
  const live = structuredClone(h.state.settings.fixAgent);
  for (const [key, value] of INVALID) {
    const res = await h.post({fixAgent: {[key]: value}});
    assert.equal(res.status, 400, `${key}=${JSON.stringify(value)}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, key === 'enabled' || key === 'provider' || key === 'delivery' || key === 'mode' ? new RegExp(`fix_agent\\.${key}`) : /must be a whole number/);
  }
  assert.equal(h.saves.length, 0);
  assert.deepEqual(h.state.settings.fixAgent, live);
  // A non-object fixAgent is rejected too (never silently ignored with a 200).
  assert.equal((await h.post({fixAgent: 'on'})).status, 400);
  assert.equal((await h.post({fixAgent: [true]})).status, 400);
  assert.equal(h.saves.length, 0);
});

// The route passes every supplied field RAW to the shared validator. Before, a non-object fixAgent
// was dropped by the route and the request answered 200 with nothing changed.
test('a supplied non-object fixAgent (null / false / "off" / [] …) is a 400; the enabled loop stays as stored, live and persisted', async () => {
  const h = harness({fixAgent: {enabled: true, provider: 'chatgpt', delivery: 'script-apply', mode: 'suggest'}});
  assert.equal(h.state.settings.fixAgent.enabled, true, 'fixture: the loop is ON and stored');
  const live = structuredClone(h.state.settings);
  for (const value of [null, false, 'off', [], 0, '', true, 'on', [{enabled: false}]]) {
    const res = await h.post({fixAgent: value});
    assert.equal(res.status, 400, `fixAgent=${JSON.stringify(value)}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /fix_agent must be an object/);
    assert.deepEqual(h.state.settings, live, 'live settings unchanged');
    assert.equal(h.saves.length, 0, 'nothing persisted');
    assert.deepEqual((await h.get()).fixAgent, live.fixAgent);
  }
});

const D = types.DEFAULT_SETTINGS;
// Every top-level settings key: a supplied wrong-typed / out-of-domain value is a 400 and changes
// nothing (no prefilter drops it, no coercion rewrites it); a valid value is saved as typed.
const TOP_LEVEL = {
  username: {bad: [42, null, '', '   ', ['bot'], true], good: 'ashlar-2'},
  mention: {bad: ['@bot', [], [''], ['  '], [42], ['@a', null], null, {}], good: ['@ashlar-2', '/fix']},
  skipForks: {bad: ['true', 1, null, 'false'], good: false},
  skipDrafts: {bad: ['true', 0, null], good: false},
  maxInlineComments: {bad: ['5', null, 1.5, -1, 21, 25, true], good: 20},
  maxTurns: {bad: ['5', null, 2.5, -1, 1001, false], good: 7},
  exploreTurns: {bad: ['5', null, 0.5, -1, 1001], good: 3},
  publishMinSeverity: {bad: ['P3', 'p1', 1, null], good: 'P0'},
  requestChangesMin: {bad: ['P9', 2, null], good: 'P2'},
  precisionOverRecall: {bad: ['yes', 1, null], good: false},
  webhookSecret: {bad: [42, null, {}, ['s'], true], good: 'new-secret'},
  reviewChatgpt: {bad: ['true', 1, null], good: false},
  reviewGrok: {bad: ['false', 0, null], good: false},
  reviewLocal: {bad: ['true', 1, null], good: false},
  fixAgent: {bad: [null, false, 'off', [], 1], good: {mode: 'apply'}},
  localJsonRepairEnabled: {bad: ['false', 0, null], good: false},
  localRepairNoThinking: {bad: ['true', 1, null], good: true},
  chatgptReasoning: {bad: ['bogus', '', 3, null], good: 'high'},
  grokReasoning: {bad: ['bogus', '', 3, null], good: 'fast'},
  localLlmBaseUrl: {bad: [42, null, {}], good: 'http://127.0.0.1:1234/v1'},
  localLlmApiKey: {bad: [42, null, {}], good: 'sk-new'},
  localLlmModel: {bad: [42, null, []], good: 'qwen'},
  localReviewMaxTokens: {bad: ['100', null, 0, 1.5, -5], good: 4096},
  localReviewMode: {bad: ['turbo', 1, null], good: 'multiturn'},
  localReviewSingleTurnMaxTokens: {bad: ['100', null, 0, 2.5], good: 8000},
  reviewOrder: {bad: ['local', ['grok'], ['local', 'local', 'grok'], ['local', 'chatgpt', 'bing'], [], null, ['local', 'chatgpt', 'grok', 'grok']], good: ['grok', 'chatgpt', 'local']},
  promptDiffMaxChars: {bad: ['10', null, -1, 0.5], good: 12345},
  promptContextMaxChars: {bad: ['10', null, -1, 0.5], good: 0},
  promptPolicyMaxChars: {bad: ['10', null, -1, 0.5], good: 999},
  contextPadLines: {bad: ['10', null, -1, 0.5], good: 12},
};

test('every top-level settings key: a wrong-typed value is a 400 and nothing changes; a valid one is saved as typed', async () => {
  assert.deepEqual(Object.keys(TOP_LEVEL).sort(), Object.keys(D).sort(), 'the table covers every settings key');
  for (const [key, {bad, good}] of Object.entries(TOP_LEVEL)) {
    const h = harness({reviewLocal: true, localLlmBaseUrl: 'http://127.0.0.1:1/v1', localLlmModel: 'm'});
    const live = structuredClone(h.state.settings);
    for (const value of bad) {
      const res = await h.post({[key]: value});
      assert.equal(res.status, 400, `${key}=${JSON.stringify(value)} must be rejected`);
      assert.equal((await res.json()).ok, false);
      assert.deepEqual(h.state.settings, live, `${key}=${JSON.stringify(value)}: live settings unchanged`);
    }
    assert.equal(h.saves.length, 0, `${key}: nothing persisted`);
    const res = await h.post({[key]: good});
    assert.equal(res.status, 200, `${key}=${JSON.stringify(good)} is valid`);
    const want = key === 'fixAgent' ? {...live.fixAgent, ...good} : good;
    assert.deepEqual(h.state.settings[key], want, `${key}: saved as typed`);
  }
});

test('an unknown or read-only field is a 400 (never silently dropped)', async () => {
  const h = harness();
  const live = structuredClone(h.state.settings);
  for (const body of [{maxInlinecomments: 3}, {localLlmApiKeySet: true}, {webhookSecretSet: false}, {fixAgentEnabled: true}, {username: 'ok', bogus: 1}]) {
    const res = await h.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, /is not a writable settings field/);
  }
  assert.deepEqual(h.state.settings, live);
  assert.equal(h.saves.length, 0);
});

test('secrets: a non-string is a 400; blank, whitespace-only or masked keeps the stored secret; a new string replaces it', async () => {
  const h = harness({webhookSecret: 'stored-hook', localLlmApiKey: 'sk-stored'});
  for (const value of [null, 0, false, ['sk'], {}]) {
    for (const key of ['webhookSecret', 'localLlmApiKey']) {
      const res = await h.post({[key]: value});
      assert.equal(res.status, 400, `${key}=${JSON.stringify(value)}`);
      assert.match((await res.json()).error, /must be a string/);
    }
  }
  assert.equal(h.saves.length, 0);
  for (const value of ['', '   ', types.SECRET_MASK]) {
    assert.equal((await h.post({webhookSecret: value, localLlmApiKey: value})).status, 200, JSON.stringify(value));
    assert.equal(h.state.settings.webhookSecret, 'stored-hook', `webhookSecret=${JSON.stringify(value)} keeps the stored one`);
    assert.equal(h.state.settings.localLlmApiKey, 'sk-stored');
  }
  assert.equal((await h.post({webhookSecret: ' fresh ', localLlmApiKey: 'sk-fresh'})).status, 200);
  assert.equal(h.state.settings.webhookSecret, 'fresh');
  assert.equal(h.state.settings.localLlmApiKey, 'sk-fresh');
});

test('enabling a legacy delivery is rejected (400): the API refuses what the runtime could not run', async () => {
  const h = harness();
  for (const pair of [{provider: 'chatgpt', delivery: 'chat-push'}, {provider: 'grok', delivery: 'chat-push'}, {provider: 'coding-agent', delivery: 'coding-agent'}]) {
    const res = await h.post({fixAgent: {...pair, enabled: true}});
    assert.equal(res.status, 400, JSON.stringify(pair));
    assert.match((await res.json()).error, /not wired yet|is not supported as a fix provider yet/);
  }
  // An incompatible pair is rejected even while OFF (it has no execution path at all).
  assert.equal((await h.post({fixAgent: {provider: 'local', delivery: 'chat-push'}})).status, 400);
  assert.equal(h.saves.length, 0);
  // The legacy pair can be kept while OFF; switching on works once the delivery is script-apply.
  assert.equal((await h.post({fixAgent: {provider: 'chatgpt', delivery: 'chat-push', enabled: false}})).status, 200);
  assert.equal((await h.post({fixAgent: {enabled: true}})).status, 400);
  assert.equal(h.state.settings.fixAgent.enabled, false);
  assert.equal((await h.post({fixAgent: {enabled: true, delivery: 'script-apply'}})).status, 200);
  assert.equal(h.state.settings.fixAgent.enabled, true);
});

test('a save whose JSON store cannot be written fails (500), both for enable and disable, and the live settings stay', async () => {
  const h = harness();
  assert.equal((await h.post({fixAgent: {provider: 'chatgpt'}})).status, 200);
  for (const enabled of [true, false]) {
    if (h.state.settings.fixAgent.enabled === enabled) {
      h.state.persistFails = false;
      assert.equal((await h.post({fixAgent: {enabled: !enabled}})).status, 200);
    }
    h.state.persistFails = true;
    const before = structuredClone(h.state.settings);
    const res = await h.post({fixAgent: {enabled}});
    assert.equal(res.status, 500, `enabled=${enabled}`);
    assert.match((await res.json()).error, /could not save settings/);
    assert.deepEqual(h.state.settings, before, 'the live settings did not change');
    assert.deepEqual((await h.get()).fixAgent, before.fixAgent, 'the next GET reads the last successful save');
  }
});

// Load (a stored document or an env seed) normalizes INTO the save domain: whatever it yields, a
// save accepts, so an unrelated save never fails on a stored value the operator did not touch.
const STORED = [
  {fixAgent: {enabled: true, provider: 'chatgpt', delivery: 'chat-push'}}, // a pre-#77 save
  {fixAgent: {enabled: true, provider: 'coding-agent', delivery: 'coding-agent'}},
  {fixAgent: {enabled: true, provider: null}},
  {fixAgent: {enabled: true, provider: 'grok', delivery: 'script-apply', mode: 'apply'}}, // grok was a fix provider before
  {fixAgent: {enabled: true, provider: 'chatgpt', delivery: 'script-apply', mode: 'suggest', timeoutMs: 90_000.7, chatTimeoutMs: 1, roundCap: 1e9}},
  {maxTurns: 2.5, exploreTurns: -3, maxInlineComments: 99.9, localReviewMaxTokens: 0, contextPadLines: 1e300, promptDiffMaxChars: -1},
  {username: '  ', mention: ['', 42, ' @x '], reviewOrder: ['grok', 'bogus'], chatgptReasoning: 'turbo', localReviewMode: 'x', publishMinSeverity: 'P7'},
  {reviewChatgpt: false, reviewGrok: false, reviewLocal: false},
  'not an object', null, [],
];

test('what load yields (disk or env seed), a save accepts: an unrelated save succeeds and keeps it', async () => {
  const rules = await import('../../src/lib/settings-rules.ts');
  for (const stored of STORED) {
    const h = harness(stored);
    assert.equal(rules.settingsProblem(h.state.settings), null, `loaded ${JSON.stringify(stored)} is save-valid`);
    const before = structuredClone(h.state.settings);
    const res = await h.post({skipDrafts: !before.skipDrafts});
    assert.equal(res.status, 200, `unrelated save over ${JSON.stringify(stored)}: ${JSON.stringify(await res.clone().json())}`);
    assert.deepEqual(h.state.settings, {...before, skipDrafts: !before.skipDrafts}, 'only the touched field changed');
  }
  // The loop stays OFF by default and for every non-runnable stored switch.
  assert.equal(harness().state.settings.fixAgent.enabled, false);
  for (const stored of STORED.slice(0, 4)) assert.equal(harness(stored).state.settings.fixAgent.enabled, false, JSON.stringify(stored));
  assert.equal(harness(STORED[3]).state.settings.fixAgent.provider, 'grok', 'a legacy grok fix provider stays visible (OFF)');
  assert.equal(harness(STORED[4]).state.settings.fixAgent.enabled, true, 'a runnable stored switch stays ON');
});

test('grok is refused as a fix provider by the Settings API (400, nothing saved); grok reviews are unaffected', async () => {
  const h = harness();
  const live = structuredClone(h.state.settings);
  for (const delivery of ['script-apply', 'chat-push']) {
    const res = await h.post({fixAgent: {enabled: true, provider: 'grok', delivery}});
    assert.equal(res.status, 400, delivery);
    assert.equal((await res.json()).error, 'grok is not supported as a fix provider yet: choose chatgpt, local to enable the review loop');
  }
  assert.equal(h.saves.length, 0);
  assert.deepEqual(h.state.settings, live);
  // a grok REVIEWER still saves, and the fix agent on chatgpt next to it too
  const ok = await h.post({reviewGrok: true, fixAgent: {enabled: true, provider: 'chatgpt', delivery: 'script-apply'}});
  assert.equal(ok.status, 200);
  assert.equal(h.state.settings.reviewGrok, true);assert.equal(h.state.settings.fixAgent.provider, 'chatgpt');
});

test('env seed: every whole-number env knob loads into the save domain', async (t) => {
  const {overlayEnv, sanitizeBotSettings} = await import('../../src/lib/settings.server.ts');
  const rules = await import('../../src/lib/settings-rules.ts');
  const env = {ASHLAR_MAX_TURNS: '2.5', ASHLAR_EXPLORE_TURNS: '-1', ASHLAR_MAX_INLINE_COMMENTS: '50', ASHLAR_LOCAL_REVIEW_MAX_TOKENS: '0',
    ASHLAR_LOCAL_REVIEW_SINGLE_TURN_MAX_TOKENS: '0.5', ASHLAR_PROMPT_DIFF_MAX_CHARS: '-5', ASHLAR_CONTEXT_PAD_LINES: '1e400',
    ASHLAR_FIX_TIMEOUT_MS: '90000.5', ASHLAR_FIX_PARALLEL_PRS: '0'};
  const prev = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, env);
  const seeded = sanitizeBotSettings(overlayEnv({}));
  assert.equal(rules.settingsProblem(seeded), null, JSON.stringify(seeded));
  assert.equal(seeded.maxTurns, 2);
  assert.equal(seeded.fixAgent.timeoutMs, 90_000);
});

// The schema is strict at EVERY nesting level: an unknown key inside a nested object (a typo such
// as fixAgent.paralellPrs) is a 400 before anything is merged or validated — never merged, ignored
// by the value rules, dropped by sanitize and answered 200 with nothing applied.
test('fixAgent: {paralellPrs: 9} (a typo) is a 400; nothing persisted, live settings unchanged', async () => {
  const h = harness({fixAgent: {enabled: true, provider: 'chatgpt', delivery: 'script-apply', mode: 'suggest', parallelPrs: 2}});
  const live = structuredClone(h.state.settings);
  const res = await h.post({fixAgent: {paralellPrs: 9}});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /fix_agent\.paralellPrs is not a writable settings field/);
  assert.equal(h.saves.length, 0, 'no persistence call');
  assert.deepEqual(h.state.settings, live, 'live settings unchanged');
  assert.deepEqual((await h.get()).fixAgent, live.fixAgent, 'the next GET reads the stored block');
});

test('an unknown fixAgent key next to a valid one is a 400; the valid one is not applied either', async () => {
  const h = harness();
  const live = structuredClone(h.state.settings);
  for (const patch of [{parallelPrs: 4, paralellPrs: 9}, {enabled: false, bogus: true}, {mode: 'apply', provider: 'grok', enabled_: true},
    {...live.fixAgent, extra: 1}, {parallelPrs: 4, constructor: 1}]) {
    const res = await h.post({fixAgent: patch});
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.match((await res.json()).error, /^fix_agent\.\S+ is not a writable settings field$/);
    assert.deepEqual(h.state.settings, live, `${JSON.stringify(patch)}: live settings unchanged`);
  }
  assert.equal(h.saves.length, 0, 'no persistence call');
});

// Every nested object in BotSettings (a plain object, or an array of objects — found from the
// defaults, so a future nested block is covered without editing this table) rejects an unknown key.
function nestedFields() {
  const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  return Object.entries(D).filter(([, v]) => isPlain(v) || (Array.isArray(v) && v.some(isPlain))).map(([k]) => k);
}

test('every nested settings object has a key rule, and an unknown key in any of them is a 400', async () => {
  const rules = await import('../../src/lib/settings-rules.ts');
  const nested = nestedFields();
  assert.ok(nested.includes('fixAgent'), 'fixAgent is a nested object');
  assert.ok(rules.NESTED_SETTINGS_RULES, 'settings-rules owns one key-rule table for every nested object');
  assert.deepEqual(Object.keys(rules.NESTED_SETTINGS_RULES).sort(), nested.sort(), 'one rule per nested object, none missing');
  for (const field of nested) {
    const def = D[field];
    const writable = Object.keys(rules.NESTED_SETTINGS_RULES[field].fields).sort();
    const shape = Array.isArray(def) ? def.find(v => v && typeof v === 'object') : def;
    assert.deepEqual(writable, Object.keys(shape).sort(), `${field}: the writable key set is exactly the stored shape`);
    const h = harness();
    const live = structuredClone(h.state.settings);
    const withUnknown = Array.isArray(def) ? def.map(v => ({...v, notAKey: 1})) : {...def, notAKey: 1};
    for (const value of [withUnknown, Array.isArray(def) ? [{notAKey: 1}] : {notAKey: 1}]) {
      const res = await h.post({[field]: value});
      assert.equal(res.status, 400, `${field}=${JSON.stringify(value)}`);
      assert.match((await res.json()).error, /notAKey is not a writable settings field/);
      assert.deepEqual(h.state.settings, live, `${field}: live settings unchanged`);
    }
    assert.equal(h.saves.length, 0, `${field}: nothing persisted`);
    // The screen's own check (settingsProblem on the draft it sends) refuses the same document.
    assert.match(rules.settingsProblem({...live, [field]: withUnknown}) ?? '', /notAKey is not a writable settings field/, `${field}: UI rejects it too`);
  }
});
