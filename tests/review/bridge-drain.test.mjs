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

const FIX = {owner: 'fixture', repo: 'fixture', pr: 9, provider: 'chatgpt', prompt: 'FIX PROMPT'};
const quiet = promise => { promise.catch(() => {}); return promise; };
const clocked = (jobs = []) => {
  const clock = {now: Date.now()};
  class ClockDate extends Date { static now() { return clock.now; } }
  const h = bridgeHarness(jobs, {workerStatusIsFresh: () => true, Date: ClockDate});
  h.state.settings = {...h.state.settings, fixAgent: {...h.state.settings.fixAgent, chatTimeoutMs: 30 * 60_000}};
  return {h, clock};
};
const fixState = (h, id) => h.bridge.getBridgePublic().fixItems.find(i => i.id === id);

test('a queued fix is not timed out by a drain longer than its timeout, and takes its remaining time from the window end', async () => {
  const {h, clock} = clocked();
  const queued = quiet(h.bridge.requestBridgeFix(FIX));
  clock.now += 10 * 60_000; // 20 minutes left
  const until = h.bridge.setBridgeDrain(90);
  const [item] = h.bridge.getBridgePublic().fixItems;
  assert.equal(item.deadlineInSec, Math.round((until + 20 * 60_000 - clock.now) / 1000));
  clock.now = until - 1; // 89+ minutes later: would be long dead without the hold
  assert.equal(h.bridge.getBridgePublic().fixItems[0].state, 'queued');
  assert.equal(h.bridge.getBridgePublic().pendingFixes, 1);
  clock.now = until + 1;
  assert.ok(h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true}), 'the fix is offered once the window ends');
  void queued;
});

test('a fix requested during a drain counts its timeout from the window end', () => {
  const {h, clock} = clocked();
  const until = h.bridge.setBridgeDrain(60);
  quiet(h.bridge.requestBridgeFix(FIX));
  assert.equal(h.bridge.getBridgePublic().fixItems[0].deadlineInSec, Math.round((until + 30 * 60_000 - clock.now) / 1000));
});

test('ending a drain early gives held fixes back the time they had left', () => {
  const {h, clock} = clocked();
  quiet(h.bridge.requestBridgeFix(FIX));
  clock.now += 10 * 60_000;
  h.bridge.setBridgeDrain(90);
  clock.now += 5 * 60_000;
  h.bridge.setBridgeDrain(0);
  assert.equal(h.bridge.getBridgePublic().fixItems[0].deadlineInSec, 20 * 60);
});

test('a drain gives no review to a claim by a profile that does not own it, but the owner renews', () => {
  const {h} = clocked([makeJob({id: 'A', pr: 1}), makeJob({id: 'B', pr: 2, bridgeClientId: 'chrome-1', attemptedProviders: ['chatgpt']})]);
  h.bridge.setBridgeDrain(30);
  assert.equal(h.bridge.claimBridgeJob('A', 'chrome-1').ok, false, 'never taken: not handed out');
  assert.equal(h.bridge.claimBridgeJob('B', 'chrome-2').ok, false);
  assert.equal(h.bridge.claimBridgeJob('B', 'chrome-1').ok, true, 'the owner renews its own');
});

test('rotating the bridge token keeps the drain window', () => {
  const {h} = clocked();
  const until = h.bridge.setBridgeDrain(30);
  h.bridge.rotateBridgeToken();
  assert.equal(h.bridge.getBridgePublic().drainUntil, until);
});
