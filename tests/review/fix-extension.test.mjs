// Extension handling of review-loop FIX items: the page runner harvests plain text (no review
// JSON), the worker delivers it via complete, skips every review-JSON lane, and force-closes a
// cancelled fix tab only with positive page ownership. Review behavior is asserted unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {content, background, storage, flush} from './helpers.mjs';

const PARTS = ['I guarded the null path.', '{"summary":"guard","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}'];
// A fix is read from the answer's fenced code only (literal text; see assistantCodeBlocks).
const ANSWER = PARTS[1];
const URL_FIX = 'https://chatgpt.com/c/fix';
const run = (extra = {}) => ({type: 'ashlar-run', jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', kind: 'fix', prompt: 'FIX PROMPT', ...extra});
const msg = (type, extra = {}) => ({type, jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', kind: 'fix', ...extra});

/** Page runner over a completed answer; a polling guard turns "pending forever" into an error. */
function page({parts = PARTS, blocks = [PARTS[1]], limit = 50} = {}) {
  const c = content('chatgpt');
  let polls = 0;
  Object.assign(c.context, {
    stopButtonVisible: () => false, replyDoneVisible: () => true, assistantCorpus: () => parts, assistantCodeBlocks: () => blocks,
    sleep: async () => { if (++polls > limit) throw new Error('test-only polling guard'); await new Promise(resolve => setImmediate(resolve)); },
  });
  return {c, polls: () => polls, state: () => c.context.__ashlarRunnerState};
}
async function settled(c) {
  for (let i = 0; i < 200 && c.context.__ashlarRunnerState.running; i++) await flush();
}

test('page: a fix collector returns the fenced code after two stable completed observations', async () => {
  const p = page();
  Object.assign(p.state(), {kind: 'fix', running: true, jobId: 'fix-A', runId: 'run-A'});
  assert.equal(await p.c.context.waitUntilReviewOrQuota('ChatGPT'), ANSWER);
  assert.equal(p.polls(), 1, 'second identical observation completes it');
  assert.equal(p.state().responseText, ANSWER);
  assert.equal(p.state().observation.text, '', 'the answer text is never copied into an observation');
});

test('page: the same non-review answer keeps a REVIEW collector waiting (the fix path is kind-gated)', async () => {
  const p = page({limit: 12});
  await assert.rejects(p.c.context.waitUntilReviewOrQuota('ChatGPT'), /test-only polling guard/);
});

test('page: a fix collector waits through generation and empty completed turns, never returning empty', async () => {
  const p = page({limit: 40});
  Object.assign(p.c.context, {
    stopButtonVisible: () => p.polls() < 5, replyDoneVisible: () => p.polls() >= 5,
    assistantCorpus: () => (p.polls() < 10 ? [] : ['final fix answer']),
    assistantCodeBlocks: () => (p.polls() < 10 ? [] : ['final fix answer']),
  });
  assert.equal(await p.c.context.waitUntilFixOrQuota('ChatGPT'), 'final fix answer');
  assert.equal(p.polls(), 11);
});

test('page: an answer with no fenced block harvests a fixed no-JSON line (the server fails closed)', async () => {
  const p = page({blocks: []}); // the JSON is only in rendered prose, where markdown may have rewritten it
  const out = await p.c.context.waitUntilFixOrQuota('ChatGPT');
  assert.match(out, /no fenced code block/);
  assert.ok(!out.includes('{'), 'no JSON object for the fix parser to read');
});

test('page: assistantCodeBlocks reads the literal code text, not the rendered block chrome', () => {
  const c = content('chatgpt'); // the real helper, not page()'s stub
  const code = {textContent: '{"files":[{"path":"a.ts","content":"a\\\\nb *x* __init__"}]}'};
  const pre = {querySelector: sel => (sel === 'code' ? code : null), textContent: `jsonCopy code${code.textContent}`};
  const bare = {querySelector: () => null, textContent: 'plain pre'};
  const turn = {matches: () => true, querySelectorAll: sel => (sel === 'pre' ? [pre, bare, {querySelector: () => null, textContent: '  '}] : [])};
  assert.deepEqual([...c.context.assistantCodeBlocks(turn)], [code.textContent, 'plain pre']);
  assert.deepEqual([...c.context.assistantCodeBlocks(null)], []);
});

test('page: a visible quota notice ends a fix only before an answer is visible', async () => {
  const p = page();
  Object.assign(p.c.context, {quotaHit: () => true, stopButtonVisible: () => true, replyDoneVisible: () => false});
  await assert.rejects(p.c.context.waitUntilFixOrQuota('ChatGPT'), error => error.code === 'quota');
  const done = page();done.c.context.quotaHit = () => true;
  assert.equal(await done.c.context.waitUntilFixOrQuota('ChatGPT'), ANSWER);
});

test('page: a kind:fix run is routed to the fix collector and harvested as its plain text', async () => {
  const p = page();
  p.c.context.runPrompt = async () => p.c.context.waitUntilReviewOrQuota('ChatGPT');
  assert.equal(p.c.message(run()).code, 'busy');
  await settled(p.c);
  const out = p.c.message(msg('ashlar-harvest'));
  assert.equal(out.ok, true);assert.equal(out.raw, ANSWER);assert.equal(out.responseText, ANSWER);
  assert.equal(p.state().kind, 'fix');
  // A review run message (no kind) never inherits the fix path.
  const review = page({limit: 12});
  review.c.context.runPrompt = async () => review.c.context.waitUntilReviewOrQuota('ChatGPT');
  review.c.message(run({jobId: 'job-A', kind: undefined}));
  assert.equal(review.state().kind, undefined);
  await settled(review.c);
  assert.equal(review.c.message(msg('ashlar-harvest', {jobId: 'job-A', kind: undefined})).ok, false);
});

test('page: ashlar-fix-cancel needs a positive binding, reports ownership and stops the collector', async () => {
  const p = page({limit: 500});
  Object.assign(p.c.context, {stopButtonVisible: () => true, replyDoneVisible: () => false, savedSubmission: () => null});
  assert.equal(p.c.message(msg('ashlar-fix-cancel')).code, 'job_mismatch', 'an unbound page is never Ashlar-owned');
  p.c.context.runPrompt = async () => p.c.context.waitUntilReviewOrQuota('ChatGPT');
  p.c.message(run());
  await flush();
  assert.equal(p.c.message(msg('ashlar-fix-cancel', {jobId: 'fix-B'})).code, 'job_mismatch');
  assert.equal(p.c.message(msg('ashlar-fix-cancel', {runId: 'run-B'})).code, 'job_mismatch');
  const out = p.c.message(msg('ashlar-fix-cancel'));
  assert.equal(out.ok, true);assert.equal(out.owned, true, 'nothing sent yet and no user turn: only Ashlar work in the tab');
  assert.equal(p.c.message({type: 'ashlar-tab-status'}).released, false, 'an owned tab keeps its managed slot until closed');
  await settled(p.c);
  assert.equal(p.c.message(msg('ashlar-harvest')).code, 'cancelled');
  p.state().tabRepurposed = true;
  assert.equal(p.c.message(msg('ashlar-fix-cancel')).owned, false, 'a tab the user took over is never owned');
  assert.equal(p.c.message({type: 'ashlar-tab-status'}).released, true, 'the preserved tab frees its slot (not counted against capacity)');
});

test('page: an undispatched fix tab (never bound) answers for itself only when the worker says so', async () => {
  const p = page();
  assert.equal(p.c.message(msg('ashlar-fix-cancel')).code, 'job_mismatch', 'unbound, no claim: never Ashlar-owned');
  const out = p.c.message(msg('ashlar-fix-cancel', {undispatched: true}));
  assert.equal(out.ok, true);assert.equal(out.owned, true, 'a blank chat page with no turn or draft');
  assert.ok(!out.jobId && !out.runId, 'the reply carries no binding');
});

test('page: fix-cancel ownership is "unknown" when it cannot be established yet; only takeover or preserve frees the slot', async () => {
  const p = page({limit: 500});
  Object.assign(p.c.context, {stopButtonVisible: () => true, replyDoneVisible: () => false, savedSubmission: () => null});
  p.c.context.runPrompt = async () => p.c.context.waitUntilReviewOrQuota('ChatGPT');
  p.c.message(run());
  await flush();
  const status = () => p.c.message({type: 'ashlar-tab-status'}).released;
  // the journal is unreadable
  p.c.context.savedSubmission = () => { throw new Error('storage unavailable'); };
  let out = p.c.message(msg('ashlar-fix-cancel'));
  assert.equal(out.ownership, 'unknown');assert.equal(out.owned, false);assert.equal(status(), false, 'unknown never frees the slot');
  // sent, but the bound turn is not rendered yet (reload / hydration)
  Object.assign(p.c.context, {savedSubmission: () => ({phase: 'sent', expected: 'FIX PROMPT'}), boundReviewResponse: () => ({identified: false, followup: false})});
  out = p.c.message(msg('ashlar-fix-cancel'));
  assert.equal(out.ownership, 'unknown');assert.equal(status(), false);
  // the worker gives up identifying it: preserve frees the slot
  out = p.c.message(msg('ashlar-fix-cancel', {preserve: true}));
  assert.equal(out.owned, false);assert.equal(status(), true);
  await settled(p.c);
});

// ── worker ──────────────────────────────────────────────────────────────────
function fixJob(patch = {}) {
  return {jobId: 'fix-A', kind: 'fix', origin: 'http://bridge', leaseId: 'lease-A', prompt: 'FIX PROMPT', providers: ['chatgpt'],
    reasoning: {chatgpt: 'pro', grok: 'heavy'}, states: {chatgpt: {tabId: 10, started: true, runId: 'run-A'}}, ...patch};
}
function worker(jobs, {api, handler, url = URL_FIX, status = 'complete'}) {
  const tabs = new Map([[10, {id: 10, url, status}]]);
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: Object.fromEntries(jobs.map(j => [j.jobId, j]))}), tabs, api, handler});
  b.context.crypto = webcrypto;b.context.TextEncoder = TextEncoder;
  return b;
}
const active = async (_path, body) => body?.action === 'ping'
  ? {ok: true, active: true, accepted: true, status: 'awaiting_chat', bridge: {captureProtocol: 1, localJsonRepairEnabled: true}} : {ok: true, job: null};
