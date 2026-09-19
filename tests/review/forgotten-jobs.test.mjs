import test from 'node:test';
import assert from 'node:assert/strict';
import { background, storage } from './helpers.mjs';

// clearStuckJobs retires jobs the server has forgotten (missing/unknown/cancelled) whose tabs are
// gone — the operator escape hatch for the "recovery" pile-up after a server restart. Candidates come
// from the cached serverStatus the popup shows as "missing", but each is RE-PROBED concurrently before
// being abandoned (a stale cached status can hide a job the bridge restored, whose saved outcome must
// not be discarded). The whole operation is raced against one deadline, so a stalled storage read,
// ping, or tab probe can never lose the popup's response ("Could not clear stuck jobs: unknown error").
const makeJob = (id, { tabId, serverStatus } = {}) => ({
  jobId: id, origin: 'http://bridge', leaseId: 'lease-' + id, prompt: 'review ' + id, serverStatus,
  providers: ['chatgpt'], states: { chatgpt: { started: true, runId: 'run-' + id, tabId } },
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
        return ['missing', 'unknown', 'cancelled'].includes(fresh) ? { ok: true, active: false, status: fresh } : { ok: true, active: true };
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
  const res = await b.context.clearStuckJobs(60);
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

test('clearStuckJobs returns when storage init stalls before the sweep (deadline covers setup)', { timeout: 5000 }, async () => {
  // settings()/workerJobs() read chrome.storage.local.get up front. The deadline is created before any
  // await, so a wedged initial read must still trip it and hand the popup a result — not hang before
  // the race even begins.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'missing' })]);
  b.local.get = () => new Promise(() => {}); // wedge the very first storage read
  const res = await b.context.clearStuckJobs(60);
  assert.equal(res.ok, true);
  assert.equal(res.timedOut, true, 'the deadline fired even though setup stalled');
});
