// Local JSON repair takes the shared local-model lease in the short lane (json-repair.server.ts withModel).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JsonRepairService} from '../../src/lib/json-repair.server.ts';
import {ReviewHistoryStore} from '../../src/lib/review-history.server.ts';
import {DEFAULT_SETTINGS} from '../../src/lib/types.ts';
import {LocalChatCutOff} from '../../src/lib/local-chat-request.server.ts';
import {LocalModelLease} from '../../src/lib/local-model-lease.ts';
import {repairWaitingLabel} from '../../src/lib/repair-status-label.ts';

const value = {findings: [], investigated_safe: ['a.ts: checked "condition"']};
const raw = JSON.stringify(value), original = raw.replace(/\\"/g, '"');
const hash = text => createHash('sha256').update(text).digest('hex');
const input = {jobId: 'A', provider: 'chatgpt', runId: 'run-A', responseId: 'response-A', original, sourceHash: hash(original), schema: 'review', headSha: 'abc'};
const flush = () => new Promise(r => setImmediate(r));

function fixture(t, respond) {
  const lease = new LocalModelLease();
  const history = new ReviewHistoryStore(null);
  history.recordJob({id: 'A', owner: 'fixture', repo: 'repo', pr: 1, status: 'awaiting_chat', createdAt: 1, updatedAt: 1, findings: []});
  const settings = {...DEFAULT_SETTINGS, localLlmBaseUrl: 'http://local/v1', localLlmModel: 'formatter'};
  const calls = [];
  const deps = {
    history: () => history, settings: () => settings, isCurrent: () => true, isAccepted: () => false,
    accept: async () => ({ok: true}), lease: () => lease,
    request: async (...args) => { calls.push({args, snapshot: lease.snapshot()}); return respond ? respond(calls.length, ...args) : raw; },
  };
  const service = new JsonRepairService(deps);
  t.after(() => service.dispose());
  return {service, history, lease, calls};
}

test('a repair queued behind a holding review shows its position, runs at the review\'s checkpoint, then the review resumes', async t => {
  const f = fixture(t);
  const review = await f.lease.acquire('review-A');
  const queuedReview = f.lease.acquire('review-B');
  const started = f.service.start(input);
  await flush();
  assert.equal(f.calls.length, 0, 'no request while the review holds the model');
  const waiting = f.history.getRepair('A', started.id);
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.modelQueuePosition, 1, 'ahead of the queued review');
  assert.equal(repairWaitingLabel(waiting), 'Repair waiting for local model (position 1)');
  assert.equal(f.service.status('A', started.id).modelQueuePosition, 1, 'the status report carries it too');
  assert.deepEqual(f.lease.snapshot().queued, [`repair:${started.id}`, 'review-B']);

  assert.equal(await f.lease.checkpoint(review), 1);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].snapshot, {active: [`repair:${started.id}`], queued: ['review-B'], parked: ['review-A']});
  const done = f.service.status('A', started.id);
  assert.equal(done.status, 'ready');
  assert.equal('modelQueuePosition' in f.history.getRepair('A', started.id), false, 'cleared once granted');
  assert.equal(repairWaitingLabel(f.history.getRepair('A', started.id)), undefined);
  assert.deepEqual(f.lease.snapshot(), {active: ['review-A'], queued: ['review-B']}, 'the review got the model back ahead of review-B');
  review.release();
  (await queuedReview).release();
});

test('a lent repair that stops responding is aborted and hands the model back to the review', async t => {
  const previous = process.env.ASHLAR_LOCAL_REPAIR_DEADLINE_MS;
  process.env.ASHLAR_LOCAL_REPAIR_DEADLINE_MS = '10';
  t.after(() => {
    if (previous === undefined) delete process.env.ASHLAR_LOCAL_REPAIR_DEADLINE_MS;
    else process.env.ASHLAR_LOCAL_REPAIR_DEADLINE_MS = previous;
  });
  const f = fixture(t, (_n, _base, _key, _body, signal) => new Promise((_resolve, reject) => {
    const fail = () => reject(signal.reason ?? new Error('repair request aborted'));
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, {once: true});
  }));
  const review = await f.lease.acquire('review-A');
  const queuedReview = f.lease.acquire('review-B');
  const started = f.service.start(input);
  await flush();

  const checkpoint = f.lease.checkpoint(review);
  const resumed = await Promise.race([
    checkpoint.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100)),
  ]);

  assert.equal(resumed, true, 'the repair deadline must return the borrowed slot to review-A');
  assert.equal(f.history.getRepair('A', started.id).status, 'needs_attention');
  assert.deepEqual(f.lease.snapshot(), {active: ['review-A'], queued: ['review-B']});
  review.release();
  (await queuedReview).release();
});

