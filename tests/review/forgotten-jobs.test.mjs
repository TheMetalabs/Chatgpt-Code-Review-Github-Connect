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

test('clearStuckJobs isolates a failing job and still reports a result', async () => {
  // A job whose cleanup throws must not abort the sweep or drop the popup response.
  const b = harness([makeJob('A', { tabId: 10, serverStatus: 'missing' }), makeJob('B', { tabId: 11, serverStatus: 'missing' })]);
  const realRemove = b.chrome.tabs.remove;
  b.chrome.tabs.remove = async () => { throw new Error('tab dragging'); };
  const res = await b.context.clearStuckJobs();
  b.chrome.tabs.remove = realRemove;
  assert.equal(res.ok, true, 'sweep still returns a result despite a per-job failure');
  assert.equal(typeof res.cleared, 'number');
});
