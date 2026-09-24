// Extension handling of review-loop FIX items: the page runner harvests plain text (no review
// JSON), the worker delivers it via complete, skips every review-JSON lane, and force-closes a
// cancelled fix tab only with positive page ownership. Review behavior is asserted unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {content, background, storage, flush, until} from './helpers.mjs';

const PARTS = ['I guarded the null path.', '{"summary":"guard","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}'];
// A fix is read from the answer's fenced code only (literal text; see assistantCodeBlocks).
const ANSWER = PARTS[1];
const URL_FIX = 'https://chatgpt.com/c/fix';
const run = (extra = {}) => ({type: 'ashlar-run', jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', kind: 'fix', prompt: 'FIX PROMPT', ...extra});
const msg = (type, extra = {}) => ({type, jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', kind: 'fix', ...extra});

/** Page runner over a completed answer; a polling guard turns "pending forever" into an error.
 * `bound`: the run's prompt is sent and its response identified (a fix reads nothing else). */
function page({parts = PARTS, blocks = [PARTS[1]], limit = 50, bound = true} = {}) {
  const c = content('chatgpt');
  c.context.location = {href: URL_FIX}; // the conversation the fix is bound in (pinned on its first exact observation)
  let polls = 0;
  const journal = bound ? {phase: 'sent', expected: 'FIX PROMPT', baseline: 0, messageId: 'user-A'} : null;
  Object.assign(c.context, {
    readSubmissionJournal: async () => journal,
    // every later fix decision re-reads the same journal (fixOwnershipProof)
    savedSubmission: () => journal,
    boundReviewResponse: () => ({identified: true, followup: false, root: {}, responseId: 'response-A'}),
    // No DOM here: the journaled sent turn holds exactly the prompt (edits are covered in browser.e2e).
    journaledTurnIntegrity: () => 'exact',
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

test('page: with no sent, identified submission a fix collector reads nothing on the page', async () => {
  const p = page({bound: false, limit: 12});
  Object.assign(p.state(), {kind: 'fix', running: true, jobId: 'fix-A', runId: 'run-A'});
  await assert.rejects(p.c.context.waitUntilFixOrQuota('ChatGPT'), /test-only polling guard/);
  assert.equal(p.state().nativeCompletion, undefined);
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

test('page: a visible quota notice ends a fix only before an answer is visible', async () => {
  const p = page();
  Object.assign(p.c.context, {quotaHit: () => true, stopButtonVisible: () => true, replyDoneVisible: () => false});
  await assert.rejects(p.c.context.waitUntilFixOrQuota('ChatGPT'), error => error.code === 'quota');
  const done = page();done.c.context.quotaHit = () => true;
  assert.equal(await done.c.context.waitUntilFixOrQuota('ChatGPT'), ANSWER);
});

// Round 11 lifecycle (review 5307890587, P1): a PERMANENT ownership verdict ends the collector on
// the observation that sees it (no further poll), with the distinct terminal code `taken_over`, the
// tab marked the user's for good and its managed slot freed. A transient "unknown" keeps polling.
const COLLECT_VERDICTS = {
  followup: {permanent: true, set: c => { c.boundReviewResponse = () => ({identified: true, followup: true, root: {}, responseId: 'response-A'}); }},
  edited: {permanent: true, set: c => { c.journaledTurnIntegrity = () => 'edited'; }},
  draft: {permanent: true, set: c => { c.document = {querySelectorAll: () => []}; c.responseStreaming = () => false; c.composer = () => ({value: 'my own question'}); c.normalizePrompt = text => String(text || '').replace(/\s+/g, ' ').trim(); }},
  moved: {permanent: true, journal: {conversation: 'https://chatgpt.com/c/users-own'}},
  unusable: {permanent: true, set: c => { c.location = {href: ''}; }}, // no conversation identity can be pinned
  turnUnrendered: {permanent: false, set: c => { c.boundReviewResponse = () => ({identified: false, followup: false, root: null}); }},
  composerEcho: {permanent: false, set: c => { c.document = {querySelectorAll: () => []}; c.responseStreaming = () => false; c.composer = () => ({value: 'FIX PROMPT'}); c.normalizePrompt = text => String(text || '').replace(/\s+/g, ' ').trim(); }},
};
for (const [name, verdict] of Object.entries(COLLECT_VERDICTS)) {
  test(`page: collect verdict "${name}" ${verdict.permanent ? 'ends the fix run at once (taken_over), slot freed' : 'is transient: the collector keeps polling'}`, async () => {
    const p = page({limit: 12});
    if (verdict.journal) {
      const journal = {phase: 'sent', expected: 'FIX PROMPT', baseline: 0, messageId: 'user-A', ...verdict.journal};
      Object.assign(p.c.context, {readSubmissionJournal: async () => journal, savedSubmission: () => journal});
    }
    verdict.set?.(p.c.context);
    Object.assign(p.state(), {kind: 'fix', running: true, jobId: 'fix-A', runId: 'run-A'});
    const out = await p.c.context.waitUntilFixOrQuota('ChatGPT').then(raw => ({raw}), error => ({code: error.code, message: error.message}));
    if (verdict.permanent) {
      assert.equal(out.code, 'taken_over', JSON.stringify(out));
      assert.equal(p.polls(), 0, 'ended on the observation that saw it, never polled until the deadline');
      assert.equal(p.state().slotReleased, true, 'the managed slot is freed');
      assert.equal(p.state().tabRepurposed, true, 'every later proof says the tab is the user\'s');
    } else {
      assert.match(out.message, /test-only polling guard/, 'still polling');
      assert.notEqual(p.state().slotReleased, true);
    }
  });
}

test('page: a collected fix answer whose tab is then taken over ends the run (taken_over) instead of answering busy', async () => {
  const p = page();
  p.c.context.runPrompt = async () => p.c.context.waitUntilReviewOrQuota('ChatGPT');
  p.c.message(run());
  await settled(p.c);
  assert.equal(p.state().result?.ok, true, 'collected');
  p.c.context.journaledTurnIntegrity = () => 'edited'; // the user edits the sent turn afterwards
  const out = p.c.message(msg('ashlar-harvest'));
  assert.equal(out.ok, false);assert.equal(out.code, 'taken_over');assert.equal(out.raw, undefined, 'the answer is never handed out');
  assert.equal(p.c.message({type: 'ashlar-tab-status'}).released, true);
  assert.equal(p.c.message(msg('ashlar-harvest')).code, 'taken_over', 'terminal: every later ask gets the same outcome');
  assert.equal(p.c.message(msg('ashlar-can-close')).reason, 'repurposed');
});

test('worker: a taken_over page outcome is delivered as a failure at once; the tab is preserved and the leg retires', async () => {
  const b = worker([fixJob()], {api: active, handler: (_id, m) => m.type === 'ashlar-fix-cancel'
    ? {ok: true, owned: false, ownership: 'takenOver', proof: 'repurposed', url: URL_FIX}
    : {ok: false, code: 'taken_over', error: 'fix run ended: the user took over the fix tab (followup); tab preserved'}});
  await b.tick();
  const failure = b.calls.find(c => c.action === 'failure');
  assert.match(failure?.error || '', /^taken_over: fix run ended/);assert.equal(failure.leaseId, 'lease-A');
  assert.deepEqual(b.closedTabs, [], 'never closed');
  assert.ok(b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true), 'the page is told to free its slot');
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'the leg retired');
});

test('worker: a delivered fix whose page never proves ownership is preserved after the wait, so its leg ends too', async () => {
  // The item is DONE on the server; only the leg (and its tab slot) could linger forever.
  const b = worker([fixJob({states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', delivered: true, cleanupPending: true, conversation: URL_FIX, outcome: {ok: true, raw: ANSWER}}}})],
    {api: active, handler: (_id, m) => (m.type === 'ashlar-can-close' ? {ok: true, canClose: false, reason: 'pending', ownership: 'unknown', url: URL_FIX} : {ok: true})});
  await b.tick();
  assert.ok(b.local.state.pendingReviewJobs['fix-A'], 'asked again first');
  const RealDate = b.context.Date || Date;
  const later = RealDate.now() + 3 * 60_000;
  b.context.Date = class extends RealDate { static now() { return later; } };
  await b.tick();
  assert.deepEqual(b.closedTabs, [], 'never closed unproven');
  assert.ok(b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true), 'the page is told to free its slot');
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'the leg retired');
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
    handler: (_id, m) => m.type === 'ashlar-can-close' ? {ok: true, canClose: true, ownership: 'owned', url: URL_FIX, conversation: URL_FIX} : {ok: true, raw: ANSWER, responseText: ANSWER, ownership: 'owned', conversation: URL_FIX}});
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
  const review = worker([fixJob({jobId: 'job-A', kind: undefined})], {api: active, handler});
  await Promise.all([fix.tick(), review.tick()]);
  // The review's archive follows a SHA-256 digest (threadpool): once it landed, the fix's would have.
  assert.ok(await until(() => review.calls.some(c => c.action === 'observe')), 'sanity: this state does archive for a review');
  assert.equal(fix.calls.some(c => REVIEW_LANES.includes(c.action)), false);
  assert.ok(review.messages.some(m => m.jobId) && review.messages.every(m => !('kind' in m)), 'review tab messages are unchanged (no kind field)');
});

test('worker: a cancelled fix is force-closed via ashlar-fix-cancel even while its answer is pending', async () => {
  const handler = (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, url: URL_FIX, conversation: URL_FIX} : {ok: true, canClose: false, reason: 'pending'};
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
  // blank on the same path but out of temporary-chat mode: a different page (the user's), preserved
  const plain = worker(unsent(), {api: cancelled, handler: blank('https://chatgpt.com/'), url: 'https://chatgpt.com/'});
  await plain.tick();
  assert.equal(plain.closedTabs.length, 0);assert.deepEqual(plain.local.state.pendingReviewJobs, {});
  // the fragment is not part of the page identity
  const hashed = worker(unsent(), {api: cancelled, handler: blank(`${OPENED}#x`), url: `${OPENED}#x`});
  await hashed.tick();
  assert.deepEqual(hashed.closedTabs, [10]);
  const handler = blank(OPENED);
  // a started run never takes the undispatched path
  const started = worker([fixJob()], {api: cancelled, handler});
  await started.tick();
  assert.equal(started.messages.some(m => m.undispatched), false);assert.equal(started.closedTabs.length, 0);
});

test('worker: a started fix whose page is owned only by being blank must still be on its allocation page', async () => {
  const OPENED = 'https://chatgpt.com/?temporary-chat=true';
  // the run was dispatched (started) but its send is not confirmed: the page answers owned+blank
  const blank = (url) => (_id, m) => (m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', blank: true, url} : {ok: true, canClose: false, reason: 'pending'});
  let inventory = null; // what the page reports to the inventory probe
  const movedHandler = (id, m) => (m.type === 'ashlar-tab-status' && inventory ? inventory : blank('https://chatgpt.com/c/other')(id, m));
  const moved = worker([fixJob()], {api: cancelled, handler: movedHandler, url: 'https://chatgpt.com/c/other'});
  await moved.tick();
  assert.equal(moved.closedTabs.length, 0, 'an empty conversation the user moved to is preserved');
  assert.deepEqual(moved.local.state.pendingReviewJobs, {}, 'the job still retires');
  assert.ok(moved.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true), 'the page is told to free its slot');
  // the page still reports its binding unreleased (it never handled the preserve): not an orphan
  inventory = {ok: true, ownershipProtocol: 1, jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', released: false, url: 'https://chatgpt.com/c/other'};
  await moved.context.refreshTabInventory();await until(() => false, 200);
  assert.equal((await moved.context.tabCapacityReport({})).orphanTabs, 0, 'the preserved run is released worker-side');
  const plain = worker([fixJob()], {api: cancelled, handler: blank('https://chatgpt.com/'), url: 'https://chatgpt.com/'});
  await plain.tick();
  assert.equal(plain.closedTabs.length, 0);
  const home = worker([fixJob()], {api: cancelled, handler: blank(OPENED), url: OPENED});
  await home.tick();
  assert.deepEqual(home.closedTabs, [10], 'still the page the fix opened: closed');
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

test('worker: a loaded cancelled fix tab that cannot be messaged is preserved after the wait, and the job retires', async () => {
  let status = null; // what the page reports to the inventory probe once it answers
  const b = worker([fixJob()], {api: cancelled, handler: (_id, m) => (m.type === 'ashlar-tab-status' && status ? status : {ok: true, owned: true, url: URL_FIX})});
  const chrome = b.context.chrome;
  const send = chrome.tabs.sendMessage;
  // No receiver for the cancel, and reinjection fails too.
  chrome.tabs.sendMessage = (id, msg, cb) => {
    if (msg.type !== 'ashlar-fix-cancel') return send(id, msg, cb);
    b.messages.push({id, ...msg});
    chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};cb();chrome.runtime.lastError = null;
  };
  chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
  await b.tick();
  assert.equal(b.closedTabs.length, 0);
  const pending = b.local.state.pendingReviewJobs['fix-A'];
  assert.ok(pending, 'waits while the page cannot answer');
  assert.equal(typeof pending.states.chatgpt.ownershipUnknownAt, 'number');
  const RealDate = b.context.Date || Date;
  const later = RealDate.now() + 3 * 60_000;
  b.context.Date = class extends RealDate { static now() { return later; } };
  await b.tick();
  assert.equal(b.closedTabs.length, 0, 'never closed unproven');assert.ok(b.tabs.has(10));
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'retired, capacity released');
  assert.equal(b.messages.some(m => m.preserve === true), false, 'an unreachable page is not messaged to preserve');
  status = {ok: true, ownershipProtocol: 1, jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', released: false, url: URL_FIX};
  await b.context.refreshTabInventory();for (let i = 0; i < 20; i++) await flush();
  assert.equal((await b.context.tabCapacityReport({})).orphanTabs, 0, 'the preserved run is released worker-side');
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

// Review round 11 (4096523047): the server hands a claimed, run-less fix to its own profile again
// whenever the worker does not list it (lost take response) — the SAME delivery (deliveryId). The
// worker opens at most one tab per jobId + deliveryId, whatever triggers admission.
test('worker: overlapping admission triggers never create two tabs for one fix jobId (one tab per delivery)', async () => {
  const offer = {kind: 'fix', jobId: 'fix-A', offerKind: 'fresh', deliveryId: 'delivery-1', provider: 'chatgpt', providers: ['chatgpt'], resumeProviders: [],
    leaseId: 'L', prompt: 'FIX PROMPT', reasoning: {chatgpt: 'pro', grok: 'heavy'}, title: 'fix o/r#1', owner: 'o', repo: 'r', pr: 1};
  const takes = [];
  // The server's replay rule (bridge-fix.server.ts T3): offered to this profile while it does not list it.
  const api = async (path, body) => {
    if (body?.action !== 'take') return active(path, body);
    takes.push(body.excludeJobIds);
    return body.excludeJobIds.includes('fix-A') ? {ok: true, job: null} : {ok: true, job: {...offer, offerKind: takes.length > 1 ? 'replay' : 'fresh'}};
  };
  const handler = () => ({ok: false, code: 'busy', retry: true});
  const b = background({api, handler});
  const runs = worker => worker.messages.filter(m => m.type === 'ashlar-run' && m.jobId === 'fix-A');
  // Overlapping triggers of one worker (alarm, interval, poll-now): one take in flight, one tab.
  await Promise.all([b.tick(), b.tick(), b.tick()]);
  await b.tick();
  assert.equal(b.tabs.size, 1, 'one tab');
  assert.equal(new Set(runs(b).map(m => m.id)).size, 1, 'the prompt went to one tab');
  // The job registry is lost while that tab keeps the run (hard reset: an empty registry and a
  // reloaded worker over the same storage and tabs). Admission races the tab inventory, so the take
  // can come before recovery sees the tab: the server would replay the same delivery.
  await b.local.set({pendingReviewJobs: {}});
  const reloaded = background({local: b.local, session: b.session, tabs: b.tabs, api, handler});
  await Promise.all([reloaded.tick(), reloaded.tick()]);
  await reloaded.tick();
  assert.equal(b.tabs.size, 1, 'no second tab for the same delivery');
  assert.equal(runs(reloaded).length, 0, 'the prompt is never submitted again');
  assert.ok(takes.at(-1).includes('fix-A'), 'the delivered fix is listed, so the server never replays it here');
  // Even a replay that reaches the worker (a server that ignores the list) opens nothing.
  const deaf = background({local: b.local, session: b.session, tabs: b.tabs, api: async (path, body) => (body?.action === 'take' ? {ok: true, job: {...offer, offerKind: 'replay'}} : active(path, body)), handler});
  await deaf.tick();
  assert.equal(b.tabs.size, 1);assert.equal(runs(deaf).length, 0);
  assert.equal(deaf.local.state.pendingReviewJobs['fix-A'], undefined, 'the duplicate delivery is not admitted');
});

// Round 12 (Ashlar 4097631112): the delivery record is two-phase. `creating` (the intent) is written
// before chrome.tabs.create and becomes `created` (with the tabId) only after the tab exists; only a
// record a tab still proves keeps the delivery out of the server's replay. A worker that stops
// between the intent and the create must not strand the fix until its deadline.
const DELIVERIES = 'ashlar:fixDeliveries';
const FRESH = {kind: 'fix', jobId: 'fix-A', offerKind: 'fresh', deliveryId: 'delivery-1', provider: 'chatgpt', providers: ['chatgpt'], resumeProviders: [],
  leaseId: 'L', prompt: 'FIX PROMPT', reasoning: {chatgpt: 'pro', grok: 'heavy'}, title: 'fix o/r#1', owner: 'o', repo: 'r', pr: 1};
/** The server's replay rule (bridge-fix.server.ts peek/T3): the claimed run-less item is offered to
 * its profile again whenever the take does not list it; the replay is the SAME delivery. */
function replayingServer() {
  const takes = [];
  const api = async (path, body) => {
    if (body?.action !== 'take') return active(path, body);
    takes.push(body.excludeJobIds);
    return body.excludeJobIds.includes('fix-A') ? {ok: true, job: null} : {ok: true, job: {...FRESH, offerKind: takes.length > 1 ? 'replay' : 'fresh'}};
  };
  return {api, takes};
}
const runsOf = w => w.messages.filter(m => m.type === 'ashlar-run' && m.jobId === 'fix-A' && !m.resume);

test('worker: a stop right after the delivery intent, before the tab exists: after a reset the delivery is replayed and opened once', async () => {
  const {api, takes} = replayingServer();
  const handler = () => ({ok: false, code: 'busy', retry: true});
  const b = background({api, handler});
  // The worker stops inside chrome.tabs.create: the intent is durable, no tab was ever created.
  b.chrome.tabs.create = () => new Promise(() => {});
  void b.tick();
  assert.ok(await until(() => b.local.state[DELIVERIES]?.['fix-A']), 'the delivery intent was recorded');
  assert.equal(b.tabs.size, 0);
  // Restart with an empty job registry and the marker intact.
  await b.local.set({pendingReviewJobs: {}});
  const reloaded = background({local: b.local, session: b.session, tabs: b.tabs, api, handler});
  await reloaded.tick();await reloaded.tick();await reloaded.tick();
  assert.equal(takes.length >= 2 && takes[1].includes('fix-A'), false, 'an intent that never became a tab does not keep the delivery out');
  assert.equal(b.tabs.size, 1, 'the delivery is opened, exactly once');
  assert.equal(runsOf(reloaded).length, 1, 'the prompt is submitted once');
  const record = b.local.state[DELIVERIES]['fix-A'];
  assert.equal(record.phase, 'created');assert.equal(record.tabId, [...b.tabs.keys()][0]);assert.equal(record.deliveryId, 'delivery-1');
  assert.ok(takes.at(-1).includes('fix-A'), 'now proven by its tab, it is listed');
});

test('worker: a stop right after the delivery intent with the job registry intact: the allocation runs again, one tab, one prompt', async () => {
  // allocating is journaled, the delivery record is only `creating`, and no tab carries the binding.
  const job = fixJob({deliveryId: 'delivery-1', states: {chatgpt: {runId: 'run-A', allocating: true}}});
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {'fix-A': job},
    [DELIVERIES]: {'fix-A': {deliveryId: 'delivery-1', provider: 'chatgpt', phase: 'creating', at: Date.now()}}}),
  api: active, handler: () => ({ok: false, code: 'busy', retry: true})});
  await b.tick();await b.tick();
  assert.equal(b.tabs.size, 1, 'one tab');
  assert.equal(runsOf(b).length, 1, 'one prompt');
  assert.equal(b.local.state[DELIVERIES]['fix-A'].phase, 'created');
  assert.equal(b.local.state.pendingReviewJobs['fix-A'].states.chatgpt.allocating, undefined);
});

for (const registry of ['lost', 'intact']) {
  test(`worker: a stop after chrome.tabs.create, before the promotion (registry ${registry}): the binding proves the tab, no second tab`, async () => {
    const {api, takes} = replayingServer();
    const handler = () => ({ok: false, code: 'busy', retry: true});
    // The tab exists and carries its owned record; the delivery record is still `creating`.
    const tabs = new Map([[101, {id: 101, url: 'https://chatgpt.com/?temporary-chat=true', status: 'complete'}]]);
    const session = storage({'ashlar:tab:101': {jobId: 'fix-A', provider: 'chatgpt', runId: 'run-A', closedKey: 'ashlar:closed:fix-A:chatgpt:run-A', closing: false}});
    const pending = registry === 'lost' ? {} : {'fix-A': fixJob({deliveryId: 'delivery-1', states: {chatgpt: {runId: 'run-A', allocating: true}}})};
    const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: pending,
      [DELIVERIES]: {'fix-A': {deliveryId: 'delivery-1', provider: 'chatgpt', phase: 'creating', at: Date.now()}}}), session, tabs, api, handler});
    await b.tick();await b.tick();
    assert.equal(tabs.size, 1, 'no second tab');
    assert.ok(takes.every(exclude => exclude.includes('fix-A')), 'the delivery stays out of the replay');
    if (registry === 'lost') {
      assert.equal(runsOf(b).length, 0, 'the prompt is never submitted again');
      assert.deepEqual({phase: b.local.state[DELIVERIES]['fix-A'].phase, tabId: b.local.state[DELIVERIES]['fix-A'].tabId}, {phase: 'created', tabId: 101}, 'promoted by its binding');
    } else {
      assert.equal(b.local.state.pendingReviewJobs['fix-A'].states.chatgpt.tabId, 101, 'the allocation recovered its own tab');
    }
  });
}

test('worker: a created delivery whose tab is gone and that no tab binds no longer keeps the delivery out', async () => {
  const {api, takes} = replayingServer();
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {},
    [DELIVERIES]: {'fix-A': {deliveryId: 'delivery-1', provider: 'chatgpt', phase: 'created', tabId: 77, at: Date.now()}}}), api, handler: () => ({ok: false, code: 'busy', retry: true})});
  await b.tick();
  assert.equal(takes[0].includes('fix-A'), false);
  assert.equal(b.tabs.size, 1);assert.equal(runsOf(b).length, 1);
});

