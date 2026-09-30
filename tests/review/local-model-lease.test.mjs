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

// --- short lane + checkpoint (JSON repair runs between a holding review's turns) ---
import {shortJobsPerCheckpoint, DEFAULT_SHORT_PER_CHECKPOINT, MAX_SHORT_PER_CHECKPOINT} from '../../src/lib/local-model-lease.ts';

test('short lane: queued ahead of fix and review waiters', async () => {
  const lease = new LocalModelLease();
  const holder = await lease.acquire('R1');
  const waits = [lease.acquire('R2'), lease.acquire('F', {lane: 'fix'}), lease.acquire('S1', {lane: 'short'}), lease.acquire('S2', {lane: 'short'})];
  assert.deepEqual(lease.snapshot().queued, ['S1', 'S2', 'F', 'R2']);
  holder.release();
  for (const w of [waits[2], waits[3], waits[1], waits[0]]) (await w).release();
});

test('short lane: a late repair moves ahead of already queued fix and review work', async () => {
  const lease = new LocalModelLease();
  const holder = await lease.acquire('R1');
  const review = lease.acquire('R2');
  const fix = lease.acquire('F', {lane: 'fix'});
  const short = lease.acquire('S', {lane: 'short'});
  assert.deepEqual(lease.snapshot().queued, ['S', 'F', 'R2']);
  holder.release();
  (await short).release();
  (await fix).release();
  (await review).release();
});

test('checkpoint lends the model to waiting short jobs, then the holder resumes ahead of queued fix/review', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('R1');
  const log = [];
  const r2 = lease.acquire('R2').then(h => { log.push('R2'); return h; });
  const fix = lease.acquire('F', {lane: 'fix'}).then(h => { log.push('F'); return h; });
  const short = (owner) => lease.acquire(owner, {lane: 'short'}).then(async h => { log.push(`${owner}+`); await tick(); log.push(`${owner}-`); h.release(); });
  const s1 = short('S1');
  await tick();
  assert.deepEqual(log, [], 'no preemption mid-turn: the short job waits for the checkpoint');
  const served = await lease.checkpoint(review);
  log.push('R1 resumes');
  await s1;
  assert.equal(served, 1);
  assert.deepEqual(log, ['S1+', 'S1-', 'R1 resumes'], 'the fix and the waiting review stay queued while the model is lent');
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: ['F', 'R2']});
  review.release();
  (await fix).release();
  (await r2).release();
  assert.deepEqual(log, ['S1+', 'S1-', 'R1 resumes', 'F', 'R2']);
});

test('checkpoint serves at most cap short jobs; the rest wait for the next checkpoint', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('R1');
  const ran = [];
  const shorts = ['S1', 'S2', 'S3'].map(o => lease.acquire(o, {lane: 'short'}).then(h => { ran.push(o); h.release(); }));
  assert.equal(await lease.checkpoint(review, 2), 2);
  assert.deepEqual(ran, ['S1', 'S2']);
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: ['S3']});
  assert.equal(await lease.checkpoint(review, 2), 1);
  await Promise.all(shorts);
  assert.deepEqual(ran, ['S1', 'S2', 'S3']);
  assert.equal(await lease.checkpoint(review, 2), 0, 'nothing waiting: a no-op');
  assert.equal(await lease.checkpoint(review, 0), 0);
  review.release();
  assert.deepEqual(lease.snapshot(), {active: [], queued: []});
});

test('checkpoint with cap 0 never lends; a short job then runs when the holder releases', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('R1');
  const s = lease.acquire('S', {lane: 'short'});
  assert.equal(await lease.checkpoint(review, 0), 0);
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: ['S']});
  review.release();
  (await s).release();
});

test('a short job aborted while queued leaves the queue; checkpoint lends nothing', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('R1');
  const ctl = new AbortController();
  const s = lease.acquire('S', {lane: 'short', signal: ctl.signal});
  ctl.abort(new Error('repair superseded'));
  await assert.rejects(s, /repair superseded/);
  assert.equal(await lease.checkpoint(review), 0);
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: []});
  review.release();
});

test('the holder cancelled while its slot is lent: checkpoint returns at once, the queue advances after the short job', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('R1');
  const next = lease.acquire('R2');
  let releaseShort;
  const s = lease.acquire('S', {lane: 'short'}).then(h => new Promise(r => { releaseShort = () => { h.release(); r(); }; }));
  const cp = lease.checkpoint(review);
  await tick();
  assert.deepEqual(lease.snapshot(), {active: ['S'], queued: ['R2'], parked: ['R1']});
  assert.equal(lease.releaseOwner('R1'), 1);
  assert.equal(await cp, 1, 'returns at once (one short job was lent)');
  assert.deepEqual(lease.snapshot(), {active: ['S'], queued: ['R2']}, 'the running short job keeps the slot');
  releaseShort(); await s;
  const h2 = await next;
  assert.equal(h2.owner, 'R2');
  review.release(); // the revoked holder's own finally: a no-op
  assert.deepEqual(lease.snapshot(), {active: ['R2'], queued: []});
  h2.release();
});