const cancelled = async () => ({ok: true, active: false, status: 'cancelled', accepted: false});
const REVIEW_LANES = ['observe', 'capture', 'capture-read', 'repair', 'repair-status', 'repair-commit'];

test('worker: a completed fix answer is delivered as plain text by complete, then its tab closes', async () => {
  const b = worker([fixJob()], {api: active,
    handler: (_id, m) => m.type === 'ashlar-can-close' ? {ok: true, canClose: true, url: URL_FIX} : {ok: true, raw: ANSWER, responseText: ANSWER}});
  await b.tick();
  const complete = b.calls.find(c => c.action === 'complete');
  assert.equal(complete.jobId, 'fix-A');assert.equal(complete.leaseId, 'lease-A');
  assert.equal(complete.raw, ANSWER);assert.equal(complete.results[0].originalText, ANSWER);
  assert.deepEqual(b.closedTabs, [10]);assert.deepEqual(b.local.state.pendingReviewJobs, {});
  const jobMessages = b.messages.filter(m => m.jobId); // ashlar-tab-status inventory probes carry no job
  assert.ok(jobMessages.length && jobMessages.every(m => m.kind === 'fix'), 'every job message carries the fix kind');
  assert.equal(b.calls.some(c => REVIEW_LANES.includes(c.action)), false);
});

