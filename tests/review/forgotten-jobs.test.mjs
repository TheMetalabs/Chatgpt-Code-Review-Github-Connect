import test from 'node:test';
import assert from 'node:assert/strict';
import { background, storage } from './helpers.mjs';

// clearStuckJobs retires jobs the server has forgotten (missing/unknown/cancelled) whose tabs are
// gone — the operator escape hatch for the "recovery" pile-up after a server restart. Candidates come
// from the cached serverStatus the popup shows as "missing", but each is RE-PROBED concurrently before
// being abandoned (a stale cached status can hide a job the bridge restored, whose saved outcome must
// not be discarded). The whole operation is raced against one deadline, so a stalled storage read,
// ping, or tab probe can never lose the popup's response ("Could not clear stuck jobs: unknown error").
const makeJob = (id, { tabId, serverStatus, lastEventAt } = {}) => ({
  jobId: id, origin: 'http://bridge', leaseId: 'lease-' + id, prompt: 'review ' + id, serverStatus,
  providers: ['chatgpt'],
  states: { chatgpt: { started: true, runId: 'run-' + id, tabId,
    // lastEventAt drives the "stalled" signal (jobStale reads the latest worker/page event). Omitting it
    // means NO events — a brand-new/allocating job, which must never be swept as stalled.
    ...(lastEventAt ? { workerEvents: [{ source: 'worker', sequence: 1, stage: 'submitted', at: lastEventAt }] } : {}) } },
});

function harness(jobs, tabs = new Map(), serverStates = {}) {
  return background({
    local: storage({ origin: 'http://bridge', token: 'token', pendingReviewJobs: Object.fromEntries(jobs.map((j) => [j.jobId, j])) }),
    tabs,
    handler: () => ({ ok: false, code: 'job_mismatch' }),
    api: async (_path, body) => {
      if (body?.action === 'claim') return { ok: true, leaseId: 'lease-x' };
      if (body?.action === 'ping') {
        // The server's FRESH verdict for this job on the re-probe. Default: still forgotten with its
        // cached status (what clearStuckJobs re-confirms before abandoning). Override via serverStates
        // to simulate a job the bridge restored (active) between the cached heartbeat and the sweep.
        const fresh = serverStates[body.jobId] ?? jobs.find((j) => j.jobId === body.jobId)?.serverStatus;
        // The server reports active only for a genuinely-active (awaiting_chat) job; every other status —
        // missing/unknown (forgotten) AND tracked non-active ones (validator/posting/…) — comes back
        // active:false with the status, which refreshJobHeartbeat stores in job.serverStatus.
        return fresh && fresh !== 'active' ? { ok: true, active: false, status: fresh } : { ok: true, active: true };
      }
      return { ok: true };
    },
  });
}

test('clearStuckJobs retires forgotten jobs whose tabs are gone (concurrently; always responds)', async () => {
  // Tabs 10/11/12 are absent; server already reported these forgotten.
  const b = harness([
    makeJob('A', { tabId: 10, serverStatus: 'missing' }),
    makeJob('B', { tabId: 11, serverStatus: 'missing' }),
    makeJob('C', { tabId: 12, serverStatus: 'unknown' }),
  ]);
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 3);
  assert.equal(res.kept, 0);
  assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 0);
});

test('clearStuckJobs KEEPS a forgotten job whose tab is still open', async () => {
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'missing' })], new Map([[10, { id: 10, url: 'https://chatgpt.com/c/A', status: 'complete' }]]));
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0);
  assert.equal(res.kept, 1);
  assert.ok(b.tabs.has(10), 'an open tab (possible unharvested answer) is preserved');
});

test('clearStuckJobs never touches a job the server still owns', async () => {
  // Server-owned (awaiting_chat) — not a forgotten verdict — is kept even with its tab absent.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat' })]);
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0);
  assert.equal(res.kept, 1);
  assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 1);
});

test('clearStuckJobs isolates a failing job and still clears the healthy ones', async () => {
  // Inject a real rejection on a path clearStuckJobs actually executes for one target: retiring B
  // removes its own "ashlar:job:B" key, so failing that storage remove rejects B's abandon only.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'missing' }), makeJob('B', { tabId: 11, serverStatus: 'missing' })]);
  const realRemove = b.local.remove;
  b.local.remove = async (keys) => {
    if ([].concat(keys).some((k) => String(k).includes('ashlar:job:B'))) throw new Error('storage failure retiring B');
    return realRemove(keys);
  };
  const res = await b.context.clearStuckJobs();
  b.local.remove = realRemove;
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 1, 'the healthy job (A) is still cleared even though B fails at storage');
});

