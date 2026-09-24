// One lease contract, two work-item kinds: the review job's bridge lease (proven in production)
// and the review-loop fix item's registry must answer the same scenarios the same way. A rule
// the fix registry re-implements differently fails here, not in a later review round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness, job as makeJob, types, json, creationSeq} from './load-source.mjs';

const CLAIM_MS = types.BRIDGE_CLAIM_MS;

/** bridge.server over a controllable clock (every Date.now() in the module reads it). */
function harness(jobs) {
  const clock = {now: Date.UTC(2026, 8, 24, 12)};
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  // As in production, a stored review result leaves awaiting_chat (validator) once harbor takes it.
  let state;
  const submitHarborChat = async id => { state.jobs = state.jobs.map(j => (j.id === id ? {...j, status: 'validator'} : j)); return {ok: true}; };
  const h = bridgeHarness(jobs, {Date: FixtureDate, submitHarborChat});
  state = h.state;
  return {...h, advance: ms => { clock.now += ms; }};
}
const settleMicrotasks = () => new Promise(resolve => setImmediate(resolve));
// Two different valid answers of each kind.
const ANSWERS = {
  review: [json, JSON.stringify({findings: [], merge_recommendation: 'APPROVE', investigated_safe: ['other answer']})],
  fix: ['{"summary":"a","files":[]}', '{"summary":"b","files":[]}'],
};

const progress = runId => ({chatgpt: {runId, events: [{source: 'page', sequence: 1, stage: 'prompt_prepared', at: 1}]}});

/** The same operations for either kind: `first`/`second` are two items of that kind for one PR each. */
const KINDS = {
  review: () => {
    const h = harness([makeJob({id: 'job-A', createdAt: 1}), makeJob({id: 'job-B', pr: 2, createdAt: 2})]);
    return {h, take: (client, known = []) => h.bridge.takeNextBridgeJob(client, known, {fixes: false}),
      complete: async (id, text, leaseId) => h.bridge.completeBridgeJob(id, text, [{provider: 'chatgpt', raw: text}], leaseId), unknown: 'job-unknown'};
  },
  fix: () => {
    const h = harness([]);
    for (const pr of [1, 2]) h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr, provider: 'chatgpt', prompt: `FIX ${pr}`}).catch(() => {});
    return {h, take: (client, known = []) => h.bridge.takeNextBridgeJob(client, known, {fixes: true}),
      complete: async (id, text, leaseId) => h.bridge.completeBridgeFix(id, text, [{provider: 'chatgpt', raw: text}], leaseId), unknown: 'fix-unknown'};
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

  test(`lease contract (${kind}): release frees the lease, never the profile; the owner's next take resumes`, () => {
    const {h, take} = make();
    const offer = take('chrome-1');
    assert.equal(h.bridge.recordBridgeProgress(offer.jobId, offer.leaseId, progress('run-A')), true);
    assert.ok(h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, offer.leaseId));
    h.bridge.releaseBridgeJob(offer.jobId, 'not-the-lease');
    assert.equal(h.bridge.claimBridgeJob(offer.jobId, 'chrome-1').leaseId, offer.leaseId, 'a release without the lease is ignored');
    h.bridge.releaseBridgeJob(offer.jobId, offer.leaseId);
    assert.equal(h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, offer.leaseId), false, 'the released lease is void');
    const others = take('chrome-2', []);
    assert.ok(!others || others.jobId !== offer.jobId, 'another profile never starts a replacement generation');
    assert.equal(h.bridge.claimBridgeJob(offer.jobId, 'chrome-2').ok, false);
    const again = take('chrome-1', [others?.jobId].filter(Boolean));
    assert.equal(again?.jobId, offer.jobId);
    assert.notEqual(again.leaseId, offer.leaseId);
    assert.equal(JSON.stringify(again.resumeProviders), '["chatgpt"]', 'resumed, never a fresh submission');
  });

  test(`lease contract (${kind}): a tab binding whose run was never reported is resumed, never re-submitted`, () => {
    const {h, take} = make();
    const offer = take('chrome-1');
    const binding = {jobId: offer.jobId, provider: 'chatgpt', runId: 'run-A'}; // the progress report was lost
    // Shared outcome: the owner gets the item back only as a RESUME of that tab. How differs by
    // kind (intended): a fix pins the page's run on recovery at once; a review job refuses an
    // unpinned recovery and is resumed by its own take once the claim goes stale.
    let resumed = h.bridge.recoverBridgeJob('chrome-1', [binding]);
    if (kind === 'review') {
      assert.equal(resumed, null);
      assert.equal(take('chrome-1'), null, 'a live claim is not handed out again');
      h.advance(CLAIM_MS + 1);
      resumed = take('chrome-1');
    }
    assert.equal(resumed?.jobId, offer.jobId);
    assert.equal(JSON.stringify(resumed.resumeProviders), '["chatgpt"]', 'resumed, never a fresh submission');
    assert.notEqual(take('chrome-1')?.jobId, offer.jobId, 'and never offered as a fresh submission afterwards');
    assert.equal(h.bridge.recoverBridgeJob('chrome-2', [binding]), null, 'never another profile');
  });

  test(`lease contract (${kind}): a stale claim stays with its profile`, () => {
    const {h, take} = make();
    const offer = take('chrome-1');
    assert.equal(h.bridge.recordBridgeProgress(offer.jobId, offer.leaseId, progress('run-A')), true);
    h.advance(CLAIM_MS + 1);
    assert.equal(h.bridge.claimBridgeJob(offer.jobId, 'chrome-2').ok, false, 'no heartbeat is not a transfer of ownership');
    const others = take('chrome-2');
    assert.ok(!others || others.jobId !== offer.jobId);
    assert.equal(h.bridge.recoverBridgeJob('chrome-1', [{jobId: offer.jobId, provider: 'chatgpt', runId: 'run-A'}])?.jobId, offer.jobId);
  });

  test(`lease contract (${kind}): complete needs the lease; a lost-ACK replay is identified by its payload`, async () => {
    const {h, take, complete, unknown} = make();
    const [answer, other] = ANSWERS[kind];
    const offer = take('chrome-1');
    assert.equal((await complete(offer.jobId, answer, 'not-the-lease')).code, 'lease_conflict');
    assert.equal((await complete(offer.jobId, answer, offer.leaseId)).ok, true);
    await settleMicrotasks();
    assert.equal((await complete(offer.jobId, answer, offer.leaseId)).ok, true, 'the same answer again: acknowledged');
    assert.equal((await complete(offer.jobId, answer, 'another-lease')).ok, true, 'the payload, not the lease, identifies a replay');
    const conflict = await complete(offer.jobId, other, offer.leaseId);
    assert.equal(conflict.ok, false, 'a different answer after completion is never accepted');
    assert.equal(h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, offer.leaseId), false, 'a settled item keeps no lease');
    assert.equal((await complete(unknown, answer, offer.leaseId)).ok, false, 'an unknown item never completes');
  });

  test(`lease contract (${kind}): failure needs the lease; nothing left to fail is acknowledged`, () => {
    const {h, take, unknown} = make();
    const offer = take('chrome-1');
    assert.equal(h.bridge.failBridgeProvider(offer.jobId, 'chatgpt', 'quota: usage limit', 'not-the-lease'), false);
    assert.equal(h.bridge.failBridgeProvider(offer.jobId, 'local', 'error', offer.leaseId), false, 'only a chat provider');
    assert.equal(h.bridge.failBridgeProvider(offer.jobId, 'chatgpt', 'quota: usage limit', offer.leaseId), true);
    assert.equal(h.bridge.failBridgeProvider(unknown, 'chatgpt', 'error', 'lease'), true, 'an unknown item has nothing left to fail');
  });

  test(`lease contract (${kind}): prompt and progress answer only for live work under its lease`, () => {
    const {h, take, unknown} = make();
    const offer = take('chrome-1');
    assert.ok(h.bridge.promptForJob(offer.jobId)?.prompt, 'the waiting item hands out its prompt');
    assert.equal(h.bridge.promptForJob(unknown), null);
    assert.equal(h.bridge.recordBridgeProgress(offer.jobId, 'not-the-lease', progress('run-A')), false);
    assert.equal(h.bridge.recordBridgeProgress(unknown, offer.leaseId, progress('run-A')), false);
    assert.equal(h.bridge.claimBridgeJob(unknown, 'chrome-1').ok, false);
    assert.equal(h.bridge.bridgeJobState(offer.jobId).active, true);
  });
}