test('worker: fix items skip observation/capture/repair lanes; the same page state still archives for a review', async () => {
  const observation = {state: 'response_completed_json_invalid', text: 'not review json', totalChars: 15, truncated: false};
  const handler = () => ({ok: false, code: 'busy', retry: true, observation});
  const fix = worker([fixJob()], {api: active, handler});
  await fix.tick();for (let i = 0; i < 20; i++) await flush();
  assert.equal(fix.calls.some(c => REVIEW_LANES.includes(c.action)), false);
  const review = worker([fixJob({jobId: 'job-A', kind: undefined})], {api: active, handler});
  await review.tick();for (let i = 0; i < 20; i++) await flush();
  assert.ok(review.calls.some(c => c.action === 'observe'), 'sanity: this state does archive for a review');
  assert.ok(review.messages.some(m => m.jobId) && review.messages.every(m => !('kind' in m)), 'review tab messages are unchanged (no kind field)');
});

test('worker: a cancelled fix is force-closed via ashlar-fix-cancel even while its answer is pending', async () => {
  const handler = (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, url: URL_FIX} : {ok: true, canClose: false, reason: 'pending'};
  const b = worker([fixJob()], {api: cancelled, handler});
  await b.tick();
  assert.deepEqual(b.closedTabs, [10]);assert.deepEqual(b.local.state.pendingReviewJobs, {});
  assert.ok(b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.jobId === 'fix-A' && m.runId === 'run-A'));
  assert.equal(b.calls.some(c => c.action === 'complete' || c.action === 'failure'), false);
  // A cancelled REVIEW with the same pending page keeps its tab (no deadline, no forced close).
  const review = worker([fixJob({jobId: 'job-A', kind: undefined})], {api: cancelled, handler});
  await review.tick();
  assert.equal(review.closedTabs.length, 0);assert.ok(review.local.state.pendingReviewJobs['job-A']);
  assert.equal(review.messages.some(m => m.type === 'ashlar-fix-cancel'), false);
});

