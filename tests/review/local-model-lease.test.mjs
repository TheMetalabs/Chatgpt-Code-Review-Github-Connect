// The process-wide local-model lease: FIFO, abort-aware, releasable by owner (src/lib/local-model-lease.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalModelLease, LocalModelLeaseReleased} from '../../src/lib/local-model-lease.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a holder keeps the model across all its turns; waiters are granted in FIFO order', async () => {
  const lease = new LocalModelLease();
  const calls = [];
  // Each "review" makes several model calls while holding one lease; a turn yields the event loop
  // between calls (tool execution, network), which is exactly where another review used to cut in.
  const review = (owner, turns) => (async () => {
    const handle = await lease.acquire(owner);
    try {
      for (let i = 1; i <= turns; i++) { calls.push(`${owner}${i}`); await tick(); }
    } finally { handle.release(); }
  })();
  await Promise.all([review('A', 3), review('B', 2), review('C', 1)]);
  assert.deepEqual(calls, ['A1', 'A2', 'A3', 'B1', 'B2', 'C1']);
  assert.deepEqual(lease.snapshot(), {active: [], queued: []});
});

test('queue positions are reported while waiting and move up as the queue advances', async () => {
  const lease = new LocalModelLease();
  const a = await lease.acquire('A');
  const seenB = [], seenC = [];
  const b = lease.acquire('B', {onPosition: p => seenB.push(p)});
  const c = lease.acquire('C', {onPosition: p => seenC.push(p)});
  assert.equal(lease.position('B'), 1);
  assert.equal(lease.position('C'), 2);
  a.release();
  const hb = await b;
  assert.equal(hb.owner, 'B');
  assert.deepEqual(seenB, [1]);
  assert.deepEqual(seenC, [2, 1]);
  hb.release();
  (await c).release();
});

test('abort while queued: the waiter leaves the queue at once and later waiters move up', async () => {
  const lease = new LocalModelLease();
  const a = await lease.acquire('A');
  const ctl = new AbortController();
  const b = lease.acquire('B', {signal: ctl.signal});
  const positions = [];
  const c = lease.acquire('C', {onPosition: p => positions.push(p)});
  ctl.abort(new Error('job cancelled'));
  await assert.rejects(b, /job cancelled/);
  assert.deepEqual(lease.snapshot().queued, ['C']);
  assert.deepEqual(positions, [2, 1]);
  a.release();
  const hc = await c;
  assert.equal(hc.owner, 'C');
  hc.release();
});

test('an already-aborted signal never queues', async () => {
  const lease = new LocalModelLease();
  const held = await lease.acquire('A');
  const ctl = new AbortController(); ctl.abort(new Error('gone'));
  await assert.rejects(lease.acquire('B', {signal: ctl.signal}), /gone/);
  assert.deepEqual(lease.snapshot().queued, []);
  held.release();
});

test('releaseOwner frees a held lease (next waiter starts) and drops that owner\'s queued waits', async () => {
  const lease = new LocalModelLease();
  const a = await lease.acquire('A');
  const b = lease.acquire('B');
  assert.equal(lease.releaseOwner('A'), 1);
  const hb = await b;
  assert.equal(hb.owner, 'B');
  a.release(); // the aborted leg's own finally: a no-op, never frees B's lease
  assert.deepEqual(lease.snapshot().active, ['B']);
  const c = lease.acquire('C');
  assert.equal(lease.releaseOwner('C'), 1);
  await assert.rejects(c, LocalModelLeaseReleased);
  hb.release();
  assert.deepEqual(lease.snapshot(), {active: [], queued: []});
});

test('release is idempotent', async () => {
  const lease = new LocalModelLease();
  const a = await lease.acquire('A');
  const b = lease.acquire('B');
  const c = lease.acquire('C');
  a.release(); a.release();
  const hb = await b;
  assert.deepEqual(lease.snapshot(), {active: ['B'], queued: ['C']}, 'a double release never grants a second holder');
  hb.release();
  (await c).release();
});