test('worker: a cancelled fix tab that now carries another binding retires after the wait, leaving that binding untouched', async () => {
  const other = {ok: false, code: 'job_mismatch', jobId: 'job-B', runId: 'run-B', provider: 'chatgpt'};
  const handler = (_id, m) => (m.type === 'ashlar-tab-status'
    ? {ok: true, ownershipProtocol: 1, jobId: 'job-B', runId: 'run-B', provider: 'chatgpt', released: false, url: URL_FIX}
    : other);
  const b = worker([fixJob()], {api: cancelled, handler});
  const otherRecord = {jobId: 'job-B', provider: 'chatgpt', runId: 'run-B', closedKey: 'ashlar:closed:job-B:chatgpt:run-B', closing: false};
  await b.session.set({'ashlar:tab:10': otherRecord});
  await b.tick();
  assert.equal(b.closedTabs.length, 0);
  assert.match(b.local.state.pendingReviewJobs['fix-A'].states.chatgpt.cleanupError, /ownership does not match/, 'waits first');
  const RealDate = b.context.Date || Date;
  const later = RealDate.now() + 3 * 60_000;
  b.context.Date = class extends RealDate { static now() { return later; } };
  await b.tick();
  assert.equal(b.closedTabs.length, 0, 'never closed');assert.ok(b.tabs.has(10));
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'the old fix leg retired: its prompt is gone and its slot released');
  assert.deepEqual(b.session.state['ashlar:tab:10'], otherRecord, "the other binding's tab record is intact");
  assert.equal(b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true), false, "another binding's page is never told to release");
  await b.context.refreshTabInventory();for (let i = 0; i < 20; i++) await flush();
  assert.equal((await b.context.tabCapacityReport({})).orphanTabs, 1, 'the other binding still counts against capacity');
});