test('worker: an unknown ownership is asked again, then the tab is preserved (slot freed) after the wait', async () => {
  const b = worker([fixJob()], {api: cancelled, handler: (_id, m) => (m.type === 'ashlar-fix-cancel' ? {ok: true, owned: false, ownership: 'unknown', url: URL_FIX} : {ok: true})});
  await b.tick();
  assert.equal(b.closedTabs.length, 0);
  const pending = b.local.state.pendingReviewJobs['fix-A'];
  assert.ok(pending, 'not retired while ownership is unknown');
  assert.equal(typeof pending.states.chatgpt.ownershipUnknownAt, 'number');
  assert.equal(b.messages.some(m => m.preserve), false);
  const RealDate = b.context.Date || Date;
  const later = RealDate.now() + 3 * 60_000; // the wait has passed
  b.context.Date = class extends RealDate { static now() { return later; } };
  await b.tick();
  assert.equal(b.closedTabs.length, 0, 'never closed on a guess');assert.ok(b.tabs.has(10));
  assert.ok(b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true), 'the page is told to free its slot');
  assert.deepEqual(b.local.state.pendingReviewJobs, {});
});

test('worker: a cancelled fix whose run was never sent closes its blank tab and retires', async () => {
  const OPENED = 'https://chatgpt.com/?temporary-chat=true'; // providerUrl: the page a fix tab opens on
  const blank = (url) => (_id, m) => (m.type === 'ashlar-fix-cancel' && m.undispatched ? {ok: true, owned: true, ownership: 'owned', url, jobId: '', runId: '', provider: 'chatgpt'} : {ok: false, code: 'job_mismatch', jobId: '', runId: '', provider: 'chatgpt'});
  const unsent = () => [fixJob({states: {chatgpt: {tabId: 10, started: false, runId: 'run-A'}}})];
  const b = worker(unsent(), {api: cancelled, handler: blank(OPENED), url: OPENED});
  await b.tick();
  assert.ok(b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.undispatched === true));
  assert.deepEqual(b.closedTabs, [10]);assert.deepEqual(b.local.state.pendingReviewJobs, {});
  // blank, but moved to another conversation: the user's, preserved (the job still retires)
  const moved = worker(unsent(), {api: cancelled, handler: blank('https://chatgpt.com/c/other'), url: 'https://chatgpt.com/c/other'});
  await moved.tick();
  assert.equal(moved.closedTabs.length, 0);assert.deepEqual(moved.local.state.pendingReviewJobs, {});
  const handler = blank(OPENED);
  // a started run never takes the undispatched path
  const started = worker([fixJob()], {api: cancelled, handler});
  await started.tick();
  assert.equal(started.messages.some(m => m.undispatched), false);assert.equal(started.closedTabs.length, 0);
});

