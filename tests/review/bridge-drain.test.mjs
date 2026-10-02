// A drain window stops take (reviews and fixes) so the worker can reach idle for an extension update;
// it expires on its own, can be ended, and never touches already-claimed jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness, job as makeJob} from './load-source.mjs';

const harness = () => bridgeHarness([makeJob({id: 'A', pr: 1}), makeJob({id: 'B', pr: 2, createdAt: Date.now() + 1000})], {workerStatusIsFresh: () => true});

test('draining offers nothing, reports drainUntil, and ending it resumes take', () => {
  const h = harness();
  const until = h.bridge.setBridgeDrain(30);
  assert.ok(until > Date.now() + 29 * 60_000);
  assert.equal(h.bridge.getBridgePublic().drainUntil, until);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true}), null);
  assert.equal(h.state.jobs.some(j => j.bridgeClaimedAt), false, 'nothing was claimed while draining');
  assert.equal(h.bridge.setBridgeDrain(0), undefined);
  assert.equal(h.bridge.getBridgePublic().drainUntil, undefined);
  assert.ok(h.bridge.takeNextBridgeJob('chrome-1'), 'take works again');
});

test('a drain window is capped and expires by itself', () => {
  let clock = Date.now();
  class ClockDate extends Date { static now() { return clock; } }
  const h = bridgeHarness([makeJob({id: 'A', pr: 1})], {workerStatusIsFresh: () => true, Date: ClockDate});
  const until = h.bridge.setBridgeDrain(100_000);
  assert.equal(until, clock + h.bridge.MAX_DRAIN_MINUTES * 60_000);
  clock = until + 1;
  assert.equal(h.bridge.getBridgePublic().drainUntil, undefined, 'an expired window is not reported');
  assert.ok(h.bridge.takeNextBridgeJob('chrome-1'), 'an expired window offers work again');
});

test('a drain does not stop recover or the owner of a claimed job', () => {
  const h = bridgeHarness([makeJob({id: 'A', pr: 1, bridgeClaimedAt: Date.now(), bridgeLeaseId: 'L', bridgeClientId: 'chrome-1', attemptedProviders: ['chatgpt']})]);
  h.bridge.setBridgeDrain(30);
  assert.equal(h.bridge.refreshBridgeClaim('A', {chatgpt: true}, {}, 'L'), true, 'the lease keeps pinging');
});