test('worker: a fix tab preserved while it could not answer completes the release handshake once it can', async () => {
  let status = null; // what the page reports to the inventory probe once it answers
  const b = worker([fixJob()], {api: cancelled, status: 'loading', handler: (_id, m) => {
    if (m.type === 'ashlar-tab-status' && status) return status;
    if (m.type === 'ashlar-fix-cancel' && m.preserve === true) { status = {...status, released: true}; return {ok: true, owned: false, ownership: 'owned', url: URL_FIX}; }
    return {ok: true, owned: true, url: URL_FIX};
  }});
  const RealDate = b.context.Date || Date;
  const later = RealDate.now() + 3 * 60_000;
  await b.tick();
  b.context.Date = class extends RealDate { static now() { return later; } };
  await b.tick();
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'retired on the backstop');
  const key = 'ashlar:preserved:fix-A:chatgpt:run-A';
  assert.ok(b.session.state[key], 'the backstop record holds until the page releases');
  // the page finishes loading, still bound and unreleased
  b.tabs.get(10).status = 'complete';
  status = {ok: true, ownershipProtocol: 1, jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', released: false, url: URL_FIX};
  await b.context.refreshTabInventory();await until(() => b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true));
  const release = b.messages.find(m => m.type === 'ashlar-fix-cancel' && m.preserve === true);
  assert.ok(release, 'the page is asked to release its slot (and stop collecting)');
  assert.equal(release.jobId, 'fix-A');assert.equal(release.runId, 'run-A');assert.equal(release.kind, 'fix');
  assert.equal((await b.context.tabCapacityReport({})).orphanTabs, 0);
  // the page now reports itself released: the backstop record is dropped
  await b.context.refreshTabInventory();await until(() => !b.session.state[key]);
  assert.equal(b.session.state[key], undefined, 'the handshake completed');
  assert.equal((await b.context.tabCapacityReport({})).orphanTabs, 0);
  // a preserved record whose tab is gone is dropped too
  await b.session.set({'ashlar:preserved:fix-Z:chatgpt:run-Z': {tabId: 999}});
  await b.context.refreshTabInventory();await until(() => !b.session.state['ashlar:preserved:fix-Z:chatgpt:run-Z']);
  assert.equal(b.session.state['ashlar:preserved:fix-Z:chatgpt:run-Z'], undefined);
});