test('clearStuckJobs returns when the sweep stalls (deadline backstop)', { timeout: 5000 }, async () => {
  // Wedge the storage write the sweep performs: saveJobs' chrome.storage.local.set never resolves, so
  // the abandon hangs. The 60ms deadline must still resolve the race and hand the popup a definite
  // result instead of hanging on the wedged sweep.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'missing' })]);
  const realSet = b.local.set;
  b.local.set = () => new Promise(() => {});
  const res = await b.context.clearStuckJobs({ deadlineMs: 60 });
  b.local.set = realSet;
  assert.equal(res.ok, true, 'the popup still gets a definite result');
  assert.equal(res.timedOut, true, 'the wedged write tripped the deadline');
  assert.equal(res.cleared, 0);
});

test('clearStuckJobs returns even when the post-sweep status refresh stalls (no-target path)', { timeout: 5000 }, async () => {
  // No forgotten targets → the sweep settles instantly and the deadline never fires, so the only
  // unbounded wait left is recordWorkerStatus's FRESH status write. Wedging just that write must not
  // strand the popup response: the refresh is detached (fire-and-forget), never awaited.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat' })]); // server-owned, not a target
  const realSet = b.local.set;
  b.local.set = (items) => ('bridgeWorkerStatus' in (items || {}) ? new Promise(() => {}) : realSet(items));
  const res = await b.context.clearStuckJobs();
  b.local.set = realSet;
  assert.equal(res.ok, true, 'the popup gets a result even though the status refresh is wedged');
  assert.equal(res.cleared, 0);
  assert.equal(res.kept, 1);
});

test('clearStuckJobs re-probes and KEEPS a job the bridge restored since the last heartbeat', async () => {
  // Cached status says missing, but a fresh ping shows the server owns the job again (active). Retiring
  // on the stale status would mark its saved outcome delivered and delete it; the re-probe must keep the
  // job so the normal recovery flow delivers the cached result. (recovery-boundaries.test.mjs covers the
  // missing→active→deliver path itself.)
  const b = harness(
    [makeJob('A', { tabId: 10, serverStatus: 'missing' })], // tab 10 gone (no entry in the tabs map)
    new Map(),
    { A: 'active' }, // the bridge restored A between the cached heartbeat and this sweep
  );
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0, 'a restored job is not abandoned (its outcome is not discarded)');
  assert.equal(res.kept, 1);
  assert.ok('A' in (b.local.state.pendingReviewJobs ?? {}), 'the restored job is preserved');
});

test('clearStuckJobs KEEPS a job the server advanced to a tracked non-active status (validator)', async () => {
  // Cached missing, but the bridge restored the job and it is now in validator. The fresh ping returns
  // active:false with status:validator — the server STILL tracks it. Keying off the active:false boolean
  // alone would delete its outbox; the sweep must re-check the status string and keep it.
  const b = harness(
    [makeJob('A', { tabId: 10, serverStatus: 'missing' })], // tab gone
    new Map(),
    { A: 'validator' },
  );
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0, 'a job the server still tracks (validator) is not abandoned');
  assert.equal(res.kept, 1);
  assert.ok('A' in (b.local.state.pendingReviewJobs ?? {}), 'the still-tracked job is preserved');
});

test('clearStuckJobs returns when storage init stalls before the sweep (deadline covers setup)', { timeout: 5000 }, async () => {
  // settings()/workerJobs() read chrome.storage.local.get up front. The deadline is created before any
  // await, so a wedged initial read must still trip it and hand the popup a result — not hang before
  // the race even begins.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'missing' })]);
  b.local.get = () => new Promise(() => {}); // wedge the very first storage read
  const res = await b.context.clearStuckJobs({ deadlineMs: 60 });
  assert.equal(res.ok, true);
  assert.equal(res.timedOut, true, 'the deadline fired even though setup stalled');
});

const traceHarness = () => background({
  local: storage({ origin: 'http://bridge', token: 'token' }),
  api: async (_p, body) => (body?.action === 'progress' ? new Promise(() => {}) : { ok: true }), // wedge the trace upload
});
const cleanTraceJob = (serverStatus, tabId) => ({
  jobId: 'J', origin: 'http://bridge', leaseId: 'l', providers: ['chatgpt'], serverStatus,
  states: { chatgpt: { delivered: true, cleanupDone: true, tabId, started: true, runId: 'r', workerEvents: [{ stage: 'result_saved', at: 1 }] } },
});

