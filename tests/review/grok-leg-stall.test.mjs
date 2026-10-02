// A Grok leg that reported its send and then no newer stage must end by a time cap on the SERVER
// (live aicc #629/#648/#649/#657/#662/#663: ChatGPT finished, Grok sat in waiting_for_response 40-73
// min and neither the page's 35 min wait nor the worker bounded it), and turning a reviewer off ends
// its unfinished legs on jobs already waiting on it. The worker is told which legs ended (endedProviders).
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness, fallback, job as makeJob, types} from './load-source.mjs';

const MIN = 60_000;
const row = (h, id) => h.state.jobs.find(j => j.id === id);
const racing = job => fallback.stillRacing({providers: job.reviewProviders, payloads: [], assumptions: job.assumptions,
  localInFlight: false, generating: job.generating, providerErrors: job.providerErrors});

function clocked(jobs) {
  const clock = {t: Date.now()};
  class FakeDate extends Date { static now() { return clock.t; } }
  const h = bridgeHarness(jobs, {Date: FakeDate});
  h.clock = clock;
  h.advance = ms => { clock.t += ms; };
  // Time passing under a live worker: a heartbeat every 2 min, as the real worker pings.
  h.wait = (ms, offer, generating = {chatgpt: true, grok: true}) => {
    for (let left = ms; left > 0; left -= 2 * MIN) {
      h.advance(Math.min(left, 2 * MIN));
      h.bridge.refreshBridgeClaim('R', generating, undefined, offer.leaseId);
    }
  };
  h.progress = (id, provider, stage) => {
    h.state.jobs = h.state.jobs.map(j => j.id === id ? {...j, providerProgress: {...j.providerProgress,
      [provider]: {runId: `run-${provider}`, stage, observedAt: clock.t, receivedAt: clock.t}}} : j);
  };
  return h;
}
const both = () => makeJob({id: 'R', createdAt: Date.now(), reviewProviders: ['chatgpt', 'grok']});

test('the Grok cap is 45 min, past the page\'s own 35 min wait; ChatGPT has none', () => {
  assert.equal(types.CHAT_LEG_STALL_MS.grok, 45 * MIN);
  assert.equal(types.CHAT_LEG_STALL_MS.chatgpt, undefined);
});

test('a grok leg stuck in waiting_for_response ends at the cap and the ChatGPT result stands', () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.progress('R', 'grok', 'waiting_for_response');
  h.wait(45 * MIN - 1, offer);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined, 'still waiting just inside the cap');
  assert.deepEqual([...h.bridge.bridgeJobState('R').endedProviders], []);
  h.wait(2, offer);
  const settled = row(h, 'R');
  assert.equal(settled.providerErrors.grok.code, 'error');
  assert.match(settled.providerErrors.grok.message, /no progress for 45 min .*waiting_for_response/);
  assert.equal(settled.generating.grok, false);
  assert.ok(settled.assumptions.some(note => note.startsWith('Skipped grok:')));
  assert.equal(settled.providerErrors?.chatgpt, undefined, 'the other leg is untouched');
  assert.deepEqual([...h.bridge.bridgeJobState('R').endedProviders], ['grok'], 'the worker is told to stop the leg');
  assert.equal(racing({...settled, generating: {chatgpt: false}}), true, 'chatgpt still races until it answers');
  assert.equal(racing({...settled, generating: {chatgpt: false}, storedLegs: [{provider: 'chatgpt', raw: '{}'}]}), true);
});

test('a newer stage restarts the clock', () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.progress('R', 'grok', 'waiting_for_response');
  h.wait(40 * MIN, offer);
  h.progress('R', 'grok', 'generating');
  h.wait(40 * MIN, offer);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined);
});

