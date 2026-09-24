// One lease contract, two work-item kinds: the review job's bridge lease (proven in production)
// and the review-loop fix item's registry must answer the same scenarios the same way. A rule
// the fix registry re-implements differently fails here, not in a later review round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness, job as makeJob, types} from './load-source.mjs';

const CLAIM_MS = types.BRIDGE_CLAIM_MS;

/** bridge.server over a controllable clock (every Date.now() in the module reads it). */
function harness(jobs) {
  const clock = {now: Date.UTC(2026, 8, 24, 12)};
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const h = bridgeHarness(jobs, {Date: FixtureDate});
  return {...h, advance: ms => { clock.now += ms; }};
}

const progress = runId => ({chatgpt: {runId, events: [{source: 'page', sequence: 1, stage: 'prompt_prepared', at: 1}]}});

/** The same operations for either kind: `first`/`second` are two items of that kind for one PR each. */
const KINDS = {
  review: () => {
    const h = harness([makeJob({id: 'job-A', createdAt: 1}), makeJob({id: 'job-B', pr: 2, createdAt: 2})]);
    return {h, take: (client, known = []) => h.bridge.takeNextBridgeJob(client, known, {fixes: false})};
  },
  fix: () => {
    const h = harness([]);
    for (const pr of [1, 2]) h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr, provider: 'chatgpt', prompt: `FIX ${pr}`}).catch(() => {});
    return {h, take: (client, known = []) => h.bridge.takeNextBridgeJob(client, known, {fixes: true})};
  },
};

for (const [kind, make] of Object.entries(KINDS)) {
  test(`lease contract (${kind}): owner-only claims, stale renewal voids the old lease`, () => {
    const {h, take} = make();
    const offer = take('chrome-1');
    assert.ok(offer, 'taken');
    assert.equal(h.bridge.claimBridgeJob(offer.jobId, 'chrome-2').ok, false, 'another profile never claims it');
    assert.equal(h.bridge.claimBridgeJob(offer.jobId, 'chrome-1').leaseId, offer.leaseId, 'a fresh claim keeps its lease');
    h.advance(CLAIM_MS + 1);
    const renewed = h.bridge.claimBridgeJob(offer.jobId, 'chrome-1');
    assert.ok(renewed.ok && renewed.leaseId !== offer.leaseId, 'a stale claim is renewed under a new lease');
    assert.equal(h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, offer.leaseId), false, 'the old lease is void');
    assert.equal(h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, renewed.leaseId), true);
  });

  test(`lease contract (${kind}): one foreground submission per profile until generation starts`, () => {
    const {h, take} = make();
    const first = take('chrome-1');
    assert.ok(first);
    // the worker lists every job it knows (as the extension does)
    assert.equal(take('chrome-1', [first.jobId]), null, 'the profile is submitting: nothing else is handed to it');
    assert.ok(h.bridge.refreshBridgeClaim(first.jobId, {chatgpt: true}, undefined, first.leaseId));
    const next = take('chrome-1', [first.jobId]);
    assert.ok(next && next.jobId !== first.jobId, 'generation started: the next item is offered');
  });

  test(`lease contract (${kind}): one run per claim; recovery needs the same profile and run`, () => {
    const {h, take} = make();
    const offer = take('chrome-1');
    assert.equal(h.bridge.recordBridgeProgress(offer.jobId, offer.leaseId, progress('run-A')), true);
    assert.equal(h.bridge.recordBridgeProgress(offer.jobId, offer.leaseId, progress('run-B')), false, 'another run is rejected');
    const binding = {jobId: offer.jobId, provider: 'chatgpt', runId: 'run-A'};
    assert.equal(h.bridge.recoverBridgeJob('chrome-2', [binding]), null, 'not another profile');
    assert.equal(h.bridge.recoverBridgeJob('chrome-1', [{...binding, runId: 'run-B'}]), null, 'not another run');
    const resumed = h.bridge.recoverBridgeJob('chrome-1', [binding]);
    assert.equal(resumed?.jobId, offer.jobId);
    assert.equal(JSON.stringify(resumed.resumeProviders), '["chatgpt"]', 'a resume, never a fresh submission');
    assert.equal(JSON.stringify(resumed.bindings), JSON.stringify([binding]));
  });
}