// S19a: cross-kind take order is creation order, and a millisecond tie is not an order. Review
// jobs and fix items draw from one process-wide creation sequence (creation-seq.ts); createdAt
// stays the display timestamp. Every row runs on the frozen fixture clock: all items share one ms.
const T0 = Date.UTC(2026, 8, 24, 12);
const requestFix = h => h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr: 9, provider: 'chatgpt', prompt: 'FIX'}).catch(() => {});
const takeOrder = (h, n) => {
  const taken = [];
  for (let i = 0; i < n; i++) {
    const offer = h.bridge.takeNextBridgeJob('chrome-1', taken, {fixes: true});
    assert.ok(offer, `take ${i} offers work`);
    taken.push(offer.jobId);
    h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, offer.leaseId); // generation started
  }
  return taken.map(id => (id.startsWith('fix-') ? 'fix' : id));
};

test('take order (cross-kind): a review created in the same ms before a fix is taken first', () => {
  const h = harness([]);
  h.state.jobs = [makeJob({id: 'R', createdAt: T0, createdSeq: creationSeq.nextCreationSeq()})];
  requestFix(h);
  assert.deepEqual(takeOrder(h, 2), ['R', 'fix'], 'equal createdAt: the earlier-created review first');
});

test('take order (cross-kind): a fix created in the same ms before a review is taken first', () => {
  const h = harness([]);
  requestFix(h);
  h.state.jobs = [makeJob({id: 'R', createdAt: T0, createdSeq: creationSeq.nextCreationSeq()})];
  assert.deepEqual(takeOrder(h, 2), ['fix', 'R'], 'equal createdAt: the earlier-created fix first');
});

test('take order (cross-kind): a legacy review without a sequence keeps today\'s tie precedence', () => {
  const h = harness([makeJob({id: 'R', createdAt: T0})]);
  requestFix(h);
  assert.deepEqual(takeOrder(h, 2), ['fix', 'R'], 'an unordered tie never holds the fix');
});

test('take order (cross-kind): among equal-ms reviews the lowest sequence is the one that blocks the fix', () => {
  const h = harness([]);
  const first = creationSeq.nextCreationSeq();
  const second = creationSeq.nextCreationSeq();
  // harbor lists newest first: R2 is the candidate, R1 the older review the fix waits for
  h.state.jobs = [makeJob({id: 'R2', pr: 2, createdAt: T0, createdSeq: second}), makeJob({id: 'R1', pr: 1, createdAt: T0, createdSeq: first})];
  requestFix(h);
  assert.deepEqual(takeOrder(h, 3), ['R1', 'R2', 'fix']);
});

test('take order (fix kind): equal-ms fixes are taken in creation order', () => {
  const h = harness([]);
  for (const pr of [7, 3]) h.bridge.requestBridgeFix({owner: 'fixture', repo: 'fixture', pr, provider: 'chatgpt', prompt: `FIX ${pr}`}).catch(() => {});
  const first = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  assert.equal(first.title, 'fix fixture/fixture#7');
});
