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
  const wanted = {enabled: true, provider: 'grok', delivery: 'script-apply', mode: 'apply', parallelPrs: 2,
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
  const h = harness({fixAgent: {enabled: true, provider: 'grok', delivery: 'script-apply'}});
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
    assert.match((await res.json()).error, /not wired yet/);
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
  assert.equal((await h.post({fixAgent: {provider: 'grok'}})).status, 200);
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