test('a leg that never reported a post-send stage is not capped by the server (the worker presend watchdog owns it)', () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.progress('R', 'grok', 'composer_waiting');
  h.advance(3 * 60 * MIN);
  h.bridge.refreshBridgeClaim('R', {chatgpt: true, grok: true}, undefined, offer.leaseId);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined);
  const noProgress = clocked([both()]);
  const o2 = noProgress.bridge.takeNextBridgeJob('chrome-1');
  noProgress.advance(3 * 60 * MIN);
  noProgress.bridge.refreshBridgeClaim('R', {chatgpt: true}, undefined, o2.leaseId);
  assert.equal(row(noProgress, 'R').providerErrors?.grok, undefined, 'a leg queued behind chatgpt has no progress and is left alone');
});

test('a collected or stored grok answer is never ended by the cap', () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.progress('R', 'grok', 'response_collected');
  h.advance(2 * 60 * MIN);
  h.bridge.refreshBridgeClaim('R', {chatgpt: true}, undefined, offer.leaseId);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined, 'a delivery in flight is not a stall');
  const stored = clocked([makeJob({id: 'R', createdAt: Date.now(), reviewProviders: ['chatgpt', 'grok'], storedLegs: [{provider: 'grok', raw: '{"x":1}'}]})]);
  const o2 = stored.bridge.takeNextBridgeJob('chrome-1');
  stored.progress('R', 'grok', 'waiting_for_response');
  stored.advance(2 * 60 * MIN);
  stored.bridge.refreshBridgeClaim('R', {chatgpt: true}, undefined, o2.leaseId);
  assert.equal(row(stored, 'R').providerErrors?.grok, undefined);
  assert.deepEqual([...stored.bridge.bridgeJobState('R').endedProviders], []);
});

test('turning grok off reads as a job created with grok off, never a Skipped reviewer', () => {
  const h = clocked([both(),
    makeJob({id: 'S', createdAt: Date.now() + 1, reviewProviders: ['chatgpt', 'grok'], storedLegs: [{provider: 'grok', raw: '{"x":1}'}]}),
    makeJob({id: 'T', createdAt: Date.now() + 2, reviewProviders: ['chatgpt']})]);
  h.bridge.endDisabledChatLegs(['grok']);
  assert.deepEqual([...row(h, 'R').reviewProviders], ['chatgpt']);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined, 'not a provider failure');
  assert.deepEqual([...(row(h, 'R').assumptions ?? [])], [], 'no "Skipped grok" note, so a clean verdict stays clean');
  assert.equal(row(h, 'R').generating.grok, false);
  assert.deepEqual([...h.bridge.bridgeJobState('R').endedProviders], ['grok'], 'the worker is told to stop the leg');
  assert.deepEqual([...row(h, 'S').reviewProviders], ['chatgpt', 'grok'], 'a stored answer stays');
  assert.deepEqual([...h.bridge.bridgeJobState('S').endedProviders], []);
  assert.deepEqual([...row(h, 'T').reviewProviders], ['chatgpt']);
  assert.deepEqual([...h.bridge.bridgeJobState('T').endedProviders], []);
});

test('turning grok off on a job that waits only on grok ends it as a failure', () => {
  const h = clocked([makeJob({id: 'R', reviewProviders: ['grok']})]);
  h.bridge.endDisabledChatLegs(['grok']);
  assert.equal(row(h, 'R').providerErrors.grok.code, 'cancelled');
  assert.match(row(h, 'R').providerErrors.grok.message, /turned off/);
  assert.deepEqual([...h.bridge.bridgeJobState('R').endedProviders], ['grok']);
});

test('endedProviders is empty for a transient disconnect and for a job that left awaiting_chat', () => {
  const h = clocked([both()]);
  h.state.jobs = h.state.jobs.map(j => ({...j, providerErrors: {grok: {code: 'disconnected', message: 'x'}}}));
  assert.deepEqual([...h.bridge.bridgeJobState('R').endedProviders], []);
  h.state.jobs = h.state.jobs.map(j => ({...j, status: 'posted', providerErrors: {grok: {code: 'error', message: 'x'}}}));
  assert.deepEqual([...h.bridge.bridgeJobState('R').endedProviders], []);
});