test('the repair holds the model across its retries (cut off, then bumped): no queued job gets in between', async t => {
  const f = fixture(t, n => { if (n === 1) throw new LocalChatCutOff('length'); return raw; });
  const holder = await f.lease.acquire('fix-X', {lane: 'fix'});
  const started = f.service.start(input);
  await flush();
  const queuedReview = f.lease.acquire('review-B');
  holder.release();
  await flush(); await flush();
  assert.equal(f.calls.length, 2, 'first + bumped retry');
  for (const c of f.calls) assert.deepEqual(c.snapshot, {active: [`repair:${started.id}`], queued: ['review-B']});
  assert.equal(f.service.status('A', started.id).status, 'ready');
  (await queuedReview).release();
  assert.deepEqual(f.lease.snapshot(), {active: [], queued: []});
});

test('a repair cancelled while waiting leaves the queue and never sends', async t => {
  const f = fixture(t);
  const review = await f.lease.acquire('review-A');
  const started = f.service.start(input);
  await flush();
  assert.equal(f.lease.snapshot().queued.length, 1);
  f.service.cancel('superseded', 'A');
  await flush();
  assert.deepEqual(f.lease.snapshot(), {active: ['review-A'], queued: []});
  assert.equal(await f.lease.checkpoint(review), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.history.getRepair('A', started.id).status, 'superseded');
  review.release();
});

test('an idle model: the repair runs at once and releases in finally, even when the request fails', async t => {
  const f = fixture(t, () => { throw new Error('local LLM HTTP 500: boom'); });
  const started = f.service.start(input);
  await flush(); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.history.getRepair('A', started.id).status, 'needs_attention');
  assert.equal('modelQueuePosition' in f.history.getRepair('A', started.id), false, 'never waited: never marked');
  assert.deepEqual(f.lease.snapshot(), {active: [], queued: []});
});

test('a deterministic repair (stray quotes) needs no model and never touches the lease', async t => {
  const f = fixture(t);
  const review = await f.lease.acquire('review-A');
  const stray = '{"findings":[],"investigated_safe":["a.ts: checked C:\\\\"x"]}'; // a \\" slip
  const started = f.service.start({...input, original: stray, sourceHash: hash(stray)});
  assert.equal(started.status, 'running');
  await flush();
  assert.equal(f.history.getRepair('A', started.id).status, 'ready', 'repaired without the model');
  assert.deepEqual(f.lease.snapshot(), {active: ['review-A'], queued: []});
  assert.equal(f.calls.length, 0);
  review.release();
});

// #143 review: a repair invalidated while it waits for the model never sends, and leaves the queue.
test('a repair superseded while queued (status) leaves the queue at once and never sends', async t => {
  const f = fixture(t);
  let current = true;
  f.service['deps'].isCurrent = () => current;
  const review = await f.lease.acquire('review-A');
  const started = f.service.start(input);
  await flush();
  assert.deepEqual(f.lease.snapshot().queued, [`repair:${started.id}`]);
  current = false;
  assert.equal(f.service.status('A', started.id).status, 'superseded');
  await flush();
  assert.deepEqual(f.lease.snapshot(), {active: ['review-A'], queued: []}, 'the waiter is gone immediately');
  assert.equal(await f.lease.checkpoint(review), 0, 'nothing to lend to');
  review.release();
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.history.getRepair('A', started.id).status, 'superseded');
});

test('a repair accepted while queued leaves the queue and never sends', async t => {
  const f = fixture(t);
  let accepted = false;
  f.service['deps'].isAccepted = () => accepted;
  const review = await f.lease.acquire('review-A');
  const started = f.service.start(input);
  await flush();
  accepted = true;
  assert.equal(f.service.status('A', started.id).status, 'accepted');
  await flush();
  assert.deepEqual(f.lease.snapshot(), {active: ['review-A'], queued: []});
  review.release();
  await flush();
  assert.equal(f.calls.length, 0);
});

test('a repair that stops being current while granted gives the model back without sending', async t => {
  const f = fixture(t);
  let current = true;
  f.service['deps'].isCurrent = () => current;
  const review = await f.lease.acquire('review-A');
  const started = f.service.start(input);
  await flush();
  current = false; // no status() call: the grant itself must re-check
  review.release();
  await flush(); await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.history.getRepair('A', started.id).status, 'superseded');
  assert.deepEqual(f.lease.snapshot(), {active: [], queued: []});
});

test('dispose leaves no outstanding waiter', async t => {
  const f = fixture(t);
  const review = await f.lease.acquire('review-A');
  f.service.start(input);
  await flush();
  assert.equal(f.lease.snapshot().queued.length, 1);
  f.service.dispose();
  await flush();
  assert.deepEqual(f.lease.snapshot(), {active: ['review-A'], queued: []});
  review.release();
  await flush();
  assert.equal(f.calls.length, 0);
});
