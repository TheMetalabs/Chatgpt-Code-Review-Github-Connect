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

test('a granted-but-not-yet-resumed holder is revoked by releaseOwner without its continuation running', async () => {
  // Ownership is registered synchronously when the grant happens (before the waiter's promise
  // resolves), so a cancellation landing before the holder resumes frees the model by itself.
  const lease = new LocalModelLease();
  const a = await lease.acquire('A');
  const b = lease.acquire('B'); // never awaited below until the end: its continuation does not run
  const c = lease.acquire('C');
  a.release(); // B is granted now
  assert.deepEqual(lease.snapshot(), {active: ['B'], queued: ['C']}, 'B owns the model before it resumes');
  assert.equal(lease.releaseOwner('B'), 1); // cancel B in the same tick
  assert.deepEqual(lease.snapshot(), {active: ['C'], queued: []}, 'C is granted without B resuming');
  const hc = await c;
  assert.equal(hc.owner, 'C');
  (await b).release(); // B's late continuation gives back a handle that is already revoked: a no-op
  assert.deepEqual(lease.snapshot().active, ['C']);
  hc.release();
});

test('fix lane: a queued fix waits for the holding review, then goes before every queued review', async () => {
  const lease = new LocalModelLease();
  const holder = await lease.acquire('R1');
  const order = [];
  const take = (owner, lane) => lease.acquire(owner, lane ? {lane} : {}).then(h => { order.push(owner); return h; });
  const r2 = take('R2');
  const f1 = take('F1', 'fix');
  const r3 = take('R3');
  const f2 = take('F2', 'fix');
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: ['F1', 'F2', 'R2', 'R3']}, 'fixes queue ahead of reviews, FIFO within a lane');
  await tick();
  assert.deepEqual(order, [], 'a fix never preempts the review that holds the model');
  holder.release();
  for (const p of [f1, f2, r2, r3]) (await p).release();
  assert.deepEqual(order, ['F1', 'F2', 'R2', 'R3']);
  assert.deepEqual(lease.snapshot(), {active: [], queued: []});
});

test('fix lane: queue positions shift when a fix jumps ahead of waiting reviews', async () => {
  const lease = new LocalModelLease();
  const holder = await lease.acquire('R1');
  const seen = [];
  const r2 = lease.acquire('R2', {onPosition: p => seen.push(p)});
  const f = lease.acquire('F', {lane: 'fix'});
  assert.deepEqual(seen, [1, 2], 'the waiting review is told it moved back behind the fix');
  holder.release();
  (await f).release();
  (await r2).release();
  assert.deepEqual(seen, [1, 2, 1]);
});

test('fix lane: abort while queued leaves the queue, the reviews behind it keep their order', async () => {
  const lease = new LocalModelLease();
  const holder = await lease.acquire('R1');
  const ctl = new AbortController();
  const f = lease.acquire('F', {lane: 'fix', signal: ctl.signal});
  const r2 = lease.acquire('R2');
  ctl.abort(new Error('fix cancelled'));
  await assert.rejects(f, /fix cancelled/);
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: ['R2']});
  holder.release();
  (await r2).release();
});

test('fix lane: an idle model is granted to a fix at once', async () => {
  const lease = new LocalModelLease();
  const f = await lease.acquire('F', {lane: 'fix'});
  assert.deepEqual(lease.snapshot(), {active: ['F'], queued: []});
  f.release();
});
