import test from 'node:test';
import assert from 'node:assert/strict';
import { background, storage } from './helpers.mjs';

// clearStuckJobs retires jobs the server has forgotten (missing/unknown/cancelled) whose tabs are
// gone — the operator escape hatch for the "recovery" pile-up after a server restart. It reads the
// serverStatus the heartbeat loop already established (exactly what the popup shows as "missing"),
// abandons concurrently, and never re-probes every job: a serial HTTP sweep over 20+ jobs is slow
// enough that the popup's message response is lost ("Could not clear stuck jobs: unknown error").
const makeJob = (id, { tabId, serverStatus } = {}) => ({
  jobId: id, origin: 'http://bridge', leaseId: 'lease-' + id, prompt: 'review ' + id, serverStatus,
  providers: ['chatgpt'], states: { chatgpt: { started: true, runId: 'run-' + id, tabId } },
});

function harness(jobs, tabs = new Map()) {
  return background({
    local: storage({ origin: 'http://bridge', token: 'token', pendingReviewJobs: Object.fromEntries(jobs.map((j) => [j.jobId, j])) }),
    tabs,
    handler: () => ({ ok: false, code: 'job_mismatch' }),
    api: async (_path, body) => (body?.action === 'claim' ? { ok: true, leaseId: 'lease-x' } : { ok: true }),
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

test('clearStuckJobs returns (does not rejoin the stalled queue) when the sweep times out', { timeout: 5000 }, async () => {
  // Wedge the storage write the sweep performs: saveJobs' chrome.storage.local.set never resolves, so
  // the abandon hangs and the 60ms deadline fires. That wedged write still owns the global storageTail,
  // so awaiting recordWorkerStatus (which queues its own writeInOrder behind that tail) would hang the
  // popup response — the exact lost-response failure. clearStuckJobs must skip it after a timeout.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'missing' })]);
  const realSet = b.local.set;
  b.local.set = () => new Promise(() => {});
  const res = await b.context.clearStuckJobs(60);
  b.local.set = realSet;
  assert.equal(res.ok, true, 'the popup still gets a definite result');
  assert.equal(res.timedOut, true, 'the wedged write tripped the deadline');
  assert.equal(res.cleared, 0);
});
