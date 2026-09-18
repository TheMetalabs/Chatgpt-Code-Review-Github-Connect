import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness, job as makeJob} from './load-source.mjs';

test('a Chrome profile is not handed a second job while it is still submitting the first', () => {
  const {bridge} = bridgeHarness([makeJob({id: 'A', pr: 1}), makeJob({id: 'B', pr: 2})]);
  const first = bridge.takeNextBridgeJob('chrome-1');
  assert.equal(first.jobId, 'A');
  // A is claimed but not yet generating (still submitting, tab foreground) — handing out
  // B now would open a second tab and steal focus, clobbering A's submission.
  assert.equal(bridge.takeNextBridgeJob('chrome-1'), null);
  // A confirms its submission (generation started); its tab can go background now.
  bridge.refreshBridgeClaim('A', {chatgpt: true}, undefined, first.leaseId);
  const second = bridge.takeNextBridgeJob('chrome-1');
  assert.equal(second.jobId, 'B');
});

test('the submission gate is per Chrome profile, not global', () => {
  const {bridge} = bridgeHarness([makeJob({id: 'A', pr: 1}), makeJob({id: 'B', pr: 2})]);
  assert.equal(bridge.takeNextBridgeJob('chrome-1').jobId, 'A');
  // A different profile has its own tab and may submit in parallel.
  assert.equal(bridge.takeNextBridgeJob('chrome-2').jobId, 'B');
});

test('a stuck submission stops blocking the queue after the window', () => {
  const stuck = makeJob({id: 'A', pr: 1, bridgeClientId: 'chrome-1', bridgeClaimedAt: Date.now(), bridgeSubmitAt: Date.now() - 4 * 60_000});
  const {bridge} = bridgeHarness([stuck, makeJob({id: 'B', pr: 2})]);
  // A was claimed 4 min ago and never started generating (stuck submission). The gate is
  // bounded, so it must not block B forever.
  assert.equal(bridge.takeNextBridgeJob('chrome-1').jobId, 'B');
});