test('a short job revoked by releaseOwner mid-lend hands the model straight back to the holder', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('R1');
  const next = lease.acquire('R2');
  const s = lease.acquire('S', {lane: 'short'});
  const cp = lease.checkpoint(review);
  const hs = await s;
  assert.equal(lease.releaseOwner('S'), 1);
  assert.equal(await cp, 1);
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: ['R2']}, 'no queued review slipped in');
  hs.release(); // late release of the revoked short handle: a no-op
  assert.deepEqual(lease.snapshot(), {active: ['R1'], queued: ['R2']});
  review.release();
  (await next).release();
});

test('a short job waiting behind a fix holder runs when the fix releases (fixes are one call, never lent)', async () => {
  const lease = new LocalModelLease();
  const fix = await lease.acquire('F', {lane: 'fix'});
  const r = lease.acquire('R');
  const s = lease.acquire('S', {lane: 'short'});
  fix.release();
  const hs = await s;
  assert.deepEqual(lease.snapshot(), {active: ['S'], queued: ['R']});
  hs.release();
  (await r).release();
});

test('checkpoint on a handle that no longer holds the model is a no-op', async () => {
  const lease = new LocalModelLease();
  const a = await lease.acquire('A');
  a.release();
  const b = await lease.acquire('B');
  const s = lease.acquire('S', {lane: 'short'});
  assert.equal(await lease.checkpoint(a), 0);
  assert.deepEqual(lease.snapshot(), {active: ['B'], queued: ['S']});
  b.release();
  (await s).release();
});

test('ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: default 2, 0 allowed, junk falls back to the default', () => {
  assert.equal(DEFAULT_SHORT_PER_CHECKPOINT, 2);
  assert.equal(MAX_SHORT_PER_CHECKPOINT, 16);
  assert.equal(shortJobsPerCheckpoint({}), 2);
  assert.equal(shortJobsPerCheckpoint({ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: ''}), 2);
  assert.equal(shortJobsPerCheckpoint({ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: '0'}), 0);
  assert.equal(shortJobsPerCheckpoint({ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: '5'}), 5);
  assert.equal(shortJobsPerCheckpoint({ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: '1000000000'}), 16);
  assert.equal(shortJobsPerCheckpoint({ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: '-1'}), 2);
  assert.equal(shortJobsPerCheckpoint({ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: 'lots'}), 2);
});

test('capacity 2: a lent slot is counted once, so a queued review takes the free slot while the short job runs (#143 review)', async () => {
  const lease = new LocalModelLease(2);
  const r1 = await lease.acquire('R1');
  const r2 = await lease.acquire('R2');
  let s;
  const short = lease.acquire('S', {lane: 'short'}).then(h => (s = h));
  let r3;
  const third = lease.acquire('R3').then(h => (r3 = h));
  const cp = lease.checkpoint(r1);
  await tick();
  assert.ok(s, 'the short job borrows R1\'s slot');
  r2.release();
  await tick();
  assert.ok(r3, 'R3 gets the slot R2 freed before the short job ends');
  assert.deepEqual(lease.snapshot(), {active: ['S', 'R3'], queued: [], parked: ['R1']});
  s.release();
  assert.equal(await cp, 1);
  assert.deepEqual(lease.snapshot(), {active: ['R3', 'R1'], queued: []}, 'R1 resumes; capacity is never exceeded');
  await short; await third;
  r1.release(); r3.release();
  assert.deepEqual(lease.snapshot(), {active: [], queued: []});
});

test('checkpoint honors the holder\'s abort while lent: returns at once, the borrower keeps its slot (#143 review)', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('review');
  const short = lease.acquire('S', {lane: 'short'});
  let next;
  const queued = lease.acquire('review-B').then(h => (next = h));
  const ac = new AbortController();
  const cp = lease.checkpoint(review, 2, ac.signal);
  const s = await short;
  ac.abort(new Error('hard deadline'));
  assert.equal(await cp, 1, 'settles without waiting for the borrower');
  assert.deepEqual(lease.snapshot(), {active: ['S'], queued: ['review-B']}, 'the review\'s parked reservation is gone; the borrower stays active');
  review.release(); // the review's finally: a no-op now
  assert.deepEqual(lease.snapshot(), {active: ['S'], queued: ['review-B']});
  s.release();
  await tick();
  assert.ok(next, 'the queue advances after the borrower');
  await queued;
  next.release();
});

test('checkpoint with an already-aborted signal lends nothing', async () => {
  const lease = new LocalModelLease();
  const review = await lease.acquire('review');
  const short = lease.acquire('S', {lane: 'short'});
  const ac = new AbortController();
  ac.abort();
  assert.equal(await lease.checkpoint(review, 2, ac.signal), 0);
  assert.deepEqual(lease.snapshot(), {active: ['review'], queued: ['S']});
  review.release();
  (await short).release();
});