test('worker: every bridge request carries the fixProtocol:1 opt-in (the server gates every fix operation on it)', async () => {
  const b = worker([], {api: active});
  const seen = [];
  b.context.fetch = async (url, init) => { seen.push({url, body: init.body ? JSON.parse(init.body) : undefined}); return {ok: true, status: 200, json: async () => ({ok: true})}; };
  for (const body of [{action: 'recover', clientId: 'c', bindings: []}, {action: 'ping', jobId: 'fix-A', leaseId: 'L'}, {action: 'claim', jobId: 'fix-A'},
    {action: 'progress', jobId: 'fix-A'}, {action: 'release', jobId: 'fix-A'}, {action: 'failure', jobId: 'fix-A'}, {action: 'complete', jobId: 'fix-A'}, {action: 'ping'}]) await b.rpc('/api/bridge', body);
  await b.rpc('/api/bridge?jobId=fix-A&attachmentProtocol=2');
  await b.rpc('/api/bridge');
  assert.equal(seen.length, 10);
  assert.ok(seen.filter(s => s.body).every(s => s.body.fixProtocol === 1), JSON.stringify(seen));
  assert.deepEqual(seen.filter(s => !s.body).map(s => new URL(s.url).searchParams.get('fixProtocol')), ['1', '1']);
});