// Review of #159: the worker re-sends its whole step journal on every heartbeat; the cap counts from the
// newest step, never from the latest repeat of it.
test('heartbeats that repeat the same step do not restart the clock', () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  const report = {grok: {runId: 'run-grok', events: [{source: 'page', sequence: 1, stage: 'waiting_for_response', at: h.clock.t}]}};
  for (let i = 0; i < 21; i++) {
    h.bridge.recordBridgeProgress('R', offer.leaseId, report);
    h.wait(2 * MIN, offer);
  }
  assert.equal(row(h, 'R').providerErrors?.grok, undefined, '42 min in, still waiting');
  h.bridge.recordBridgeProgress('R', offer.leaseId, report);
  h.wait(4 * MIN, offer);
  assert.equal(row(h, 'R').providerErrors?.grok?.code, 'error', 'ended 45 min after the step although the worker kept pinging');
});

test('a worker that was away for more than 5 min restarts the stall clock instead of failing the leg on stale time', () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.progress('R', 'grok', 'waiting_for_response');
  h.advance(50 * MIN); // the machine slept
  h.bridge.refreshBridgeClaim('R', {chatgpt: true, grok: true}, undefined, offer.leaseId);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined, 'the first heartbeat after the outage does not end the leg');
  h.wait(44 * MIN, offer);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined);
  h.wait(2 * MIN, offer);
  assert.equal(row(h, 'R').providerErrors?.grok?.code, 'error', 'but a leg still silent 45 min later does end');
});

// Review of #159: the take path settles too, and must not fail a leg on time the worker was away.
test('a take poll after a long outage does not end the leg on stale time', () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.progress('R', 'grok', 'waiting_for_response');
  h.advance(50 * MIN);
  h.bridge.takeNextBridgeJob('chrome-1', ['R']);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined, 'nobody was watching those 50 min');
  h.bridge.refreshBridgeClaim('R', {chatgpt: true, grok: true}, undefined, offer.leaseId);
  h.wait(44 * MIN, offer);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined);
  h.wait(2 * MIN, offer);
  assert.equal(row(h, 'R').providerErrors?.grok?.code, 'error');
});

// Review of #159: a result or failure the worker still holds for a leg the server ended must be
// acknowledged, or the worker retries it every tick and keeps the tab held.
test('a late result or failure for a leg ended by turning grok off is acknowledged and not stored', async () => {
  const h = clocked([both()]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.bridge.endDisabledChatLegs(['grok']);
  const raw = JSON.stringify({summary: 'ok', findings: [], verdict: 'clean'});
  assert.equal(h.bridge.failBridgeProvider('R', 'grok', 'error: tab gone', offer.leaseId), true);
  assert.equal(row(h, 'R').providerErrors?.grok, undefined, 'no failure recorded');
  assert.deepEqual([...(row(h, 'R').assumptions ?? [])], []);
  const out = await h.bridge.completeBridgeJob('R', raw, [{provider: 'grok', raw}], offer.leaseId);
  assert.equal(out.ok, true);
  assert.equal((row(h, 'R').storedLegs ?? []).length, 0, 'the ended leg is not stored');
  assert.deepEqual([...row(h, 'R').reviewProviders], ['chatgpt']);
});

test('a leg that was never enabled still gets no acknowledgement', async () => {
  const h = clocked([makeJob({id: 'R', createdAt: Date.now(), reviewProviders: ['chatgpt']})]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  assert.equal(h.bridge.failBridgeProvider('R', 'grok', 'error: x', offer.leaseId), false);
  const raw = JSON.stringify({summary: 'ok', findings: [], verdict: 'clean'});
  const out = await h.bridge.completeBridgeJob('R', raw, [{provider: 'grok', raw}], offer.leaseId);
  assert.equal(out.ok, false);
});