test('worker: a cancelled fix tab stuck loading is preserved after the wait (never closed unproven)', async () => {
  let status = null; // what the page reports to the inventory probe once it answers
  const b = worker([fixJob()], {api: cancelled, handler: (_id, m) => (m.type === 'ashlar-tab-status' && status ? status : {ok: true, owned: true, url: URL_FIX}), status: 'loading'});
  await b.tick();
  assert.equal(b.closedTabs.length, 0);assert.ok(b.local.state.pendingReviewJobs['fix-A'], 'waits while loading');
  assert.equal(b.messages.some(m => m.type === 'ashlar-fix-cancel'), false, 'a loading page is not asked');
  const RealDate = b.context.Date || Date;
  const later = RealDate.now() + 3 * 60_000;
  b.context.Date = class extends RealDate { static now() { return later; } };
  await b.tick();
  assert.equal(b.closedTabs.length, 0);assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'retired, capacity released');
  // the page finishes loading later and still reports its unreleased binding: not an orphan
  b.tabs.get(10).status = 'complete';
  status = {ok: true, ownershipProtocol: 1, jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', released: false, url: URL_FIX};
  await b.context.refreshTabInventory();for (let i = 0; i < 20; i++) await flush();
  const report = await b.context.tabCapacityReport({});
  assert.equal(report.orphanTabs, 0, 'the preserved run is released worker-side');
});

test('worker: a cancelled fix tab the user took over is preserved, never closed', async () => {
  const b = worker([fixJob()], {api: cancelled, handler: () => ({ok: true, owned: false, url: URL_FIX})});
  await b.tick();
  assert.equal(b.closedTabs.length, 0);assert.ok(b.tabs.has(10));
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'the slot is released without closing the tab');
});

test('worker: a cancelled fix tab without a matching page binding is never closed', async () => {
  const b = worker([fixJob()], {api: cancelled, handler: () => ({ok: false, code: 'job_mismatch', jobId: 'fix-B'})});
  await b.tick();
  assert.equal(b.closedTabs.length, 0);
  assert.match(b.local.state.pendingReviewJobs['fix-A'].states.chatgpt.cleanupError, /ownership does not match/);
});

test('worker: take opts into fix items, and a kind:fix payload runs with its kind and prompt', async () => {
  const offer = {kind: 'fix', jobId: 'fix-A', provider: 'chatgpt', providers: ['chatgpt'], resumeProviders: [], leaseId: 'L',
    prompt: 'FIX PROMPT', reasoning: {chatgpt: 'pro', grok: 'heavy'}, title: 'fix o/r#1', owner: 'o', repo: 'r', pr: 1};
  let offered = false;
  const api = async (path, body) => body?.action === 'take' && !offered ? (offered = true, {ok: true, job: offer}) : active(path, body);
  const b = background({api, handler: () => ({ok: false, code: 'busy', retry: true})});
  await b.tick();
  const take = b.calls.find(c => c.action === 'take');
  assert.equal(take.fixProtocol, 1);assert.equal(take.attachmentProtocol, 2);
  const started = b.messages.find(m => m.type === 'ashlar-run');
  assert.equal(started.kind, 'fix');assert.equal(started.jobId, 'fix-A');assert.equal(started.prompt, 'FIX PROMPT');
  assert.equal(b.local.state.pendingReviewJobs['fix-A'].kind, 'fix');
});