test('retireCleanJob detaches only when told forgotten, never from a stale serverStatus', { timeout: 5000 }, async () => {
  // The final flushProgress is the only durable upload of terminal events (result_saved/tab_closed).
  // Detachment must come from a FRESH confirmed-forgotten flag (the clear sweep), NOT job.serverStatus:
  // advanceJob retires on its early return before its next heartbeat, so a cached "missing" can be stale
  // for a job the bridge already restored — awaiting there keeps that live job's history durable.
  const b = traceHarness();
  const jf = { J: cleanTraceJob('missing') }; // confirmed forgotten (flag) → detached: retires despite the hung upload
  assert.equal(await b.context.retireCleanJob(jf.J, jf, true), true);
  assert.equal('J' in jf, false, 'a confirmed-forgotten job retires without waiting on the (doomed) trace');
  const js = { J: cleanTraceJob('missing') }; // DEFAULT path with a stale cached "missing" → must still await
  const race = await Promise.race([
    b.context.retireCleanJob(js.J, js).then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 100)),
  ]);
  assert.equal(race, 'pending', 'the default (advanceJob) path awaits even when serverStatus is a stale missing');
  assert.ok('J' in js, 'the possibly-restored job is not deleted until its trace uploads');
});

test('abandonForgottenJob detaches a missing job but awaits a cancelled one (sweep derivation)', { timeout: 5000 }, async () => {
  // The sweep passes the fresh status; abandonForgottenJob detaches only missing/unknown (server evicted
  // → upload doomed) and AWAITS cancelled (lease retained → recordBridgeProgress still records it).
  const b = traceHarness();
  const jm = { J: cleanTraceJob('missing', 99) }; // tab 99 absent → leg is gone
  assert.equal(await b.context.abandonForgottenJob(jm.J, jm, 'missing'), true);
  assert.equal('J' in jm, false, 'a missing job retires without waiting on the (rejected) trace');
  const jc = { J: cleanTraceJob('cancelled', 99) };
  const race = await Promise.race([
    b.context.abandonForgottenJob(jc.J, jc, 'cancelled').then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 100)),
  ]);
  assert.equal(race, 'pending', 'a swept cancelled job awaits its trace upload before retiring');
  assert.ok('J' in jc, 'the cancelled job is not deleted until its trace uploads');
});

const STALE = Date.now() - 20 * 60_000; // older than STALL_MS (15min)
const FRESH = Date.now();

test('clearStuckJobs({includeStalled}) retires a stalled, tab-gone job the server still tracks', async () => {
  // Not forgotten (awaiting_chat), but progressed then went quiet past the stall window and its tab is
  // gone → it can never finish. The periodic/auto sweep retires it; the manual button does too.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat', lastEventAt: STALE })]); // tab gone
  const res = await b.context.clearStuckJobs({ includeStalled: true });
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 1, 'a stalled tab-gone job is retired');
  assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 0);
});

test('clearStuckJobs({includeStalled}) KEEPS a stalled job whose tab is still open', async () => {
  // A live tab may still hold an unharvested answer — never discard it, even when stale.
  const b = harness(
    [makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat', lastEventAt: STALE })],
    new Map([[10, { id: 10, url: 'https://chatgpt.com/c/A', status: 'complete' }]]),
  );
  const res = await b.context.clearStuckJobs({ includeStalled: true });
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0, 'a stall with a live tab is preserved');
  assert.equal(res.kept, 1);
  assert.ok(b.tabs.has(10));
});

test('clearStuckJobs({includeStalled}) never sweeps a brand-new (no-event) or recently-active job', async () => {
  // The stall signal keys off an OLD event, never the ABSENCE of events, so an allocating job (no events)
  // and a job that just progressed are both kept — periodic cleanup can't race admission or live work.
  const b = harness([
    makeJob('A', { tabId: 10 }), // no events → brand-new/allocating, tab gone
    makeJob('B', { tabId: 11, serverStatus: 'awaiting_chat', lastEventAt: FRESH }), // just progressed, tab gone
  ]);
  const res = await b.context.clearStuckJobs({ includeStalled: true });
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0, 'neither a new nor a freshly-active job is swept');
  assert.equal(res.kept, 2);
});

test('clearStuckJobs default (button off / includeStalled=false) ignores stalled jobs', async () => {
  // The forgotten-only default is preserved: without includeStalled a stalled tab-gone job is not touched.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat', lastEventAt: STALE })]);
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0, 'stalled jobs are only swept when includeStalled is set');
  assert.equal(res.kept, 1);
});

