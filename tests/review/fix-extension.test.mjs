// Extension handling of review-loop FIX items: the page runner harvests plain text (no review
// JSON), the worker delivers it via complete, skips every review-JSON lane, and closes a fix tab
// only on the proven-success path (every other end preserves it). Review behavior is asserted unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {content, background, storage, flush, until, source} from './helpers.mjs';

const PARTS = ['I guarded the null path.', '{"summary":"guard","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}'];
// A fix is read from the answer's fenced code only (literal text; see assistantCodeBlocks).
const ANSWER = PARTS[1];
// ChatGPT's temporary chat: the page every fix tab opens on (background.js providerUrl), whose URL
// never changes; a fix is proven only there (json.js fixChatPage).
const URL_FIX = 'https://chatgpt.com/?temporary-chat=true';
const run = (extra = {}) => ({type: 'ashlar-run', jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', kind: 'fix', prompt: 'FIX PROMPT', ...extra});
const msg = (type, extra = {}) => ({type, jobId: 'fix-A', runId: 'run-A', provider: 'chatgpt', kind: 'fix', ...extra});

/** Page runner over a completed answer; a polling guard turns "pending forever" into an error.
 * `bound`: the run's prompt is sent and its response identified (a fix reads nothing else). */
function page({parts = PARTS, blocks = [PARTS[1]], limit = 50, bound = true} = {}) {
  const c = content('chatgpt');
  c.context.location = {href: URL_FIX}; // the page still shows the conversation the fix was sent in
  let polls = 0;
  // conversation: recorded by composer.js submissionConfirmed when the send was proven
  const journal = bound ? {phase: 'sent', expected: 'FIX PROMPT', baseline: 0, messageId: 'user-A', conversation: URL_FIX} : null;
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
  // round 13: a sent journal with no send-time identity (legacy, or confirmed only after a reload)
  // never gains one: the collector never records it from the current location
  unestablished: {permanent: true, journal: {conversation: undefined}},
  unreadableLocation: {permanent: true, set: c => { c.location = {href: ''}; }},
  turnUnrendered: {permanent: false, set: c => { c.boundReviewResponse = () => ({identified: false, followup: false, root: null}); }},
  // round 15: a permanent verdict is decided BEFORE the response must be identified: moved away with
  // the old DOM gone, or the sent turn replaced (no response binds to it any more)
  movedUnrendered: {permanent: true, set: c => { c.location = {href: 'https://chatgpt.com/c/users-own'}; c.boundReviewResponse = () => ({identified: false, followup: false, root: null}); }},
  replacedUnrendered: {permanent: true, set: c => { c.journaledTurnIntegrity = () => 'edited'; c.boundReviewResponse = () => ({identified: false, followup: false, root: null}); }},
  movedComposerEcho: {permanent: true, set: c => { c.location = {href: 'https://chatgpt.com/c/users-own'}; c.document = {querySelectorAll: () => []}; c.responseStreaming = () => false; c.composer = () => ({value: 'FIX PROMPT'}); c.normalizePrompt = text => String(text || '').replace(/\s+/g, ' ').trim(); }},
  composerEcho: {permanent: false, set: c => { c.document = {querySelectorAll: () => []}; c.responseStreaming = () => false; c.composer = () => ({value: 'FIX PROMPT'}); c.normalizePrompt = text => String(text || '').replace(/\s+/g, ' ').trim(); }},
};
for (const [name, verdict] of Object.entries(COLLECT_VERDICTS)) {
  test(`page: collect verdict "${name}" ${verdict.permanent ? 'ends the fix run at once (taken_over), slot freed' : 'is transient: the collector keeps polling'}`, async () => {
    const p = page({limit: 12});
    if (verdict.journal) {
      const journal = {phase: 'sent', expected: 'FIX PROMPT', baseline: 0, messageId: 'user-A', conversation: URL_FIX, ...verdict.journal};
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

// Round 15 (Ashlar 4100156796) drift guard: the page proves a fix only in json.js fixChatPage();
// the worker opens every fix tab at background.js providerUrl(provider, reasoning). Today providerUrl
// ignores the reasoning (never a model slug in the URL), so both are the same page for every value;
// this pins that, using the URL the worker actually opens, so a future per-reasoning URL cannot
// silently turn every fix into taken_over.
const CHATGPT_REASONING = JSON.parse(source('src/lib/reasoning.ts').match(/CHATGPT_REASONING = (\[[^\]]*\])/)[1]);
for (const reasoning of [...CHATGPT_REASONING, undefined]) {
  test(`page: an untouched confirmed fix on the tab the worker opens for reasoning ${reasoning} is owned`, async () => {
    const opened = background().context.providerUrl('chatgpt', reasoning);
    const p = page();
    const journal = {phase: 'sent', expected: 'FIX PROMPT', baseline: 0, messageId: 'user-A', conversation: opened};
    Object.assign(p.c.context, {location: {href: opened}, readSubmissionJournal: async () => journal, savedSubmission: () => journal});
    Object.assign(p.state(), {kind: 'fix', running: true, jobId: 'fix-A', runId: 'run-A'});
    assert.equal(p.c.context.fixOwnershipProof(p.state(), {phase: 'collect', journal}).ownership, 'owned', opened);
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
  const b = worker([fixJob({states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', delivered: true, cleanupPending: true, answerDelivered: true, conversation: URL_FIX, outcome: {ok: true, raw: ANSWER}}}})],
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

test('page: ashlar-fix-cancel needs a positive binding; it stops the collector and releases the slot, and authorises nothing (no ownership verdict)', async () => {
  const p = page({limit: 500});
  Object.assign(p.c.context, {stopButtonVisible: () => true, replyDoneVisible: () => false, savedSubmission: () => null});
  assert.equal(p.c.message(msg('ashlar-fix-cancel')).code, 'job_mismatch', 'an unbound page is never touched');
  assert.equal(p.c.message(msg('ashlar-fix-cancel', {undispatched: true})).code, 'job_mismatch', 'no page answers for an unbound tab');
  p.c.context.runPrompt = async () => p.c.context.waitUntilReviewOrQuota('ChatGPT');
  p.c.message(run());
  await flush();
  assert.equal(p.c.message(msg('ashlar-fix-cancel', {jobId: 'fix-B'})).code, 'job_mismatch');
  assert.equal(p.c.message(msg('ashlar-fix-cancel', {runId: 'run-B'})).code, 'job_mismatch');
  assert.equal(p.c.message({type: 'ashlar-tab-status'}).released, false);
  const out = p.c.message(msg('ashlar-fix-cancel'));
  assert.equal(out.ok, true);assert.equal(out.released, true);
  for (const key of ['owned', 'ownership', 'blank', 'unsent', 'identity']) assert.equal(key in out, false, `the reply carries no ${key}`);
  assert.equal(p.c.message({type: 'ashlar-tab-status'}).released, true, 'the preserved tab frees its slot (not counted against capacity)');
  await settled(p.c);
  assert.equal(p.c.message(msg('ashlar-harvest')).code, 'cancelled', 'the collector stopped');
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

// ── A fix tab is closed ONLY on the proven-success path (background.js cleanupFixTab) ───────────
// Every end of a fix leg × every state its page can be in. The leg's end decides whether the answer
// was delivered; the page condition decides what the page says when asked (`owned`: the page itself
// would allow the close, the strongest temptation). The only cell that closes is a delivered answer
// whose page proves the close (control). Every other cell: the tab is never removed, its managed
// slot is released (the page is told when it can be messaged, and the worker's preserved-run record
// keeps the binding out of the capacity count either way) and the job retires.
const TEMP = URL_FIX;
const ANSWER_OUTCOME = {ok: true, raw: ANSWER, originalText: ANSWER, completion: {responseId: 'response-A', context: TEMP}};
const cancelledPing = status => async (_path, body) => body?.action === 'ping'
  ? {ok: true, active: false, accepted: false, status, bridge: {captureProtocol: 1, localJsonRepairEnabled: false}} : {ok: true, job: null};
// How each end reaches the worker. The server reports cancelled for a timeout, a supersede and an
// abort alike (one item state, CANCELLED; the worker cannot tell them apart, and must not need to).
const FIX_ENDS = {
  cancelled: {api: cancelledPing('cancelled'), state: {}},
  superseded: {api: cancelledPing('cancelled'), state: {}},
  deadline: {api: cancelledPing('cancelled'), state: {}},
  // a run that failed (quota, a runner error): the failure is delivered, then the tab is preserved
  failure: {api: active, state: {outcome: {ok: false, code: 'error', error: 'composer unavailable'}}},
  // a permanent page verdict ended the run (json.js endFixRun): delivered as a failure at once
  taken_over: {api: active, state: {outcome: {ok: false, code: 'taken_over', error: 'fix run ended: the user took over the fix tab (draft); tab preserved'}}},
  // the answer was collected but the server rejected it (400): no delivered answer
  rejected: {api: active, state: {delivered: true, cleanupPending: true, rejectedRaw: ANSWER, outcome: {ok: false, code: 'error', error: 'completed review was rejected: HTTP 400'}}},
  // the answer was collected, but no acknowledged delivery was recorded (the leg ended by a cancel)
  lost_delivery_record: {api: cancelledPing('cancelled'), state: {delivered: true, cleanupPending: true, conversation: TEMP, outcome: ANSWER_OUTCOME}},
};
const DELIVERED = {api: active, state: {delivered: true, cleanupPending: true, answerDelivered: true, conversation: TEMP, outcome: ANSWER_OUTCOME}};
const PAGE_CONDITIONS = {
  owned: {reply: {ok: true, owned: true, ownership: 'owned', canClose: true, reason: 'complete', url: TEMP, conversation: TEMP, released: true}},
  taken_over: {reply: {ok: true, owned: false, ownership: 'takenOver', canClose: false, reason: 'repurposed', url: TEMP, conversation: TEMP}},
  unknown_ownership: {reply: {ok: true, owned: false, ownership: 'unknown', canClose: false, reason: 'pending', url: TEMP, conversation: TEMP}},
  other_binding: {reply: {ok: false, code: 'job_mismatch', jobId: 'job-B', runId: 'run-B', provider: 'chatgpt'}, other: true},
  unreachable: {reply: null},
  loading: {reply: {ok: true, owned: true, ownership: 'owned', canClose: true, reason: 'complete', url: TEMP, conversation: TEMP}, loading: true},
};
async function fixEnd(end, condition) {
  const page = PAGE_CONDITIONS[condition];
  const binding = page.other ? {jobId: 'job-B', runId: 'run-B'} : {jobId: 'fix-A', runId: 'run-A'};
  const tabStatus = {ok: true, ownershipProtocol: 1, ...binding, provider: 'chatgpt', released: false, url: TEMP};
  const b = worker([fixJob({states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', ...end.state}}})],
    {api: end.api, url: TEMP, status: page.loading ? 'loading' : 'complete', handler: (_id, m) => (m.type === 'ashlar-tab-status' ? tabStatus : page.reply)});
  const chrome = b.context.chrome;
  if (!page.reply) {
    // No receiver for any job message, and reinjection fails too (the inventory probe still answers later).
    const send = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = (id, msg, cb) => {
      if (msg.type === 'ashlar-tab-status') return send(id, msg, cb);
      b.messages.push({id, ...msg});
      chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};cb();chrome.runtime.lastError = null;
    };
    chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
  }
  await b.tick();
  const RealDate = b.context.Date || Date;
  const later = RealDate.now() + 3 * 60_000; // past the success path's bounded re-ask
  b.context.Date = class extends RealDate { static now() { return later; } };
  await b.tick();
  const releaseSent = b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true && m.jobId === 'fix-A');
  // the page finishes loading later and still reports its binding unreleased (it never handled a release)
  if (b.tabs.has(10)) b.tabs.get(10).status = 'complete';
  await b.context.refreshTabInventory();for (let i = 0; i < 20; i++) await flush();
  const report = await b.context.tabCapacityReport({});
  return {
    closed: b.closedTabs.length, tabOpen: b.tabs.has(10), retired: !b.local.state.pendingReviewJobs['fix-A'],
    // released: the worker's preserved-run record (and, for a messageable page, the release message)
    // keeps this run's binding out of the capacity count; another binding keeps counting as its own
    preservedRecord: Boolean(b.session.state['ashlar:preserved:fix-A:chatgpt:run-A']),
    releaseSent,
    counted: page.other ? report.orphanTabs : report.orphanTabs + report.managedTabs,
  };
}
for (const [endName, end] of Object.entries({...FIX_ENDS, delivered: DELIVERED})) {
  for (const condition of Object.keys(PAGE_CONDITIONS)) {
    const control = endName === 'delivered' && condition === 'owned';
    test(`fix end ${endName} × page ${condition}: ${control ? 'the proven-success path closes the tab (control)' : 'never closed; slot released; job retired'}`, async () => {
      const got = await fixEnd(end, condition);
      const page = PAGE_CONDITIONS[condition];
      assert.deepEqual(got, control
        ? {closed: 1, tabOpen: false, retired: true, preservedRecord: false, releaseSent: false, counted: 0}
        : {closed: 0, tabOpen: true, retired: true, preservedRecord: true,
          // a loading tab is never messaged, and another binding is never asked to release by the success path
          releaseSent: !page.loading && !(endName === 'delivered' && (page.other || !page.reply)),
          counted: page.other ? 1 : 0});
    });
  }
}

test('worker: a cancelled REVIEW with a pending page keeps its tab and waits (no deadline, no fix-cancel)', async () => {
  const handler = () => ({ok: true, canClose: false, reason: 'pending', url: URL_FIX});
  const review = worker([fixJob({jobId: 'job-A', kind: undefined})], {api: cancelled, handler});
  await review.tick();
  assert.equal(review.closedTabs.length, 0);assert.ok(review.local.state.pendingReviewJobs['job-A']);
  assert.equal(review.messages.some(m => m.type === 'ashlar-fix-cancel'), false);
});

test('worker: a cancelled fix whose run was never dispatched keeps its (blank) tab: preserved, never closed, the job retires', async () => {
  const b = worker([fixJob({states: {chatgpt: {tabId: 10, started: false, runId: 'run-A'}}})],
    {api: cancelled, url: TEMP, handler: () => ({ok: false, code: 'job_mismatch', jobId: '', runId: '', provider: 'chatgpt'})});
  await b.tick();
  assert.deepEqual(b.closedTabs, []);assert.ok(b.tabs.has(10));
  assert.deepEqual(b.local.state.pendingReviewJobs, {});
  assert.equal(b.messages.some(m => 'undispatched' in m), false, 'no page is ever asked to vouch for an unbound tab');
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
  // the fix tab opens on ChatGPT's temporary chat, the only page a fix can be proven in
  assert.deepEqual([...b.tabs.values()].map(tab => tab.url), [URL_FIX]);
});

test('page: a fix whose send-time conversation is not the temporary chat is never collected: its run ends (taken_over)', async () => {
  for (const where of ['https://chatgpt.com/c/fix', 'https://chatgpt.com/', 'https://chatgpt.com/?temporary-chat=false']) {
    const p = page();
    // the page shows exactly the conversation the send was proven in, but it is not the temporary chat
    p.c.context.location = {href: where};
    const journal = {phase: 'sent', expected: 'FIX PROMPT', baseline: 0, messageId: 'user-A', conversation: where};
    Object.assign(p.c.context, {readSubmissionJournal: async () => journal, savedSubmission: () => journal});
    Object.assign(p.state(), {kind: 'fix', running: true, jobId: 'fix-A', runId: 'run-A'});
    await assert.rejects(p.c.context.waitUntilFixOrQuota('ChatGPT'), error => error.code === 'taken_over' && /cannot be identified/.test(error.message), where);
    assert.equal(p.state().nativeCompletion, undefined, `${where}: nothing collected`);
    assert.equal(p.c.message({type: 'ashlar-tab-status'}).released, true, `${where}: the slot is freed`);
  }
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

// Ashlar 4099509094, over the REAL fix registry: only take / recover hand out a delivery. A released,
// unpinned item is never claimed back (409 take_required, nothing minted); the next take hands the
// worker D2 in its offer, the worker journals it before opening the tab, and a lost registry plus the
// server's replay of D2 still opens at most one tab (one prompt) for D2.
test('worker + real registry: release before progress, a refused claim, D2 by take; registry loss + replay opens one tab for D2', async () => {
  const {createFixRegistry} = await import('../../src/lib/bridge-fix.server.ts');
  let ids = 0;
  const reg = createFixRegistry({now: () => 1_000_000, newId: () => `n${++ids}`, parallelLimit: () => 2, reasoning: () => ({chatgpt: 'pro', grok: 'heavy'}),
    timeoutMs: () => 30 * 60_000, maxPromptChars: () => 100_000, claimMs: 5 * 60_000, submitWindowMs: 60_000, setTimer: () => 0, clearTimer() {}});
  reg.request({owner: 'o', repo: 'r', pr: 1, provider: 'chatgpt', prompt: 'FIX PROMPT'}).catch(() => {});
  const id = reg.peek().id;
  const d1 = reg.take(id, 'chrome-1');
  assert.equal(reg.release(id, d1.leaseId), true, 'an older worker released it before any progress');
  assert.equal(reg.claim(id, 'chrome-1').code, 'take_required');
  assert.equal(reg.snapshot(id).deliveryId, d1.deliveryId, 'the refused claim minted nothing');
  const offers = [];
  // The /api/bridge route over that registry, for profile chrome-1 (`honourExclude` false: a server
  // that replays whatever the worker lists).
  const serve = ({honourExclude = true} = {}) => async (_path, body) => {
    if (body?.action === 'take') {
      const next = reg.peek(honourExclude ? body.excludeJobIds : [], 'chrome-1');
      const offer = next ? reg.take(next.id, 'chrome-1') : null;
      if (offer) offers.push(offer);
      return {ok: true, job: offer};
    }
    if (body?.action === 'claim') {
      const out = reg.claim(body.jobId, 'chrome-1');
      if (!out.ok) throw Object.assign(new Error(`HTTP 409 ${out.code}`), {status: 409, code: out.code});
      return out;
    }
    if (body?.action === 'ping') {
      const accepted = reg.refresh(body.jobId, body.leaseId, body.generating);
      return {ok: true, accepted, ...reg.state(body.jobId), bridge: {captureProtocol: 1, localJsonRepairEnabled: false}};
    }
    return {ok: true, job: null};
  };
  const handler = () => ({ok: false, code: 'busy', retry: true});
  const b = background({api: serve(), handler});
  b.context.crypto = webcrypto;b.context.TextEncoder = TextEncoder;
  await b.tick();await b.tick();
  assert.equal(offers.length, 1);
  assert.deepEqual([offers[0].offerKind, offers[0].deliveryId !== d1.deliveryId], ['fresh', true], 'the take handed out D2');
  const d2 = offers[0].deliveryId;
  assert.equal(b.tabs.size, 1, 'one tab for D2');
  assert.equal(b.local.state['ashlar:fixDeliveries'][id]?.deliveryId, d2, 'the worker journaled D2 from the take offer');
  const runs = w => w.messages.filter(m => m.type === 'ashlar-run' && m.jobId === id && !m.resume);
  assert.equal(runs(b).length, 1, 'the prompt was sent once');
  // The job registry is lost (hard reset), the tab keeps the run; the server replays D2 (T3: the
  // worker does not list it), and a server that ignores the list offers it anyway.
  for (const honourExclude of [true, false]) {
    await b.local.set({pendingReviewJobs: {}});
    const reloaded = background({local: b.local, session: b.session, tabs: b.tabs, api: serve({honourExclude}), handler});
    reloaded.context.crypto = webcrypto;reloaded.context.TextEncoder = TextEncoder;
    await reloaded.tick();await reloaded.tick();
    assert.equal(b.tabs.size, 1, `no second tab for D2 (server ${honourExclude ? 'honours' : 'ignores'} the list)`);
    assert.equal(runs(reloaded).length, 0, 'the prompt is never submitted again');
  }
  assert.ok(offers.slice(1).every(offer => offer.deliveryId === d2 && offer.offerKind === 'replay'), 'every later offer is the same delivery D2 (replay)');
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

// Round 15 (Ashlar 4100156779): the delivery record says `created` BEFORE state.tabId is durably
// saved (allocateProviderTab promotes, then saves). A worker that stops in between leaves
// `allocating` with no tabId and a `created` record. The record is validated, never trusted: its
// tab still open in this browser session (or the page the inventory binds to this run) is restored
// and the run continues in it; a recorded tab that is gone (and no owned record, no bound page) is
// proven absent: the stale record is dropped and exactly one replacement is allocated, instead of
// waiting on "tab creation outcome unknown" until the fix deadline.
/** A page that has not been sent a run is bound to no job; once run, it is busy generating. */
const UNBOUND_UNTIL_RUN = () => { const bound = new Set();
  return (id, m) => { if (m.type === 'ashlar-run') bound.add(id);
    return bound.has(id) ? {ok: false, code: 'busy', retry: true} : {ok: false, code: 'idle', jobId: '', runId: ''}; }; };
const STOPPED = () => fixJob({deliveryId: 'delivery-1', states: {chatgpt: {runId: 'run-A', allocating: true}}});
const CREATED = (tabId, session = 'boot-1') => ({deliveryId: 'delivery-1', provider: 'chatgpt', phase: 'created', tabId, session, runId: 'run-A', at: Date.now()});
for (const row of [
  {name: 'its recorded tab is gone', tabs: [], record: CREATED(77), want: {tabs: 1, runs: 1, restored: false}},
  {name: 'its recorded tab was recorded in an earlier browser session (the ID now names another tab)', tabs: [[77, {id: 77, url: URL_FIX, status: 'complete'}]],
    record: CREATED(77, 'boot-0'), want: {tabs: 2, runs: 1, restored: false}},
  {name: 'its recorded tab is still open (control)', tabs: [[77, {id: 77, url: URL_FIX, status: 'complete'}]], record: CREATED(77), want: {tabs: 1, runs: 1, restored: true}},
]) {
  test(`worker: a stop after the delivery was promoted, before its tabId was saved, and ${row.name}: ${row.want.restored ? 'resumed in that tab, no second tab' : 'exactly one replacement tab'}`, async () => {
    const tabs = new Map(row.tabs);
    const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {'fix-A': STOPPED()}, [DELIVERIES]: {'fix-A': row.record}}),
      // an undispatched tab's page carries no binding: it answers a harvest for no job
      session: storage({'ashlar:browserSession': 'boot-1'}), tabs, api: active, handler: UNBOUND_UNTIL_RUN()});
    b.context.crypto = webcrypto;
    await b.tick();await b.tick();await b.tick();
    const state = b.local.state.pendingReviewJobs['fix-A'].states.chatgpt;
    const runs = runsOf(b);
    assert.deepEqual({tabs: tabs.size, runs: runs.length, restored: runs[0]?.id === 77}, row.want);
    assert.equal(state.connectionError, undefined, 'never "tab creation outcome unknown"');
    assert.equal(state.allocating, undefined);
    assert.equal(state.tabId, runs[0].id, 'the run continues in the tab it was dispatched to');
    const record = b.local.state[DELIVERIES]['fix-A'];
    assert.deepEqual({phase: record.phase, tabId: record.tabId, session: record.session}, {phase: 'created', tabId: state.tabId, session: 'boot-1'});
    assert.ok(b.session.state[`ashlar:tab:${state.tabId}`]?.runId === 'run-A', 'the tab carries its owned record');
  });
}

test('worker: a promoted fix delivery whose tab the user explicitly closed before its tabId was saved ends the run (tab_closed), no replacement', async () => {
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {'fix-A': STOPPED()}, [DELIVERIES]: {'fix-A': CREATED(77)}}),
    session: storage({'ashlar:browserSession': 'boot-1', 'ashlar:closed:fix-A:chatgpt:run-A': true}), api: active, handler: () => ({ok: false, code: 'busy', retry: true})});
  b.context.crypto = webcrypto;
  await b.tick();
  assert.equal(b.tabs.size, 0, 'no replacement for a tab the user closed');
  assert.equal(runsOf(b).length, 0);
  assert.ok(b.calls.some(c => c.action === 'failure' && /explicitly closed/.test(c.error)), 'the run ends now, not at the deadline');
});

// Round 15 (Ashlar 4100156790): runId is part of a binding's identity (matchesJob, preservedKey,
// closedKey), so every ownership comparison of a binding includes it. An older run's leg never
// removes, proves or frees what a newer run of the same job and provider holds. Shared review code:
// asserted for both kinds. Control: the matching run.
const ownedRecord = runId => ({jobId: 'fix-A', provider: 'chatgpt', runId, closedKey: `ashlar:closed:fix-A:chatgpt:${runId}`, closing: false});
for (const kind of ['review', 'fix']) for (const tabRun of ['run-B', 'run-A']) {
  test(`worker (${kind}): a retiring leg of run-A ${tabRun === 'run-A' ? 'removes its own tab record (control)' : "keeps the newer run-B's record of that tab"}`, async () => {
    const job = fixJob(kind === 'fix' ? {} : {kind: undefined});
    const b = worker([job], {api: active});
    await b.session.set({'ashlar:tab:10': ownedRecord(tabRun)});
    const jobs = b.local.state.pendingReviewJobs;
    await b.context.finishTabCleanup(jobs['fix-A'], 'chatgpt', jobs, 'test');
    assert.deepEqual(b.session.state['ashlar:tab:10'], tabRun === 'run-A' ? undefined : ownedRecord('run-B'));
  });
}
for (const bindingRun of ['run-0', 'run-A']) {
  test(`worker: a delivery record of run-A is ${bindingRun === 'run-A' ? 'proven by its own run\'s binding (control)' : 'not proven by an older run\'s binding of the job'}`, async () => {
    const {api, takes} = replayingServer();
    const tabs = new Map([[101, {id: 101, url: URL_FIX, status: 'complete'}]]);
    const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {},
      [DELIVERIES]: {'fix-A': {deliveryId: 'delivery-1', provider: 'chatgpt', phase: 'creating', runId: 'run-A', at: Date.now()}}}),
    session: storage({'ashlar:tab:101': ownedRecord(bindingRun)}), tabs, api, handler: () => ({ok: false, code: 'busy', retry: true})});
    const proven = await b.context.reconcileFixDeliveries({});
    assert.equal(Boolean(proven['fix-A']), bindingRun === 'run-A');
    assert.equal(Boolean(b.local.state[DELIVERIES]['fix-A']), bindingRun === 'run-A', 'an unproven record is cleared (replayed once)');
    assert.equal(takes.length, 0);
  });
  test(`worker: a tab bound to ${bindingRun} of a job whose run-A leg retired ${bindingRun === 'run-A' ? 'is free (control)' : 'still counts against capacity'}`, async () => {
    const job = fixJob({states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', delivered: true, cleanupDone: true}}});
    const b = worker([job], {api: active, handler: (_id, m) => m.type === 'ashlar-tab-status'
      ? {ok: true, ownershipProtocol: 1, jobId: 'fix-A', runId: bindingRun, provider: 'chatgpt', released: false, url: URL_FIX} : {ok: false, code: 'busy'}});
    await b.context.refreshTabInventory();for (let i = 0; i < 20; i++) await flush();
    const report = await b.context.tabCapacityReport(b.local.state.pendingReviewJobs);
    assert.equal(report.orphanTabs, bindingRun === 'run-A' ? 0 : 1);
  });
}
test('worker: retiring a fix job forgets only its own delivery record', async () => {
  const b = worker([], {api: active});
  await b.local.set({[DELIVERIES]: {'fix-A': {deliveryId: 'delivery-2', provider: 'chatgpt', phase: 'creating', at: Date.now()}}});
  await b.context.forgetFixDelivery(fixJob({deliveryId: 'delivery-1'}));
  assert.equal(b.local.state[DELIVERIES]['fix-A']?.deliveryId, 'delivery-2', 'a newer delivery keeps its record');
  await b.context.forgetFixDelivery(fixJob({deliveryId: 'delivery-2'}));
  assert.equal(b.local.state[DELIVERIES]['fix-A'], undefined);
});

test('worker: a cancelled fix tab that now carries another binding retires at once, leaving that binding untouched', async () => {
  const other = {ok: false, code: 'job_mismatch', jobId: 'job-B', runId: 'run-B', provider: 'chatgpt'};
  const handler = (_id, m) => (m.type === 'ashlar-tab-status'
    ? {ok: true, ownershipProtocol: 1, jobId: 'job-B', runId: 'run-B', provider: 'chatgpt', released: false, url: URL_FIX}
    : other);
  const b = worker([fixJob()], {api: cancelled, handler});
  const otherRecord = {jobId: 'job-B', provider: 'chatgpt', runId: 'run-B', closedKey: 'ashlar:closed:job-B:chatgpt:run-B', closing: false};
  await b.session.set({'ashlar:tab:10': otherRecord});
  await b.tick();
  assert.equal(b.closedTabs.length, 0, 'never closed');assert.ok(b.tabs.has(10));
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'the old fix leg retired: its prompt is gone and its slot released');
  assert.deepEqual(b.session.state['ashlar:tab:10'], otherRecord, "the other binding's tab record is intact");
  // the release names this fix's run only: the other binding's page refuses it (job_mismatch)
  assert.ok(b.messages.filter(m => m.type === 'ashlar-fix-cancel').every(m => m.jobId === 'fix-A' && m.runId === 'run-A'));
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

// ── Round 13 (Ashlar 4099207116): composer.js submissionConfirmed records the conversation the
// send was made in at the moment the send is proven, exactly once. Only a send this page instance
// clicked (the in-memory `sendAttempt`) confirmed while the page still shows the conversation it
// was clicked in establishes it; nothing records it later.
function composerPage(href) {
  const saved = new Map();
  const context = vm.createContext({console, location: {href},
    sessionStorage: {getItem: k => saved.get(k) ?? null, setItem: (k, v) => { if (context.failWrites) throw new Error('quota'); saved.set(k, v); }}});
  vm.runInContext(source('extension/composer.js'), context, {filename: 'composer.js'});
  const turn = text => ({textContent: text, querySelector: () => null, getAttribute: n => (n === 'data-message-id' ? 'user-A' : null)});
  context.turns = [];
  context.userTurns = () => context.turns;
  context.__ashlarRunnerState = {jobId: 'fix-A', runId: 'run-A', kind: 'fix'};
  const key = 'ashlar:submission:fix-A:run-A';
  return {context, turn, stored: () => JSON.parse(saved.get(key) || 'null'),
    // what clickSend records in memory just before it clicks Send
    click: (runId = 'run-A') => { context.__ashlarRunnerState.sendAttempt = {key: `ashlar:submission:fix-A:${runId}`, conversation: context.location.href.split('#')[0]}; },
    record: () => ({phase: 'attempted', expected: 'fix prompt', baseline: 0, attachments: []})};
}
test('page: submissionConfirmed records the send-time conversation exactly once, and only for a send this page clicked where it still is', () => {
  const p = composerPage('https://chatgpt.com/?temporary-chat=true#frag');
  const record = p.record();
  p.click();
  assert.equal(p.context.submissionConfirmed(record), false, 'no turn yet: nothing is proven, nothing recorded');
  assert.equal(record.conversation, undefined);
  p.context.turns.push(p.turn('fix prompt'));
  assert.equal(p.context.submissionConfirmed(record), true);
  assert.equal(record.conversation, 'https://chatgpt.com/?temporary-chat=true', 'the location at the moment the send is proven (fragment dropped)');
  assert.equal(p.stored().phase, 'sent');
  assert.equal(p.stored().conversation, 'https://chatgpt.com/?temporary-chat=true', 'persisted with the sent journal');
  // never replaced: a later confirmation (another location, another attempt) keeps the first identity
  p.context.location.href = 'https://chatgpt.com/c/users-own';p.click();
  p.context.submissionConfirmed(record);
  assert.equal(record.conversation, 'https://chatgpt.com/?temporary-chat=true');
  assert.equal(p.stored().conversation, 'https://chatgpt.com/?temporary-chat=true');
  assert.equal(p.context.__ashlarRunnerState.confirmedSubmission.record.conversation, 'https://chatgpt.com/?temporary-chat=true');
});
const UNESTABLISHED = {
  reload: () => {}, // the click belonged to an earlier page instance: no in-memory attempt here
  otherRun: p => p.click('run-B'),
  movedBeforeConfirm: p => { p.click();p.context.location.href = 'https://chatgpt.com/c/users-own'; }, // the old DOM renders the turn under the user's URL
  noLocation: p => { p.click();p.context.location = undefined; },
  reviewRun: p => { p.context.__ashlarRunnerState.kind = undefined;p.click(); }, // a review journal stays exactly as before
};
for (const [name, setup] of Object.entries(UNESTABLISHED)) {
  test(`page: submissionConfirmed proves the send but records no conversation (${name})`, () => {
    const p = composerPage('https://chatgpt.com/?temporary-chat=true');
    const record = p.record();
    setup(p);
    p.context.turns.push(p.turn('fix prompt'));
    assert.equal(p.context.submissionConfirmed(record), true, 'the send itself is proven');
    assert.equal(record.phase, 'sent');
    assert.equal(record.conversation, undefined, 'no send-time identity (json.js: identity "unestablished")');
    assert.equal('conversation' in p.stored(), false);
  });
}
test('page: a sent journal whose write failed keeps the send-time conversation for the retry, whatever the location later is', () => {
  const p = composerPage('https://chatgpt.com/?temporary-chat=true');
  const record = p.record();
  p.click();p.context.turns.push(p.turn('fix prompt'));
  p.context.failWrites = true;
  assert.equal(p.context.submissionConfirmed(record), true);
  assert.equal(p.stored(), null, 'the write failed');
  assert.equal(p.context.__ashlarRunnerState.submissionPersistencePending, true);
  p.context.location.href = 'https://chatgpt.com/c/users-own';p.context.failWrites = false;
  assert.equal(p.context.retrySubmissionPersistence(), true);
  assert.equal(p.stored().conversation, 'https://chatgpt.com/?temporary-chat=true', 'the retry writes what was proven at send, not the current URL');
});
