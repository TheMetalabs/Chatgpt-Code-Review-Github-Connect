// Settings API (/api/harbor action=settings) for the fix agent / review loop: the route forwards
// the whole fixAgent block, the production sanitizer normalizes it, and the response and the next
// GET carry what was actually saved — the Settings screen is the loop's only switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs, types} from './load-source.mjs';
import {sanitizeBotSettings} from '../../src/lib/settings.server.ts';
import {normalizeChatgptReasoning, normalizeGrokReasoning} from '../../src/lib/reasoning.ts';

function harness() {
  const state = {settings: sanitizeBotSettings({})};
  const saves = [];
  const publicSettings = s => ({...s, webhookSecret: '', localLlmApiKey: ''});
  const {Route} = loadTs('src/routes/api/harbor.ts', {
    ...types,
    createFileRoute: () => config => config,
    getHarbor: () => ({...state, jobs: [], events: [], reviews: []}),
    // patchHarborSettings' contract: sanitize the merged settings, persist, swap the live state.
    patchHarborSettings: patch => {
      const next = sanitizeBotSettings({...state.settings, ...patch});
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

test('invalid fixAgent values are normalized, never stored as typed', async () => {
  const h = harness();
  const res = await h.post({fixAgent: {enabled: 'true', provider: 'skynet', delivery: 'teleport', mode: 'yolo',
    parallelPrs: 999, roundCap: -1, attempts: 'x', timeoutMs: 1, queueMaxMs: 1e15, chatTimeoutMs: null, chatMaxPromptChars: 5}});
  assert.equal(res.status, 200);
  const fix = h.state.settings.fixAgent;
  const K = types.FIX_AGENT_KNOBS;
  assert.deepEqual(fix, {enabled: false, provider: null, delivery: 'script-apply', mode: 'suggest', parallelPrs: K.parallelPrs.max,
    roundCap: K.roundCap.min, attempts: K.attempts.def, timeoutMs: K.timeoutMs.min, queueMaxMs: K.queueMaxMs.max,
    chatTimeoutMs: K.chatTimeoutMs.def, chatMaxPromptChars: K.chatMaxPromptChars.min});
  // An incompatible provider→delivery pair disables the provider instead of saving a dead config.
  await h.post({fixAgent: {enabled: true, provider: 'local', delivery: 'chat-push'}});
  assert.equal(h.state.settings.fixAgent.provider, null);
  // A non-object fixAgent is ignored (no save at all).
  const before = h.saves.length;
  await h.post({fixAgent: 'on'});
  await h.post({fixAgent: [true]});
  assert.equal(h.saves.length, before);
});
