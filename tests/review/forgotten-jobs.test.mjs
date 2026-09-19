import test from 'node:test';
import assert from 'node:assert/strict';
import { background, storage } from './helpers.mjs';

// The bridge job registry is in-memory only. A pm2 restart wipes it, so every job the
// extension still tracks then reports status "missing". Such work is deliberately NOT
// auto-discarded (a worker restart may re-bind its tab), which is why it can pile up in
// recovery/cleanup with no way to clear it. "Clear stuck jobs" (clearStuckJobs) is the
// operator escape hatch: it retires ONLY jobs the server has forgotten/cancelled whose
// tabs are truly gone, and never touches a live tab or a job the server still owns.
const makeJob = (id, tabId) => ({
  jobId: id, origin: 'http://bridge', leaseId: 'lease-' + id, prompt: 'review ' + id,
  providers: ['chatgpt'], states: { chatgpt: { started: true, runId: 'run-' + id, tabId } },
});

function harness({ tabs = new Map(), status = 'missing', active = false } = {}) {
  return background({
    local: storage({ origin: 'http://bridge', token: 'token', pendingReviewJobs: { A: makeJob('A', 10) } }),
    tabs,
    handler: () => ({ ok: false, code: 'job_mismatch' }),
    api: async (_path, body) => {
      if (!body) return { ok: true };
      if (body.action === 'ping') return body.jobId ? { ok: true, active, status } : { ok: true, bridge: {} };
      if (body.action === 'claim') return { ok: true, leaseId: 'lease-A' };
      return { ok: true };
    },
  });
}

test('clearStuckJobs retires a forgotten job whose tab is gone', async () => {
  const b = harness({ tabs: new Map() }); // tab 10 absent (closed)
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true); assert.equal(res.cleared, 1); assert.equal(res.kept, 0);
  assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 0, 'forgotten + gone-tab job is cleared');
});

test('clearStuckJobs KEEPS a forgotten job whose tab is still open', async () => {
  const b = harness({ tabs: new Map([[10, { id: 10, url: 'https://chatgpt.com/c/A', status: 'complete' }]]) });
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true); assert.equal(res.cleared, 0); assert.equal(res.kept, 1);
  assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 1, 'an open tab (possible unharvested answer) is preserved');
  assert.ok(b.tabs.has(10), 'the review tab is left open');
});

test('clearStuckJobs never touches a job the server still owns', async () => {
  const b = harness({ tabs: new Map(), status: 'awaiting_chat', active: true });
  const res = await b.context.clearStuckJobs();
  assert.equal(res.ok, true); assert.equal(res.cleared, 0); assert.equal(res.kept, 1);
  assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 1, 'a server-owned job is preserved');
});
