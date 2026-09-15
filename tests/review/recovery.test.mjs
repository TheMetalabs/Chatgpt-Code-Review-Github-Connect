import test from 'node:test';
import assert from 'node:assert/strict';
import { background, storage, raw } from './helpers.mjs';
const job = id => ({ jobId: id, provider: 'chatgpt', providers: ['chatgpt'], prompt: 'review ' + id, reasoning: { chatgpt: 'pro' } });
function server(jobs) {
  let queued = [...jobs];
  const received = [];
  return { received, api: async (path, body) => {
    if (!body) return { ok: true, prompt: 'review A' };
    if (body.action === 'take') return { ok: true, job: queued.shift() ?? null };
    received.push(body); return { ok: true };
  } };
}
test('worker restart recovers A before taking B and never submits A twice', async () => {
  const s = server([job('A'), job('B')]);
  let done = false;
  const handler = (_id, msg) => msg.type === 'ashlar-run' || !done ? { ok: false, code: 'busy' } : { ok: true, raw };
  const first = background({ api: s.api, handler });
  await first.tick();
  const second = background({ api: s.api, handler, local: first.local, session: first.session, tabs: first.tabs });
  await second.tick();
  assert.equal(second.calls.some(c => c.action === 'take'), false, 'B was taken while A was pending');
  done = true; await second.tick();
  assert.ok(s.received.some(c => c.action === 'complete' && c.jobId === 'A'));
  assert.equal(second.messages.some(m => m.type === 'ashlar-run'), false, 'A was resubmitted');
  await second.tick();
  assert.equal(second.messages.filter(m => m.type === 'ashlar-run' && m.jobId === 'B').length, 1);
});
test('terminal quota and closed tabs stop generating rather than looping forever', async () => {
  for (const outcome of ['quota', 'closed']) {
    const s = server([job('A')]); let done = false;
    const b = background({ api: s.api, handler: () => done ? { ok: false, code: 'quota', error: 'usage limit' } : { ok: false, code: 'busy' } });
    await b.tick(); done = true;
    if (outcome === 'closed') for (const id of [...b.tabs.keys()]) await b.closeTab(id);
    await b.tick(); await b.tick();
    assert.ok(s.received.some(c => c.action === 'failure' && c.jobId === 'A'), outcome);
    assert.equal(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 0);
    const pings = s.received.filter(c => c.action === 'ping' && c.jobId === 'A');
    assert.equal(pings.at(-1)?.generating.chatgpt, false);
  }
});
test('unacknowledged completion survives worker restart without a second model call', async () => {
  const s = server([job('A')]); let fail = true, done = false;
  const api = async (p, b) => { if (b?.action === 'complete' && fail) throw new Error('offline'); return s.api(p, b); };
  const handler = () => done ? { ok: true, raw } : { ok: false, code: 'busy' };
  const b = background({ api, handler }); await b.tick(); done = true; await b.tick();
  assert.ok(Object.keys(b.local.state.pendingReviewJobs ?? {}).length, 'lost undelivered raw');
  fail = false;
  const r = background({ api, handler, local: b.local, session: storage(), tabs: new Map() });
  await r.tick();
  assert.ok(s.received.some(c => c.action === 'complete' && c.results[0].raw === raw));
  assert.equal(r.messages.length, 0);
});
test('legacy session tab mappings are recovered before the next take', async () => {
  const s = server([job('B')]);
  const b = background({ api: s.api, handler: () => ({ ok: true, raw }),
    session: storage({ busy: true, jobId: 'A', tabs: { 'A:chatgpt': 10 }, generating: { chatgpt: true } }),
    local: storage({ origin: 'http://bridge', token: 'token', lastJobId: 'A' }),
    tabs: new Map([[10, { id: 10, url: 'https://chatgpt.com/c/a' }]]) });
  await b.tick();
  assert.ok(s.received.some(c => c.action === 'complete' && c.jobId === 'A'));
  assert.equal(b.calls.some(c => c.action === 'take'), false);
});
test('lost start acknowledgement retries the idempotent run, not observer-only resume', async () => {
  const s = server([job('A')]); let disconnected = true;
  const b = background({ api: s.api, handler: () => {
    if (disconnected) throw new Error('message delivery failed');
    return { ok: false, code: 'busy' };
  } });
  await b.tick(); disconnected = false; await b.tick();
  assert.equal(b.messages.filter(m => m.type === 'ashlar-run' && !m.resume).length, 2);
});
test('two provider outcomes stay independent across a restart', async () => {
  const s = server([{ ...job('A'), providers: ['chatgpt', 'grok'] }]);
  let ready = false;
  const b = background({ api: s.api, handler: (_id, msg) => {
    if (ready && msg.type === 'ashlar-harvest') return _id === 101 ? { ok: true, raw } : { ok: false, code: 'busy' };
    return { ok: false, code: 'busy' };
  } });
  await b.tick(); ready = true; await b.tick();
  assert.ok(s.received.some(c => c.action === 'ping' && c.generating?.chatgpt === false && c.generating?.grok === true));
  const r = background({ api: s.api, handler: () => ({ ok: false, code: 'empty', error: 'finished without JSON' }), local: b.local, session: b.session, tabs: b.tabs });
  await r.tick();
  assert.equal(s.received.filter(c => c.action === 'complete').length, 1);
  assert.ok(s.received.some(c => c.action === 'failure' && c.provider === 'grok'));
});
test('a confirmed cancellation retires state without touching the tab', async () => {
  const s = server([job('A')]); let cancelled = false;
  const api = (p, b) => { if (!b && cancelled) throw Object.assign(new Error('no prompt'), { status: 404 }); return s.api(p, b); };
  const b = background({ api }); await b.tick(); cancelled = true;
  const count = b.messages.length; await b.tick();
  assert.equal(b.messages.length, count);
  assert.equal(Object.keys(b.local.state.pendingReviewJobs).length, 0);
});
test('success is delivered before any generating=false heartbeat', async () => {
  const s = server([job('A')]); let ready = false, completed = false;
  const b = background({ api: async (p, body) => {
    if (body?.action === 'complete') completed = true;
    if (body?.action === 'ping' && body.generating?.chatgpt === false) {
      assert.equal(completed, true, 'watcher could skip the job before JSON arrived');
    }
    return s.api(p, body);
  }, handler: () => ready ? { ok: true, raw } : { ok: false, code: 'busy' } });
  await b.tick(); ready = true; await b.tick();
  assert.equal(completed, true);
  assert.equal(Object.keys(b.local.state.pendingReviewJobs).length, 0);
});
test('explicit terminal codes take precedence over busy words in error text', async () => {
  const s = server([job('A')]); let ready = false;
  const b = background({ api: s.api, handler: () => ready ? { ok: false, code: 'quota', error: 'busy service usage limit' } : { ok: false, code: 'busy' } });
  await b.tick(); ready = true; await b.tick();
  assert.ok(s.received.some(c => c.action === 'failure'));
});