test('clearStuckJobs({includeStalled}) REPORTS a terminal failure so the server settles a stalled leg', async () => {
  // A stalled tab-gone job the server STILL owns (awaiting_chat) must not be silently deleted: the server
  // ignores a bare generating:false and would re-offer the leg after the lease expires, re-sticking it.
  // The sweep must send action:"failure" so the server settles the leg, then retire on the ACK.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat', lastEventAt: STALE })]); // tab gone
  const res = await b.context.clearStuckJobs({ includeStalled: true });
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 1);
  assert.ok(b.calls.some((c) => c.action === 'failure' && c.jobId === 'A'), 'a terminal failure was reported to the server');
  assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 0, 'retired only after the server ACKed the failure');
});

test('clearStuckJobs({includeStalled}) RETAINS a stalled job when the failure report is rejected', async () => {
  // If the server does not ACK the failure (unreachable/404), the leg is not settled, so the job must be
  // RETAINED for a later sweep — never a silent local delete that leaves the server re-offering it.
  const b = background({
    local: storage({ origin: 'http://bridge', token: 'token',
      pendingReviewJobs: { A: makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat', lastEventAt: STALE }) } }),
    tabs: new Map(), // tab gone
    handler: () => ({ ok: false, code: 'job_mismatch' }),
    api: async (_p, body) => { if (body?.action === 'failure') throw new Error('server unreachable'); return { ok: true }; },
  });
  const res = await b.context.clearStuckJobs({ includeStalled: true });
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 0, 'not retired while the server has not settled the leg');
  assert.ok('A' in (b.local.state.pendingReviewJobs ?? {}), 'the job is retained for a later sweep');
});

test('clearStuckJobs({includeStalled}) never fabricates a failure for an unstarted sibling leg', async () => {
  // A 2-provider job goes stale because chatgpt stalled (old event, tab gone), but grok is still WAITING
  // for capacity (not started, no tabId). providerTabGone reports the unstarted leg "gone", but failing it
  // would tell the server that reviewer ran and let it publish without it — so only the started, tab-gone
  // leg is failed; the unstarted sibling is preserved and the job is kept until grok can run.
  const job = {
    jobId: 'A', origin: 'http://bridge', leaseId: 'lease-A', prompt: 'review A', serverStatus: 'awaiting_chat',
    providers: ['chatgpt', 'grok'],
    states: {
      chatgpt: { started: true, runId: 'run-A-c', tabId: 10, workerEvents: [{ source: 'worker', sequence: 1, stage: 'submitted', at: STALE }] },
      grok: { started: false }, // waiting for capacity — no tabId, never started
    },
  };
  const b = harness([job]); // tab 10 gone (empty tabs map)
  const res = await b.context.clearStuckJobs({ includeStalled: true });
  assert.equal(res.ok, true);
  assert.deepEqual(b.calls.filter((c) => c.action === 'failure').map((c) => c.provider).sort(), ['chatgpt'], 'only the started, tab-gone leg is failed');
  const kept = b.local.state.pendingReviewJobs ?? {};
  assert.ok('A' in kept, 'the job is kept while grok still waits for capacity');
  assert.equal(kept.A.states.grok.outcome, undefined, 'the unstarted grok leg gets no fabricated failure');
});

test('clearStuckJobs({includeStalled}) never fails a leg whose source is durably archived (repair in flight)', async () => {
  // cleanupProvider closes a durable-source leg's tab ON PURPOSE while the server-side JSON repair runs
  // (arbitrarily long, no fresh events). Its tab-absence + quiet is expected, not a stall — a fabricated
  // tab_closed failure would cancel a valid repair and drop that provider's review.
  const job = makeJob('A', { tabId: 10, serverStatus: 'awaiting_chat', lastEventAt: STALE });
  job.states.chatgpt.sourceCapture = { archiveDurable: true }; // durable source → owned by the repair pipeline
  const b = harness([job]); // tab 10 gone
  const res = await b.context.clearStuckJobs({ includeStalled: true });
  assert.equal(res.ok, true);
  // The sweep must not even FABRICATE an outcome on the leg (deliverOutcome separately guards the send,
  // but a stamped tab_closed outcome would still corrupt the leg the repair pipeline owns).
  assert.equal(b.local.state.pendingReviewJobs?.A?.states.chatgpt.outcome, undefined, 'no fabricated outcome on the durable-source leg');
  assert.equal(b.calls.filter((c) => c.action === 'failure').length, 0, 'no tab_closed failure is sent for a durable-source leg');
  assert.ok('A' in (b.local.state.pendingReviewJobs ?? {}), 'the repairing job is kept for the repair pipeline to finish');
});
