// A leg whose worker reports "original job binding unavailable" (ping providerErrors code
// `disconnected`) and never reports a bound run again must not wait forever: the heartbeats keep
// its claim fresh, so it is never re-offered, and `disconnected` is not terminal. After
// BINDING_LOST_MS of that (measured from the first binding-less heartbeat) it settles as a
// provider failure and the job ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness, fallback, job as makeJob, types} from './load-source.mjs';

const MIN = 60_000;
const LOST = {chatgpt: {code: 'disconnected', message: 'original job binding unavailable; waiting for reconnection'}};
const quiet = promise => { promise.catch(() => {}); return promise; };

function clocked(jobs) {
  const clock = {t: Date.now()};
  class FakeDate extends Date { static now() { return clock.t; } }
  const h = bridgeHarness(jobs, {Date: FakeDate});
  h.clock = clock;
  h.advance = ms => { clock.t += ms; };
  return h;
}
const racing = job => fallback.stillRacing({providers: job.reviewProviders, payloads: [], assumptions: job.assumptions,
  localInFlight: false, generating: job.generating, providerErrors: job.providerErrors});
const row = (h, id) => h.state.jobs.find(j => j.id === id);

test('BINDING_LOST_MS is bounded well inside the claim lease', () => {
  assert.equal(types.BINDING_LOST_MS, 10 * MIN);
  assert.ok(types.BINDING_LOST_MS < types.BRIDGE_CLAIM_MS);
});

test('a leg whose original binding stays unavailable settles as a provider failure, never waits forever', () => {
  const h = clocked([makeJob({id: 'R', createdAt: Date.now()})]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  assert.equal(offer.jobId, 'R');
  // The worker keeps heartbeating the job, every minute, with the binding unavailable.
  for (let i = 0; i < 10; i++) {
    assert.equal(h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId), true);
    h.advance(MIN - 1);
    assert.equal(row(h, 'R').providerErrors.chatgpt.code, 'disconnected', `minute ${i}: still a transient wait`);
    assert.equal(racing(row(h, 'R')), true);
  }
  h.advance(10);
  h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId);
  const settled = row(h, 'R');
  assert.equal(settled.providerErrors.chatgpt.code, 'error', 'past the bound the leg is a provider failure');
  assert.match(settled.providerErrors.chatgpt.message, /binding/);
  assert.equal(settled.generating.chatgpt, false);
  assert.ok(settled.assumptions.some(note => note.startsWith('Skipped chatgpt:')));
  assert.equal(racing(settled), false, 'the job ends: nothing is left racing');
  assert.equal(h.bridge.nextBridgeJob('chrome-1'), null, 'nothing left to offer');
});

test('a lost binding whose worker stopped heartbeating settles on the next take (any profile)', () => {
  const h = clocked([makeJob({id: 'R', createdAt: Date.now()})]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId);
  h.advance(10 * MIN + 1);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-2'), null);
  assert.equal(row(h, 'R').providerErrors.chatgpt.code, 'error');
  assert.equal(racing(row(h, 'R')), false);
});

test('a bound run reported again restarts the bound; a transient outage never fails the leg', () => {
  const h = clocked([makeJob({id: 'R', createdAt: Date.now()})]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId);
  h.advance(9 * MIN);
  h.bridge.refreshBridgeClaim('R', {chatgpt: true}, undefined, offer.leaseId); // the page answered again
  h.advance(MIN);
  h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId);
  h.advance(9 * MIN);
  h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId);
  assert.equal(row(h, 'R').providerErrors.chatgpt.code, 'disconnected', '9 min since the binding was lost again');
  h.advance(MIN);
  h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId);
  assert.equal(row(h, 'R').providerErrors.chatgpt.code, 'error');
});

test('a stranded review never holds a queued fix\'s precedence', () => {
  // R predates the fix, lost its binding, and its worker went away (claim stale): the next take
  // serves the fix, not a resume of a run nobody can bind.
  const h = clocked([makeJob({id: 'R', createdAt: Date.now() - MIN})]);
  const offer = h.bridge.takeNextBridgeJob('chrome-1');
  h.bridge.refreshBridgeClaim('R', {chatgpt: false}, LOST, offer.leaseId);
  quiet(h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr: 9, provider: 'chatgpt', prompt: 'FIX'}));
  h.advance(types.BRIDGE_CLAIM_MS + 1);
  const next = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  assert.equal(next?.kind, 'fix');
  assert.equal(row(h, 'R').providerErrors.chatgpt.code, 'error');
});

test('a fix leg whose original binding stays unavailable fails after BINDING_LOST_MS, freeing its slot', async () => {
  // Validation on PR #93: the fix was taken, its worker lost the binding and kept heartbeating
  // `disconnected`: the claim stayed fresh, pendingFixes 1, and the only parallelPrs slot held,
  // until the fix deadline (30 min default).
  const h = clocked([]);
  const pending = quiet(h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr: 93, provider: 'chatgpt', prompt: 'FIX'}));
  const offer = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  assert.equal(offer?.kind, 'fix');
  const other = quiet(h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr: 94, provider: 'chatgpt', prompt: 'FIX 2'}));
  for (let i = 0; i < 10; i++) {
    assert.equal(h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: false}, LOST, offer.leaseId), true);
    h.advance(MIN - 1);
    assert.equal(h.bridge.bridgeJobState(offer.jobId).status, 'awaiting_chat', `minute ${i}: still a transient wait`);
  }
  h.advance(10);
  h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: false}, LOST, offer.leaseId);
  assert.equal(h.bridge.bridgeJobState(offer.jobId).status, 'dlq', 'past the bound the fix is a provider failure');
  await assert.rejects(pending, /binding/);
  const next = h.bridge.takeNextBridgeJob('chrome-1', [offer.jobId], {fixes: true});
  assert.equal(next?.kind, 'fix', 'the freed slot serves the next fix');
  void other;
});

test('a fix leg that reports its run again restarts the bound', () => {
  const h = clocked([]);
  quiet(h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr: 93, provider: 'chatgpt', prompt: 'FIX'}));
  const offer = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: false}, LOST, offer.leaseId);
  h.advance(9 * MIN);
  h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, offer.leaseId);
  h.advance(MIN);
  h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: false}, LOST, offer.leaseId);
  h.advance(9 * MIN);
  h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: false}, LOST, offer.leaseId);
  assert.equal(h.bridge.bridgeJobState(offer.jobId).status, 'awaiting_chat');
});
