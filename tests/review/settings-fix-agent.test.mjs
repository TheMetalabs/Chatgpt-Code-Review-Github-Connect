// Settings API (/api/harbor action=settings) for the fix agent / review loop: the route forwards
// the whole fixAgent block, the production rules (settings-rules — the same ones the Settings
// screen runs) validate it, and the response and the next GET carry what was actually saved — the
// Settings screen is the loop's only switch. A rejected value is a 400 and a failed persist a 500;
// neither changes the live settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs, types} from './load-source.mjs';
import {sanitizeBotSettings} from '../../src/lib/settings.server.ts';
import {SettingsError, validatedSettingsPatch} from '../../src/lib/settings-rules.ts';
import {normalizeChatgptReasoning, normalizeGrokReasoning} from '../../src/lib/reasoning.ts';

function harness() {
  const state = {settings: sanitizeBotSettings({}), persistFails: false};
  const saves = [];
  const publicSettings = s => ({...s, webhookSecret: '', localLlmApiKey: ''});
  const {Route} = loadTs('src/routes/api/harbor.ts', {
    ...types,
    createFileRoute: () => config => config,
    getHarbor: () => ({...state, jobs: [], events: [], reviews: []}),
    // patchHarborSettings' contract: validate the merged document (the production rules), sanitize,
    // persist (the JSON store must be written, else SettingsError 500), THEN swap the live state.
    patchHarborSettings: patch => {
      const next = sanitizeBotSettings(validatedSettingsPatch(state.settings, patch));
      if (state.persistFails) throw new SettingsError('could not save settings: .data/ashlar-settings.json is not writable (ENOTDIR); nothing was changed', 500);
      saves.push(next);
      state.settings = next;
      return next;
    },
    publicSettings, publicJobs: j => j, publicReviews: r => r,
    githubStatus: () => ({}), getBridgePublic: () => ({}), reviewHistory: () => ({health: () => ({ok: true})}),
    normalizeChatgptReasoning, normalizeGrokReasoning,
  });
  const post = body => Route.server.handlers.POST({request: new Request('http://ashlar.test/api/harbor', {
    method: 'POST', headers: {origin: 'http://ashlar.test', 'content-type': 'application/json'}, body: JSON.stringify({action: 'settings', ...body}),
  })});
  const get = async () => (await (await Route.server.handlers.GET()).json()).settings;
  return {state, saves, post, get};
}

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
  // A non-object fixAgent is ignored (no save at all).
  await h.post({fixAgent: 'on'});
  await h.post({fixAgent: [true]});
  assert.equal(h.saves.length, 0);
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
