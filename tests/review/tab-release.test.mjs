// Tab release (#82): once a leg's result is secured, or nobody wants it (cancelled / forgotten), its
// chat tab is closed unless the user positively took it over. These rows pin the worker side (vm
// harness) and the history diagnostics; the real-page scenarios are in tab-release.e2e.mjs.
import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {webcrypto} from 'node:crypto';
import {root, source} from './load-source.mjs';
import {PROGRESS_LABELS, sanitizeProgressEvents} from '../../src/lib/review-progress.ts';
import {background, content, storage, raw, flush, until} from './helpers.mjs';

/** The string-literal stages a progress call can record: literals of workerStep / recordReviewStep /
 * step arguments, including both arms of a conditional, but not the arguments of a nested call
 * (`reason?.includes("preserved")` is not a stage). */
function recordedStages(text) {
  const stages = new Set();
  for (const call of text.matchAll(/\b(?:workerStep|recordReviewStep|step)\(/g)) {
    const parens = [];
    for (let i = call.index + call[0].length - 1; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
        const literal = text.slice(i + 1, j);
        if (c === '"' && !parens.slice(1).includes('call') && /^[a-z][a-z0-9_]*$/.test(literal)) stages.add(literal);
        i = j;
      } else if (c === '(') {
        parens.push(!parens.length ? 'outer' : /[\w$)\]]/.test(text[i - 1]) ? 'call' : 'group');
      } else if (c === ')') {
        parens.pop();
        if (!parens.length) break;
      }
    }
  }
  return stages;
}

test('every stage the extension records has a history label (sanitizeProgressEvents drops unlabelled ones)', () => {
  const files = readdirSync(join(root, 'extension')).filter(name => name.endsWith('.js'));
  const stages = new Set(files.flatMap(name => [...recordedStages(source(`extension/${name}`))]));
  assert.ok(stages.has('tab_closed') && stages.has('generating') && stages.has('prompt_submitted'), 'sanity: the scan sees worker, page and composer stages');
  assert.equal(stages.has('preserved'), false, 'a nested call argument is not a stage');
  const unlabelled = [...stages].filter(stage => !Object.hasOwn(PROGRESS_LABELS, stage)).sort();
  assert.deepEqual(unlabelled, [], 'recorded stages without a PROGRESS_LABELS entry never reach review history');
});

test('the tab-release diagnostic stages have history labels, including every preserve_<cause> the worker records', () => {
  const causes = background().context.preserveCauses?.() || [];
  assert.ok(causes.includes('navigated') && causes.includes('unknown'), 'the worker lists its preserve causes');
  const stages = ['cancelled', 'cleanup_waiting_page', 'tab_preserved', 'tab_closed', ...causes.map(cause => `preserve_${cause}`)];
  assert.deepEqual(stages.filter(stage => !Object.hasOwn(PROGRESS_LABELS, stage)), []);
});

// ── Worker rows: each runs for a review leg and a fix leg and asserts ONE outcome (kind-neutral).
const URL_TAB = 'https://chatgpt.com/c/managed';
const ANSWER = {review: raw, fix: '{"summary":"guard","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}'};
const owned = {ok: true, releaseProtocol: 1, ownership: 'owned', conversation: URL_TAB, url: URL_TAB};
function leg(kind, state = {}, patch = {}) {
  return {jobId: kind === 'fix' ? 'fix-A' : 'job-A', ...(kind === 'fix' ? {kind: 'fix'} : {}), origin: 'http://bridge', leaseId: 'lease-A',
    prompt: 'PROMPT', providers: ['chatgpt'], reasoning: {chatgpt: 'pro', grok: 'heavy'},
    states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', ...state}}, ...patch};
}
function worker(job, {handler, status = 'awaiting_chat', tab = {id: 10, url: URL_TAB, status: 'complete'}, session} = {}) {
  const tabs = new Map(tab ? [[10, tab]] : []);
  const api = async (_path, body) => (body?.action === 'ping'
    ? {ok: true, active: status === 'awaiting_chat', accepted: status === 'awaiting_chat', status, bridge: {captureProtocol: 1, localJsonRepairEnabled: false}}
    : {ok: true, job: null});
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {[job.jobId]: job}}), session, tabs, api, handler});
  b.context.crypto = webcrypto;b.context.TextEncoder = TextEncoder;
  b.pending = () => b.local.state.pendingReviewJobs[job.jobId];
  b.later = () => { const RealDate = b.context.Date || Date; const at = RealDate.now() + 3 * 60_000; b.context.Date = class extends RealDate { static now() { return at; } }; };
  b.jobs = async () => b.context.workerJobs('http://bridge');
  return b;
}
// A secured leg: its answer acknowledged by the server (answerDelivered is the worker's record of the
// complete ACK, which a fix needs for its proven-success path, #77; a review ignores it).
const secured = kind => ({delivered: true, cleanupPending: true, answerDelivered: true, outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind]}});

for (const kind of ['review', 'fix']) {
  test(`${kind}: an abandoned leg whose tab is gone finishes by absence (no closeRequested needed)`, async () => {
    const b = worker(leg(kind, {delivered: true, cleanupPending: true, abandoned: true, abandonedAs: 'cancelled'}, {serverStatus: 'missing'}), {status: 'missing', tab: null});
    await b.tick();
    assert.equal(b.pending(), undefined, 'retired: nothing is left to wait for');
  });
  test(`${kind}: a secured leg whose page answers can-close "pending" (an older page) is preserved after the bounded wait, never held`, async () => {
    const b = worker(leg(kind, secured(kind)), {handler: (_id, m) => (m.type === 'ashlar-can-close' ? {ok: true, canClose: false, reason: 'pending', url: URL_TAB} : {ok: true})});
    await b.tick();
    assert.ok(b.pending(), 'asked again first');assert.equal(b.pending().states.chatgpt.cleanupWaitReason, 'ownership_unknown');
    b.later();await b.tick();
    assert.equal(b.pending(), undefined, 'retired after the wait');assert.deepEqual(b.closedTabs, [], 'never closed on a guess');
    assert.ok(b.session.state['ashlar:preserved:' + leg(kind).jobId + ':chatgpt:run-A'], 'the preserved backstop is recorded');
  });
}
// Chrome tab ids are unique only within one browser session, and the registry outlives it: an
// undispatched leg's stored id (no session record of its creation) can name the user's own tab. Its
// page is asked for its binding (read-only, Ashlar 4101623037) and the id is dropped only on proof.
const statusOf = (jobId, runId) => ({ok: true, ownershipProtocol: 1, jobId, runId, provider: 'chatgpt', released: false, url: 'https://chatgpt.com/'});
for (const kind of ['review', 'fix']) for (const [what, url, status] of [
  ['the user\'s own tab (an unbound page)', 'https://chatgpt.com/', statusOf('', '')],
  ['a tab bound to another job', 'https://chatgpt.com/c/other', statusOf('job-other', 'run-other')],
  ['a tab bound to another run of this job', 'https://chatgpt.com/c/other', statusOf(leg(kind).jobId, 'run-old')],
  ['a tab on another site', 'https://example.com/', undefined],
]) {
  test(`${kind}: an undispatched leg never sends its prompt into a tab id this browser session did not create for it (${what}); it opens its own tab`, async () => {
    const b = worker(leg(kind, {started: false}), {tab: {id: 10, url, status: 'complete'},
      handler: (_id, m) => (m.type === 'ashlar-tab-status' ? status : {ok: false, code: 'busy', retry: true})});
    await b.tick();
    assert.deepEqual([...new Set(b.messages.filter(m => m.id === 10).map(m => m.type))], status ? ['ashlar-tab-status'] : [], 'the reused id is only asked for its binding (read-only)');
    assert.equal(b.pending().states.chatgpt.tabId, undefined, 'the stale id is dropped');
    await b.tick();
    const run = b.messages.find(m => m.type === 'ashlar-run');
    assert.ok(run && run.id !== 10 && run.prompt === 'PROMPT', 'the leg dispatched into the tab it created');
    assert.equal(b.pending().states.chatgpt.tabId, run.id);
    assert.ok(b.tabs.has(10), 'the user\'s tab is untouched');
  });
}
// Ashlar 4101623037: a run message reached the page after askPage gave up on it, so the page bound
// the run (and may have sent its prompt) while the leg never recorded started. An extension reload
// then cleared storage.session: the leg's own tab has no creation record. Its page answers for its
// binding: adopted and observed, never sent the prompt again, no second tab.
for (const kind of ['review', 'fix']) for (const [what, harvest] of [
  ['still generating', {ok: false, code: 'busy', retry: true}],
  ['reloaded, its collector gone', {ok: false, code: 'idle'}],
]) {
  test(`${kind}: after an extension reload, an undispatched leg whose tab is bound to its run (${what}) adopts it and never sends the prompt again`, async () => {
    const b = worker(leg(kind, {started: false}), {tab: {id: 10, url: TEMP, status: 'complete'},
      handler: (_id, m) => (m.type === 'ashlar-tab-status' ? {...statusOf(leg(kind).jobId, 'run-A'), url: TEMP} : m.type === 'ashlar-harvest' ? harvest : {ok: false, code: 'busy', retry: true})});
    await b.tick();await b.tick();
    const state = b.pending().states.chatgpt;
    assert.equal(state.tabId, 10, 'the tab is kept');assert.equal(state.started, true, 'adopted as started');
    assert.ok(b.messages.some(m => m.id === 10 && m.type === 'ashlar-harvest'), 'observed');
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' && m.resume !== true), [], 'never a fresh run: the page\'s journal resumes it');
    assert.equal(b.messages.some(m => m.type === 'ashlar-run'), harvest.code === 'idle', 'a page with no collector is resumed, only then');
    assert.deepEqual([...b.tabs.keys()], [10], 'no second tab');
    assert.equal(b.session.state['ashlar:tab:10']?.runId, 'run-A', 'the adopted tab is recorded as the leg\'s again');
  });
}
// A page that cannot say (it never answers, or the tab is discarded, loading or frozen: a tab that may
// be the user's is never woken to ask) keeps the leg from opening a second tab. Past the bounded wait
// the leg fails: the prompt is never sent again on a guess, and the tab is never closed unproven.
const unreachable = b => { b.chrome.tabs.sendMessage = (id, msg) => { b.messages.push({id, ...msg}); }; b.context.pageReplyDeadline = expiresAtOnce; };
for (const kind of ['review', 'fix']) for (const [what, tab, setup] of [
  ['its page never answers', {status: 'complete'}, unreachable],
  ['it is discarded', {status: 'unloaded', discarded: true}, () => {}],
  ['it is still loading', {status: 'loading'}, () => {}],
  ['it is frozen', {status: 'complete', frozen: true}, () => {}],
]) {
  test(`${kind}: after an extension reload, an undispatched leg whose stored tab cannot say whether it holds the run (${what}) opens no second tab, and fails after a bounded wait`, async () => {
    const b = worker(leg(kind, {started: false}), {tab: {id: 10, url: TEMP, ...tab}, handler: () => ({ok: false, code: 'busy', retry: true})});
    setup(b);
    const reloads = [];b.chrome.tabs.reload = async id => { reloads.push(id); };
    await b.tick();await b.tick();
    let state = b.pending().states.chatgpt;
    assert.equal(state.tabId, 10, 'the id is kept while the page cannot say');
    assert.match(state.connectionError || '', /no second tab/);
    assert.deepEqual([...b.tabs.keys()], [10], 'no second tab');
    b.later();await b.tick();
    assert.ok(b.calls.some(c => c.action === 'failure' && /^tab_unreachable: .*not sent again/.test(c.error)), 'the bounded failure is delivered');
    b.later();await b.tick();await b.tick();
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run'), [], 'the prompt is never sent');
    assert.deepEqual([...b.tabs.keys()], [10], 'never a second tab');assert.deepEqual(b.closedTabs, [], 'never closed unproven');
    assert.deepEqual(reloads, [], 'never woken');
    state = b.pending()?.states.chatgpt;
    assert.ok(!state || state.outcome?.code === 'tab_unreachable', 'failed, or retired');
  });
}
test('review: a stored tab that could not answer at first and then proves it holds the run within the wait is adopted, never failed', async () => {
  let reachable = false;
  const b = worker(leg('review', {started: false}), {tab: {id: 10, url: TEMP, status: 'complete'},
    handler: (_id, m) => { if (!reachable) throw new Error('Could not establish connection. Receiving end does not exist.');
      return m.type === 'ashlar-tab-status' ? {...statusOf('job-A', 'run-A'), url: TEMP} : {ok: false, code: 'busy', retry: true}; }});
  await b.tick();
  assert.equal(b.pending().states.chatgpt.unrecordedTabSince > 0, true, 'waiting');
  reachable = true;await b.tick();
  const state = b.pending().states.chatgpt;
  assert.equal(state.started, true);assert.equal(state.unrecordedTabSince, undefined, 'the wait ended');
  b.later();await b.tick();
  assert.equal(b.calls.some(c => c.action === 'failure'), false);
  assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' && m.resume !== true), []);
});
// A leg nobody wants any more never sends, for either kind (#82), not even for the run message the
// worker gave up on (askPage bounds every page message) that reaches the page after the leg retired.
// The release tells the unbound page in the tab created for the leg that the run was never
// dispatched, and the page fences it (a review with its claim, a fix with a refusal that vouches for
// nothing, #77). The real page script answers here (kind-conformance W15b pins the cancelled case).
for (const kind of ['review', 'fix']) {
  test(`${kind}: a forgotten ("missing") leg that was never dispatched fences its run in its unbound page: a late run message for it never sends`, async () => {
    const opened = 'https://chatgpt.com/?temporary-chat=true';
    const jobId = leg(kind).jobId;
    const persisted = new Map();
    const page = content('chatgpt', persisted);
    page.context.location = {href: opened};
    let sent = 0;
    page.context.runPrompt = async () => { await flush(); page.context.throwIfStopped(); sent++; return ANSWER[kind]; };
    const session = storage({'ashlar:tab:10': {jobId, provider: 'chatgpt', runId: 'run-A', closedKey: `ashlar:closed:${jobId}:chatgpt:run-A`, closing: false}});
    const b = worker(leg(kind, {started: false}), {status: 'missing', session, tab: {id: 10, url: opened, status: 'complete'}, handler: (_id, m) => page.message(m)});
    await b.context.heartbeatTick();
    assert.deepEqual({ok: (await b.context.clearStuckJobs()).ok, retired: !b.pending()}, {ok: true, retired: true});
    assert.deepEqual(b.closedTabs, kind === 'fix' ? [] : [10], kind === 'fix' ? 'a fix tab is kept (#77)' : 'the blank review tab is closed');
    assert.ok(b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.undispatched === true), 'the release says the run was never dispatched');
    assert.equal(persisted.get(`ashlar:stopped:${jobId}:run-A`), 'true', 'the page fenced the run');
    page.message({type: 'ashlar-run', jobId, runId: 'run-A', provider: 'chatgpt', ...(kind === 'fix' ? {kind: 'fix'} : {}), prompt: 'PROMPT'});
    assert.ok(await until(() => page.context.__ashlarRunnerState.result), 'the late run ended');
    assert.deepEqual({sent, code: page.context.__ashlarRunnerState.result.code}, {sent: 0, code: 'cancelled'});
  });
}
// A cancelled or forgotten leg is stopped whatever it collected (#82), and released by the same
// verdict as a secured one: #77's rule that a close never follows the server status holds because
// the page answers both exits with ONE verdict (json.js tabOwnership), modelled here; only the cancel
// exit also stops the page's run (a review loop still polling after its original was archived).
function pageExits(verdict) {
  const page = {stopped: false};
  page.handler = (_id, m) => {
    if (m.type === 'ashlar-fix-cancel') page.stopped = true;
    return m.type === 'ashlar-can-close' || m.type === 'ashlar-fix-cancel' ? {...verdict, stopped: page.stopped} : {ok: false, code: 'busy', retry: true};
  };
  return page;
}
const archived = {id: 'capture-A', archiveDurable: true, responseId: 'response-A', text: 'not json', context: '[]', sourceHash: 'h', totalChars: 8};
const abandonedAs = {delivered: true, cleanupPending: true, abandoned: true, abandonedAs: 'cancelled', conversation: URL_TAB};
const ABANDONED_AFTER_COLLECT = [
  // the original is durably archived, but the page never recorded the capture receipt (it answered
  // capture_source_changed or unavailable), so its review loop still polls
  ['review', 'its original durably archived', {sourceCapture: archived, ...abandonedAs}, {captureProtocol: 1}],
  // collected, then cancelled before the result was ACKed (abandonLegs): never secured
  ['review', 'its answer collected, never ACKed', {outcome: {ok: true, raw, originalText: raw}, ...abandonedAs}],
  ['fix', 'its answer collected, never ACKed', {outcome: {ok: true, raw: ANSWER.fix, originalText: ANSWER.fix}, ...abandonedAs}],
];
// A FIX is the exception to the close (#77): a fix tab is closed only on the proven-success path (its
// answer delivered), so a cancelled fix leg is stopped and its tab kept whatever its page says.
for (const [kind, what, state, patch = {}] of ABANDONED_AFTER_COLLECT) {
  for (const verdict of ['owned', 'takenOver']) {
    const closes = verdict === 'owned' && kind !== 'fix';
    test(`${kind}: a cancelled leg with ${what} is stopped, and its tab ${closes ? 'closed as nobody\'s result' : 'kept'} ${kind === 'fix' ? `(page: ${verdict}; a fix tab closes only after a delivered answer)` : 'by the page\'s verdict'}`, async () => {
      const page = pageExits(verdict === 'owned' ? owned : {ok: true, releaseProtocol: 1, ownership: 'takenOver', cause: 'user_turn', url: URL_TAB});
      const job = leg(kind, state, {serverStatus: 'cancelled', ...patch});
      const b = worker(job, {status: 'cancelled', handler: page.handler});
      await b.tick();
      assert.equal(page.stopped, true, 'the cancel exit stopped the page\'s run');
      assert.equal(b.messages.some(m => m.type === 'ashlar-can-close'), false);
      assert.equal(b.pending(), undefined, 'retired');
      assert.deepEqual(b.closedTabs, closes ? [10] : []);
      const note = (b.local.state.bridgeRecentRetired || []).find(entry => entry.jobId === job.jobId)?.note;
      assert.equal(note, kind === 'fix' ? 'fix ended without a delivered answer (answer delivery unconfirmed); tab preserved'
        : verdict === 'owned' ? 'no result wanted; tab closed' : 'the user took over the tab; tab preserved', 'a result never secured is not reported as secured');
    });
  }
}
for (const kind of ['review', 'fix']) {
  test(`${kind}: control: a secured leg the server still wants asks can-close, is not stopped, and closes as a secured result`, async () => {
    const page = pageExits(owned);
    const b = worker(leg(kind, {...secured(kind), conversation: URL_TAB}), {handler: page.handler});
    await b.tick();
    assert.equal(page.stopped, false);assert.deepEqual(b.closedTabs, [10]);
    assert.equal((b.local.state.bridgeRecentRetired || []).find(entry => entry.jobId === leg(kind).jobId)?.note, 'result secured; tab closed');
  });
}
test('review: a page that answers "capture_source_changed" after a durable archive gets the release verdict (closed when Ashlar\'s)', async () => {
  const capture = {id: 'capture-A', archiveDurable: true, responseId: 'response-A', text: 'not json', context: '[]', sourceHash: 'h', totalChars: 8};
  const b = worker(leg('review', {sourceCapture: capture}, {captureProtocol: 1}), {handler: (_id, m) => (m.type === 'ashlar-capture-accepted' ? {ok: false, code: 'capture_source_changed'} : m.type === 'ashlar-can-close' ? owned : {ok: false, code: 'busy'})});
  const jobs = await b.jobs();
  await b.context.captureProvider(jobs['job-A'], 'chatgpt', jobs);
  assert.deepEqual(b.closedTabs, [10], 'a changed page after the original was secured is not the user\'s by itself');
  assert.equal(jobs['job-A'].states.chatgpt.sourceCapture.archiveDurable, true, 'the archived original is kept');
});
test('review: a page that answers "repair_source_changed" after a repair ACK gets the release verdict (closed when Ashlar\'s)', async () => {
  const attempt = {id: 'repair-A', raw, text: 'original', responseId: 'response-A', sourceHash: 'h', status: 'accepted'};
  const b = worker(leg('review', {...secured('review'), repairReceiptPending: true, repairAttempt: attempt}), {handler: (_id, m) => (m.type === 'ashlar-repair-accepted' ? {ok: false, code: 'repair_source_changed'} : m.type === 'ashlar-can-close' ? owned : {ok: false, code: 'busy'})});
  const jobs = await b.jobs();
  await b.context.notifyRepairReceipt(jobs['job-A'], 'chatgpt', jobs);
  assert.deepEqual(b.closedTabs, [10]);
});

// ── Diagnostics (#82 R5/R6): why a tab is kept, or why its cleanup waits, reaches review history and
// the worker status, instead of a stale blocker and a bare tab_preserved.
const stagesOf = events => sanitizeProgressEvents(events).map(e => `${e.source}:${e.stage}`);
const uploaded = b => stagesOf(b.calls.filter(c => c.action === 'progress').at(-1)?.progress?.chatgpt?.events);
// job-muf51f0g-1942 as 1.1.22 stored it: cancelled, then forgotten; a stale blocker.
const leg1942 = {delivered: true, cleanupPending: true, closeRequested: true, cleanupWaitReason: 'page_completion_or_journal_pending'};
for (const kind of ['review', 'fix']) {
  for (const [name, tab, reason] of [['discarded', {status: 'unloaded', discarded: true}, 'tab_discarded'], ['loading', {status: 'loading'}, 'tab_loading']]) {
    test(`${kind}: a ${name} tab is never messaged or closed; its blocker says so, and it is preserved (not orphaned) after the wait`, async () => {
      const job = leg(kind, leg1942, {serverStatus: 'missing'});
      const b = worker(job, {status: 'missing', tab: {id: 10, url: URL_TAB, ...tab},
        handler: (_id, m) => (m.type === 'ashlar-tab-status' ? {ok: true, ownershipProtocol: 1, jobId: job.jobId, runId: 'run-A', provider: 'chatgpt', released: false, url: URL_TAB} : owned)});
      await b.tick();await b.tick();
      if (kind === 'fix') {
        // A forgotten fix never reaches a verdict (#77): preserved at once, its page not woken to answer.
        assert.equal(b.pending(), undefined, 'retired at once');assert.deepEqual(b.closedTabs, []);
        // (only the inventory's release handshake may reach it once it answers: never a verdict request)
        assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-can-close' || (m.type === 'ashlar-fix-cancel' && m.preserve !== true)), [], 'never asked for a verdict');
        assert.equal(b.tabs.get(10).status, tab.status, 'the page is not woken up to answer');
        assert.ok(uploaded(b).includes('worker:preserve_undelivered') && uploaded(b).includes('worker:tab_preserved'));
        assert.ok(b.session.state[`ashlar:preserved:${job.jobId}:chatgpt:run-A`], 'the preserved backstop');
        b.tabs.get(10).status = 'complete';
        await b.context.refreshTabInventory();for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal((await b.context.tabCapacityReport({})).orphanTabs, 0, 'the kept binding never holds capacity as an orphan');
        return;
      }
      const state = b.pending().states.chatgpt;
      assert.equal(state.cleanupWaitReason, reason, 'the blocker names the tab state, not the stale reason');
      assert.equal(state.workerEvents.filter(e => e.stage === 'cleanup_waiting_page').length, 1, 'one step per reason change');
      assert.ok(b.calls.some(c => c.action === 'progress' && c.progress.chatgpt.events.some(e => e.stage === 'cleanup_waiting_page')), 'uploaded at once');
      assert.deepEqual(b.messages.filter(m => m.type !== 'ashlar-tab-status'), [], 'the page is not woken up to answer');
      b.later();await b.tick();
      assert.equal(b.pending(), undefined, 'retired after the wait');assert.deepEqual(b.closedTabs, []);
      assert.ok(uploaded(b).includes('worker:preserve_unreachable') && uploaded(b).includes('worker:tab_preserved'));
      assert.ok(b.session.state[`ashlar:preserved:${job.jobId}:chatgpt:run-A`], 'the preserved backstop');
      b.tabs.get(10).status = 'complete';
      await b.context.refreshTabInventory();for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal((await b.context.tabCapacityReport({})).orphanTabs, 0, 'the kept binding never holds capacity as an orphan');
    });
  }
  test(`${kind}: the page's steps and the preserve cause from a cleanup reply reach review history`, async () => {
    const events = [{source: 'page', sequence: 1, stage: 'response_collected', at: 1}, {source: 'page', sequence: 2, stage: 'context_changed', at: 2}];
    const b = worker(leg(kind, secured(kind)), {handler: (_id, m) => (m.type === 'ashlar-can-close'
      ? {ok: true, releaseProtocol: 1, ownership: 'takenOver', cause: 'user_turn', url: URL_TAB, progress: {runId: 'run-A', events}} : {ok: true})});
    await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, []);
    const history = uploaded(b);
    for (const stage of ['page:context_changed', 'worker:preserve_user_turn', 'worker:tab_preserved']) assert.ok(history.includes(stage), `${stage} in ${history}`);
    assert.ok(history.indexOf('worker:preserve_user_turn') < history.indexOf('worker:tab_preserved'), 'the cause precedes the preserve');
  });
}
// History says a run was cancelled only when its job was. The release that keeps a tab also stops the
// page's run, which the page records as "cancelled" ("the job was cancelled or forgotten"): that
// reply is uploaded only for an abandoned leg (for a fix kept without a delivered answer it is the
// page's only report). The real page script answers here, bound to the leg's run.
const PRESERVED_HISTORY = [
  // [kind, what, the worker's leg, the page's run state, the server status, history says cancelled]
  ['review', 'a secured review the user took over', secured('review'), {tabRepurposed: true, takeoverCause: 'user_turn'}, 'awaiting_chat', false],
  ['fix', 'a delivered fix the user took over', {...secured('fix'), conversation: 'https://chatgpt.com/?temporary-chat=true'}, {kind: 'fix', tabRepurposed: true, takeoverCause: 'user_turn'}, 'awaiting_chat', false],
  ['fix', 'a fix whose run ended on a usage limit', {delivered: true, cleanupPending: true, outcome: {ok: false, code: 'quota', error: 'limit'}}, {kind: 'fix', result: {ok: false, code: 'quota'}}, 'dlq', false],
  ['fix', 'a fix the server cancelled while it was generating', {}, {kind: 'fix', running: true}, 'cancelled', true],
];
for (const [kind, what, state, pageState, status, cancelled] of PRESERVED_HISTORY) {
  test(`${kind}: ${what} is preserved, and review history ${cancelled ? 'says its run was cancelled' : 'never says it was cancelled'}`, async () => {
    const url = 'https://chatgpt.com/?temporary-chat=true';
    const jobId = leg(kind).jobId;
    const page = content('chatgpt', new Map([['ashlar:job', jobId], ['ashlar:run', 'run-A']]));
    page.context.location = {href: url};
    Object.assign(page.context.__ashlarRunnerState, pageState);
    const b = worker(leg(kind, state), {status, tab: {id: 10, url, status: 'complete'}, handler: (_id, m) => page.message(m)});
    await b.tick();
    assert.equal(b.pending(), undefined, 'retired');assert.deepEqual(b.closedTabs, [], 'kept');
    assert.equal(page.context.__ashlarRunnerState.runStopped, true, 'the release stopped the page\'s run either way');
    const history = uploaded(b);
    assert.ok(history.includes('worker:tab_preserved'), `preserved: ${history}`);
    assert.equal(history.includes('page:cancelled'), cancelled, `page:cancelled in ${history}`);
  });
}
// A page that accepts a release message but never runs its handler (a frozen tab, a hung page): the
// reply is bounded (pageReplyDeadline, replaced here by one that expires at once), so the cleanup
// lane is never held and the bounded ownership wait applies.
const TEMP = 'https://chatgpt.com/?temporary-chat=true';
/** A current page's answer to the inventory's read-only status probe (bound to `jobId`'s run-A). */
const statusProbe = (jobId, url) => ({ok: true, ownershipProtocol: 1, jobId, runId: 'run-A', provider: 'chatgpt', released: false, url});
const expiresAtOnce = () => ({promise: new Promise((_resolve, reject) => setImmediate(() => reject(new Error('the page did not answer in time')))), cancel() {}});
for (const kind of ['review', 'fix']) {
  for (const [mode, state, status] of [['secured', secured(kind), 'awaiting_chat'], ['cancelled', {}, 'cancelled']]) {
    // (A cancelled fix is not waited on: it is preserved at once, #77; its page is still told to stop.)
    const atOnce = kind === 'fix' && mode === 'cancelled';
    test(`${kind}: a ${mode} leg whose page never answers the release message is ${atOnce ? 'preserved at once' : 'preserved after the wait'}, never held`, async () => {
      const b = worker(leg(kind, {...state, conversation: TEMP, pageUrl: TEMP}), {status, tab: {id: 10, url: TEMP, status: 'complete'}});
      // accepted, never answered (but its read-only status probe: the release is the lane under test,
      // and in the tab queue the inventory's probe of a hung page would back it off first)
      b.chrome.tabs.sendMessage = (id, msg, cb) => { b.messages.push({id, ...msg}); if (msg.type === 'ashlar-tab-status') cb(statusProbe(leg(kind).jobId, TEMP)); };
      b.context.pageReplyDeadline = expiresAtOnce;
      let settled = false;
      const ticked = b.tick().then(() => { settled = true; });
      assert.ok(await until(() => settled), 'the tick settles: an unanswered page does not hold the cleanup lane');
      await ticked;
      assert.ok(b.messages.some(m => m.type === (mode === 'secured' ? 'ashlar-can-close' : 'ashlar-fix-cancel')), 'the page was asked');
      if (atOnce) {
        assert.equal(b.pending(), undefined, 'retired at once');assert.deepEqual(b.closedTabs, []);
        assert.ok(uploaded(b).includes('worker:preserve_undelivered') && uploaded(b).includes('worker:tab_preserved'), `${uploaded(b)}`);
        return;
      }
      assert.equal(b.pending()?.states.chatgpt.cleanupWaitReason, 'page_unreachable', 'the blocker says why');
      b.later();await b.tick();
      assert.equal(b.pending(), undefined, 'retired after the wait');assert.deepEqual(b.closedTabs, [], 'never closed unproven');
      assert.ok(uploaded(b).includes('worker:preserve_unreachable') && uploaded(b).includes('worker:tab_preserved'), `${uploaded(b)}`);
    });
  }
  test(`${kind}: a frozen tab is never messaged; its blocker says so and it is preserved after the wait`, async () => {
    const b = worker(leg(kind, {...secured(kind), conversation: TEMP}), {tab: {id: 10, url: TEMP, status: 'complete', frozen: true}, handler: () => owned});
    await b.tick();
    assert.equal(b.pending()?.states.chatgpt.cleanupWaitReason, 'tab_frozen');
    assert.deepEqual(b.messages.filter(m => m.type !== 'ashlar-tab-status'), [], 'a frozen page is not asked');
    b.later();await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, []);
    assert.ok(uploaded(b).includes('worker:preserve_unreachable'));
  });
}
// A tab Chrome discarded (Memory Saver: job 649's tab sat in the background for 10+ minutes) holds no
// page, so no takeover can be read in it. On its own page, in the tab this browser session created
// for the leg, it is woken once and released by its page's verdict; on another page it is the user's.
const createdHere = kind => storage({'ashlar:tab:10': {jobId: leg(kind).jobId, provider: 'chatgpt', runId: 'run-A', closedKey: `ashlar:closed:${leg(kind).jobId}:chatgpt:run-A`, closing: false}});
const discardedTab = url => ({id: 10, url, status: 'unloaded', discarded: true});
const blankVerdict = (_id, m) => (m.type === 'ashlar-tab-status' ? {ok: true} : {ok: true, releaseProtocol: 1, ownership: 'owned', blank: true, url: TEMP});
function reloadSpy(b) {
  const reloads = [];
  // the woken tab loads (status "loading") until the test says it finished (loaded)
  b.chrome.tabs.reload = async id => { reloads.push(id); Object.assign(b.tabs.get(id), {discarded: false, status: 'loading'}); };
  return {reloads, loaded: () => { b.tabs.get(10).status = 'complete'; }};
}
for (const kind of ['review', 'fix']) {
  for (const [mode, state, status] of [['secured', {...secured(kind), conversation: TEMP, pageUrl: TEMP}, 'awaiting_chat'], ['cancelled (still waiting to send)', {pageUrl: TEMP}, 'cancelled']]) {
    if (kind === 'fix' && mode !== 'secured') {
      // A cancelled fix never reaches a verdict (#77): nothing is woken to answer, and nothing closes.
      test(`fix: a ${mode} leg whose temporary chat Chrome discarded is preserved at once, never woken`, async () => {
        const b = worker(leg(kind, state), {status, session: createdHere(kind), tab: discardedTab(TEMP), handler: blankVerdict});
        const {reloads} = reloadSpy(b);
        await b.tick();
        assert.deepEqual(reloads, []);assert.deepEqual(b.closedTabs, []);assert.equal(b.pending(), undefined);
        assert.deepEqual(b.messages.filter(m => m.type !== 'ashlar-tab-status'), [], 'a discarded page is not asked');
        assert.ok(uploaded(b).includes('worker:preserve_undelivered'), `${uploaded(b)}`);
      });
      continue;
    }
    test(`${kind}: a ${mode} leg whose temporary chat Chrome discarded is woken once, then closed on its page's verdict`, async () => {
      const b = worker(leg(kind, state), {status, session: createdHere(kind), tab: discardedTab(TEMP), handler: blankVerdict});
      const {reloads, loaded} = reloadSpy(b);
      await b.tick();
      assert.deepEqual(reloads, [10], 'woken (reloaded) once');
      assert.deepEqual(b.closedTabs, []);
      assert.ok(['tab_discarded', 'tab_loading'].includes(b.pending()?.states.chatgpt.cleanupWaitReason), 'waiting for the woken page');
      assert.deepEqual(b.messages.filter(m => m.type !== 'ashlar-tab-status'), [], 'a discarded page is not asked');
      await b.tick();
      assert.deepEqual(b.closedTabs, [], 'still loading');
      loaded();await b.tick();
      assert.deepEqual(b.closedTabs, [10], 'its page answered (a reloaded temporary chat is blank): closed');
      assert.equal(b.pending(), undefined, 'retired, capacity released');
      assert.deepEqual(reloads, [10], 'never reloaded again');
    });
  }
  test(`${kind}: a discarded tab on another page than its run's is the user's: preserved at once, never woken`, async () => {
    const b = worker(leg(kind, {...secured(kind), conversation: TEMP}), {session: createdHere(kind), tab: discardedTab('https://chatgpt.com/c/users-own'), handler: blankVerdict});
    const {reloads} = reloadSpy(b);
    await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, []);assert.deepEqual(reloads, []);
    assert.ok(uploaded(b).includes('worker:preserve_navigated'), `${uploaded(b)}`);
  });
  test(`${kind}: a discarded tab this browser session did not create for the leg is never woken; preserved after the wait`, async () => {
    const b = worker(leg(kind, {...secured(kind), conversation: TEMP}), {tab: discardedTab(TEMP), handler: blankVerdict});
    const {reloads} = reloadSpy(b);
    await b.tick();b.later();await b.tick();
    assert.deepEqual(reloads, []);assert.deepEqual(b.closedTabs, []);assert.equal(b.pending(), undefined);
    assert.ok(uploaded(b).includes('worker:preserve_unreachable'));
  });
}
// Ashlar 4101062759: Chrome discards an ACTIVE leg's tab (before its run was dispatched, or while it
// generates). The poll used to return there on every tick, so the leg waited for an outside reload
// forever, holding its slot. The tab this browser session created for the leg, on its run's page, is
// woken once and the run goes on in it (dispatched, or resumed: never sent twice, no second tab);
// any other discarded tab is never reloaded, and the leg ends with a bounded failure.
/** A clock the test moves (the worker reads Date.now; nothing waits on a timer). */
function stepClock(b) {
  const RealDate = b.context.Date || Date;let now = RealDate.now();
  b.context.Date = class extends RealDate { static now() { return now; } };
  return ms => { now += ms; };
}
/** A page that runs nothing until a run message starts (or resumes) its collector. `observing`: its
 * collector identified the response bound to the run's sent turn (json.js busy().observing). */
function freshPage({observing = false} = {}) {
  let running = false;
  return (_id, m) => {
    if (m.type === 'ashlar-run') { running = true; return {ok: false, code: 'busy', retry: true}; }
    if (m.type === 'ashlar-harvest') return running ? {ok: false, code: 'busy', retry: true, observing} : {ok: false, code: 'idle'};
    return {ok: true};
  };
}
for (const [kind, started] of [['review', false], ['review', true], ['fix', false]]) {
  test(`${kind}: an active leg (${started ? 'generating' : 'not dispatched yet'}) whose tab Chrome discarded is woken once, then ${started ? 'resumes observing its run' : 'dispatches its run'} there, exactly once`, async () => {
    const b = worker(leg(kind, {started, pageUrl: TEMP}), {session: createdHere(kind), tab: discardedTab(TEMP), handler: freshPage({observing: true})});
    const {reloads, loaded} = reloadSpy(b);
    const runs = () => b.messages.filter(m => m.type === 'ashlar-run');
    await b.tick();
    assert.deepEqual(reloads, [10], 'woken once');
    assert.deepEqual(runs(), [], 'nothing is sent to a page that is not there');
    assert.ok(stagesOf(b.pending().states.chatgpt.workerEvents).includes('worker:tab_woken'), 'the wake reaches history');
    await b.tick();
    assert.deepEqual(reloads, [10], 'still loading: not reloaded again');assert.deepEqual(runs(), []);
    loaded();await b.tick();await b.tick();
    assert.deepEqual(runs().map(m => ({id: m.id, resume: m.resume === true})), [{id: 10, resume: started}], started ? 'observation resumed once (never a new send)' : 'dispatched once');
    assert.equal(b.pending().states.chatgpt.started, true);
    assert.equal(b.tabs.size, 1, 'no second tab was opened for the leg');assert.deepEqual(b.closedTabs, []);
    assert.equal(b.pending().states.chatgpt.outcome, undefined, 'the job goes on');
    assert.deepEqual(reloads, [10], 'woken only once');
    b.later();await b.tick();
    assert.equal(b.pending().states.chatgpt.outcome, undefined, `past the discard's time limit the run still goes on: ${started ? 'its page observes the response bound to its sent turn' : 'it was dispatched into the loaded page'}`);
  });
}
// Ashlar 4101062759, reopened: loading again is not proof that the run goes on. A reload keeps the
// submission journal but not the page: a prompt entered but never sent (its composer text and file
// chips are gone) waits there forever without clicking, a run dispatched before its journal was
// written waits for a turn that never came, and a temporary chat renders nothing to observe. The
// discard's time limit holds until the page identifies the response bound to the run's sent turn.
test('review: a woken generating leg whose reloaded page never shows its run\'s sent turn fails after the discard\'s time limit (the failure says it was woken), and retires', async () => {
  const b = worker(leg('review', {started: true, pageUrl: TEMP}), {session: createdHere('review'), tab: discardedTab(TEMP), handler: freshPage({observing: false})});
  const {reloads, loaded} = reloadSpy(b);
  const advance = stepClock(b);
  await b.tick();loaded();await b.tick();await b.tick();
  assert.deepEqual(reloads, [10], 'woken once');
  assert.equal(b.messages.filter(m => m.type === 'ashlar-run' && m.resume === true).length, 1, 'observation resumed (never a new send)');
  assert.equal(b.pending().states.chatgpt.outcome, undefined, 'within the time limit the page may still show it');
  advance(3 * 60_000);await b.tick();
  const failure = b.calls.find(c => c.action === 'failure');
  assert.match(failure?.error || '', /^tab_discarded: .*woke it, but its reloaded page could not resume the run/, 'the failure is delivered and says a wake was tried');
  for (let i = 0; i < 3 && b.pending(); i++) { advance(3 * 60_000);await b.tick(); }
  assert.equal(b.pending(), undefined, 'retired: its capacity slot is released');
  assert.deepEqual(reloads, [10], 'never reloaded again');
  assert.equal(b.messages.filter(m => m.type === 'ashlar-run' && m.resume !== true).length, 0, 'never sent');
});
test('review: a woken page that never answers is bounded by the discard\'s time limit too', async () => {
  const b = worker(leg('review', {started: true, pageUrl: TEMP}), {session: createdHere('review'), tab: discardedTab(TEMP), handler: freshPage()});
  const {loaded} = reloadSpy(b);
  const advance = stepClock(b);
  await b.tick();loaded();
  b.chrome.tabs.sendMessage = (id, msg, callback) => { b.messages.push({id, ...msg}); b.chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'}; callback(); b.chrome.runtime.lastError = null; };
  b.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
  await b.tick();
  assert.equal(b.pending().states.chatgpt.outcome, undefined);
  advance(3 * 60_000);await b.tick();
  assert.equal(b.pending()?.states.chatgpt.outcome?.code ?? 'retired', b.pending() ? 'tab_discarded' : 'retired');
  assert.ok(b.calls.some(c => c.action === 'failure' && /tab_discarded/.test(c.error)), 'the failure is delivered');
});
// Ashlar 4101062759 (R3): the wake was once per leg, so a tab Chrome discarded AGAIN after its woken
// page resumed was never woken: the leg failed "could not be woken" although this discard was never
// tried, and its cleanup's own wake then reloaded the tab and closed it with the finished answer.
// Now a page that proved its run goes on earns the next wake (once per discard), capped per leg, and
// a leg that failed as tab_discarded is never reloaded by its own cleanup (kept: recoverable).
test('review: a tab Chrome discards again after each resume is woken once per discard, at most 3 times; then the leg fails, and its cleanup never reloads it', async () => {
  const b = worker(leg('review', {started: true, pageUrl: TEMP}), {session: createdHere('review'), tab: discardedTab(TEMP), handler: freshPage({observing: true})});
  const {reloads, loaded} = reloadSpy(b);
  const advance = stepClock(b);
  for (let i = 1; i <= 3; i++) {
    await b.tick();
    assert.equal(reloads.length, i, `discard ${i}: woken`);
    loaded();await b.tick();await b.tick();
    assert.equal(b.pending().states.chatgpt.discardedAt, undefined, `discard ${i}: its woken page resumed the run`);
    assert.equal(b.pending().states.chatgpt.outcome, undefined);
    Object.assign(b.tabs.get(10), {status: 'unloaded', discarded: true});
  }
  await b.tick();
  assert.equal(reloads.length, 3, 'a fourth discard is not woken (the cap)');
  advance(3 * 60_000);await b.tick();
  assert.match(b.calls.find(c => c.action === 'failure')?.error || '', /^tab_discarded: .*discarded again and was not woken \(Ashlar already woke it 3 times\)/, 'the failure says why it was not woken');
  for (let i = 0; i < 3 && b.pending(); i++) { advance(3 * 60_000);await b.tick(); }
  assert.equal(b.pending(), undefined, 'retired: its capacity slot is released');
  assert.equal(reloads.length, 3, 'its cleanup never reloads it either');
  assert.deepEqual(b.closedTabs, [], 'kept');assert.ok(uploaded(b).includes('worker:preserve_unreachable'), `${uploaded(b)}`);
});
test('review: a leg that failed because its woken tab never finished loading is not reloaded by its own cleanup when Chrome discards it again; kept after the wait', async () => {
  const b = worker(leg('review', {started: true, pageUrl: TEMP}), {session: createdHere('review'), tab: discardedTab(TEMP), handler: freshPage({observing: true})});
  const {reloads} = reloadSpy(b);
  const advance = stepClock(b);
  await b.tick();
  assert.deepEqual(reloads, [10], 'woken');
  advance(3 * 60_000);await b.tick();
  assert.match(b.calls.find(c => c.action === 'failure')?.error || '', /^tab_discarded: .*woke it/, 'the woken tab never loaded: the bounded failure is delivered');
  Object.assign(b.tabs.get(10), {status: 'unloaded', discarded: true});
  for (let i = 0; i < 3 && b.pending(); i++) { await b.tick();advance(3 * 60_000); }
  assert.equal(b.pending(), undefined, 'retired: its capacity slot is released');
  assert.deepEqual(reloads, [10], 'never reloaded by its cleanup');assert.deepEqual(b.closedTabs, [], 'kept (recoverable), never closed on a reload');
  assert.ok(uploaded(b).includes('worker:preserve_unreachable'), `${uploaded(b)}`);
});
// A fix's temporary chat is not restored by a reload (json.js: a reloaded temporary chat renders
// nothing), so a fix whose run was dispatched is never woken: it fails after the time limit, and its
// tab is kept (a fix tab closes only on its proven-success path, #77).
test('fix: an active leg whose run was dispatched is never woken (its temporary chat is not restored); it fails after the time limit and its tab is kept', async () => {
  const b = worker(leg('fix', {started: true, pageUrl: TEMP}), {session: createdHere('fix'), tab: discardedTab(TEMP), handler: freshPage({observing: true})});
  const {reloads} = reloadSpy(b);
  const advance = stepClock(b);
  await b.tick();
  assert.deepEqual(reloads, [], 'never woken');assert.equal(b.pending().states.chatgpt.outcome, undefined);
  advance(3 * 60_000);await b.tick();
  assert.ok(b.calls.some(c => c.action === 'failure' && /^tab_discarded: .*could not be woken/.test(c.error)), 'the bounded failure is delivered');
  for (let i = 0; i < 3 && b.pending(); i++) { advance(3 * 60_000);await b.tick(); }
  assert.equal(b.pending(), undefined, 'retired: its capacity slot is released');
  assert.deepEqual(reloads, [], 'never reloaded');assert.deepEqual(b.closedTabs, [], 'never closed');
  assert.ok(uploaded(b).includes('worker:preserve_undelivered'), `${uploaded(b)}`);
  assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' || m.type === 'ashlar-harvest'), [], 'nothing was sent to the tab');
});
for (const kind of ['review', 'fix']) for (const [what, session, url] of [
  ['this browser session did not create', undefined, TEMP],
  ['is on another page than its run\'s', 'created', 'https://chatgpt.com/c/users-own'],
]) {
  test(`${kind}: an active leg whose discarded tab ${what} is never reloaded; the leg fails after a bounded wait and retires`, async () => {
    const b = worker(leg(kind, {started: true, pageUrl: TEMP}), {session: session ? createdHere(kind) : undefined, tab: discardedTab(url), handler: freshPage()});
    const {reloads} = reloadSpy(b);
    const advance = stepClock(b);
    await b.tick();
    assert.equal(b.pending().states.chatgpt.outcome, undefined, 'the user may still bring the tab back');
    advance(3 * 60_000);await b.tick();
    assert.equal(b.pending()?.states.chatgpt.outcome?.code ?? 'retired', b.pending() ? 'tab_discarded' : 'retired');
    assert.ok(b.calls.some(c => c.action === 'failure' && /tab_discarded/.test(c.error)), 'the failure is delivered, not waited on forever');
    for (let i = 0; i < 3 && b.pending(); i++) { advance(3 * 60_000);await b.tick(); }
    assert.equal(b.pending(), undefined, 'retired: its capacity slot is released');
    assert.deepEqual(reloads, [], 'never reloaded');assert.deepEqual(b.closedTabs, [], 'never closed');
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' || m.type === 'ashlar-harvest'), [], 'nothing was sent to the tab');
  });
}
// Ashlar 4101062732: an unpinned review verdict holds only on the new chat the tab was opened on. The
// page the run last answered on (state.pageUrl) is no identity: it can be the user's own conversation.
for (const [where, url, closed] of [['a page that left its new chat', 'https://chatgpt.com/c/users-own', false], ['its new chat (control)', TEMP, true]]) {
  test(`review: an unpinned "owned" verdict from ${where} is ${closed ? 'closed' : 'preserved, never closed'}`, async () => {
    const b = worker(leg('review', {...secured('review'), pageUrl: url}), {tab: {id: 10, url, status: 'complete'},
      handler: (_id, m) => (m.type === 'ashlar-can-close' ? {ok: true, releaseProtocol: 1, ownership: 'owned', unpinned: true, url} : {ok: true})});
    await b.tick();
    assert.equal(b.pending(), undefined, 'retired');
    assert.deepEqual(b.closedTabs, closed ? [10] : []);
    if (!closed) assert.ok(uploaded(b).includes('worker:preserve_navigated'), `${uploaded(b)}`);
  });
}
test('worker status lists the recently retired legs (closed and preserved) with metadata only', async () => {
  const closedJob = leg('review', secured('review'));
  const keptJob = {...leg('fix', secured('fix')), states: {chatgpt: {...leg('fix', secured('fix')).states.chatgpt, tabId: 11}}};
  const tabs = new Map([[10, {id: 10, url: URL_TAB, status: 'complete'}], [11, {id: 11, url: URL_TAB, status: 'complete'}]]);
  const api = async (_path, body) => (body?.action === 'ping' ? {ok: true, active: true, accepted: true, status: 'awaiting_chat'} : {ok: true, job: null});
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {[closedJob.jobId]: closedJob, [keptJob.jobId]: keptJob}}), tabs, api,
    handler: (id, m) => (m.type !== 'ashlar-can-close' ? {ok: true} : id === 10 ? owned : {ok: true, releaseProtocol: 1, ownership: 'takenOver', cause: 'draft', url: URL_TAB})});
  b.context.crypto = webcrypto;
  await b.tick();await b.tick();
  const retired = b.local.state.bridgeWorkerStatus.retired;
  const byJob = Object.fromEntries(retired.map(r => [r.jobId, r]));
  assert.deepEqual({kind: byJob['job-A'].kind, tabId: byJob['job-A'].tabId, stage: byJob['job-A'].stage, cause: byJob['job-A'].cause}, {kind: 'review', tabId: 10, stage: 'tab_closed', cause: undefined});
  assert.deepEqual({kind: byJob['fix-A'].kind, tabId: byJob['fix-A'].tabId, stage: byJob['fix-A'].stage, cause: byJob['fix-A'].cause}, {kind: 'fix', tabId: 11, stage: 'tab_preserved', cause: 'draft'});
  assert.equal(typeof byJob['fix-A'].note, 'string');
  assert.doesNotMatch(JSON.stringify(retired), /PROMPT|https?:/, 'no prompt or URL text');
  assert.deepEqual(b.closedTabs, [10]);
});
// Ashlar 4101062777: the ring is shared by every bridge origin the worker has served, but the popup
// shows the worker status of the configured origin only: each entry names its origin, and a status
// lists that origin's entries alone.
test('the recently retired legs in a worker status are those of its own origin', async () => {
  const b = worker(leg('review', secured('review')), {handler: () => owned});
  await b.tick();
  assert.equal(b.pending(), undefined, 'job-A retired under http://bridge');
  // The user points the extension at another bridge, where job-B then retires.
  b.local.state.origin = 'http://other';
  await b.context.rememberRetired({origin: 'http://other', jobId: 'job-B', providers: ['chatgpt'], states: {chatgpt: {tabId: 12, preserveCause: 'draft'}}});
  const statusFor = async origin => { await b.context.recordWorkerStatus({}, origin); return b.local.state.bridgeWorkerStatus; };
  const other = await statusFor('http://other');
  assert.deepEqual({origin: other.origin, jobs: other.retired.map(r => r.jobId)}, {origin: 'http://other', jobs: ['job-B']}, 'B lists none of A\'s legs');
  const bridge = await statusFor('http://bridge');
  assert.deepEqual({origin: bridge.origin, jobs: bridge.retired.map(r => r.jobId)}, {origin: 'http://bridge', jobs: ['job-A']}, 'back on A: A\'s legs only');
  assert.doesNotMatch(JSON.stringify(bridge.retired), /https?:/, 'the entries shown carry no URL (the status names its origin)');
});
// Ashlar 4101062782: "Clear stuck jobs" abandons every leg of a cancelled or forgotten job, and a live
// tab is released by its page's verdict (closed unless the user took it over). The popup's report
// and its help text say so; they no longer claim that jobs with a live tab are left alone.
test('the popup describes what Clear stuck did to a forgotten job\'s live tab', async () => {
  const b = worker(leg('review', {}, {serverStatus: 'missing'}), {status: 'missing', handler: () => owned});
  const elements = new Map();
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {textContent: '', value: '', addEventListener() {}});
    return elements.get(id);
  }};
  const context = vm.createContext({document, console, setTimeout, chrome: {
    storage: {local: storage({origin: 'http://bridge', enabled: true}), onChanged: {addListener() {}}},
    runtime: {getManifest: () => ({version: 'test'}), sendMessage: async message => (message.type === 'ashlar-clear-stuck' ? b.context.clearStuckJobs({includeStalled: true}) : undefined)},
  }});
  vm.runInContext(source('extension/popup.js'), context);
  await vm.runInContext('requestClearStuck()', context);
  assert.deepEqual(b.closedTabs, [10], 'the forgotten job\'s live, untouched tab was closed');
  assert.equal(b.pending(), undefined, 'and the job cleared');
  const status = elements.get('status').textContent;
  assert.match(status, /^Cleared 1 /);
  assert.doesNotMatch(status, /live tab were left alone/, 'the report does not claim the live tab was left alone');
  assert.match(status, /closed unless you had used it/);
  assert.doesNotMatch(source('extension/popup.html'), /Never touches a job with a live tab/, 'nor does the button\'s help text');
});
// Ashlar 4101062772: the ring is diagnostics only; it is written inside the retirement's storage
// sequence, so a failed ring write must not leave the cleaned job in the registry (retried as
// recovery work, holding a capacity slot).
for (const failing of ['set', 'get']) test(`a cleaned job retires even when the recent-retired ring ${failing === 'set' ? 'write' : 'read'} fails`, async () => {
  const b = worker(leg('review', secured('review')), {handler: () => owned});
  const {get, set} = b.local;
  if (failing === 'set') b.local.set = async values => { if ('bridgeRecentRetired' in values) throw new Error('QUOTA_BYTES quota exceeded'); return set(values); };
  else b.local.get = async keys => { if ([].concat(keys ?? []).includes('bridgeRecentRetired')) throw new Error('storage unavailable'); return get(keys); };
  await b.tick();
  assert.deepEqual(b.closedTabs, [10], 'the secured tab is closed');
  assert.equal(b.pending(), undefined, 'the job is removed from pendingReviewJobs: capacity released');
  assert.equal(b.local.state.bridgeRecentRetired, undefined, 'the diagnostic entry is lost, nothing else');
});

// ── tab_lost (#82 step 0): tab_closed in review history says the worker closed the tab. A tab that is
// gone otherwise (the user or the browser closed it, its creation is unknown, or it can no longer be
// found) ends as tab_lost: a leg whose tab Chrome replaced was recorded as closed while it leaked.
// A leg that never had a tab records no tab step at all (a tab that never existed was not lost).
// (spread: the stages come from the worker's realm)
const historyOf = b => [...(b.pending() ? stagesOf(b.pending().states.chatgpt.workerEvents) : uploaded(b))].filter(stage => /^worker:tab_(closed|lost|preserved)$/.test(stage));
const unableToEdit = () => { throw new Error('Tabs cannot be edited right now (user may be dragging a tab).'); };
for (const kind of ['review', 'fix']) {
  const cancelledBeforeATab = {delivered: true, cleanupPending: true, abandoned: true, abandonedAs: 'cancelled', started: false, tabId: undefined};
  const ABSENT = [
    ['an abandoned leg whose tab is gone', {delivered: true, cleanupPending: true, abandoned: true, abandonedAs: 'cancelled'}, 'cancelled'],
    ['a leg whose tab a sweep confirmed absent (closeRequested, never closed by the worker)', {...secured(kind), closeRequested: true}, 'awaiting_chat'],
    ['a leg cancelled while its tab creation outcome was unknown (allocating)', {...cancelledBeforeATab, allocating: true}, 'cancelled'],
    ['a leg whose tab id was dropped after it opened a tab', {...cancelledBeforeATab, workerSequence: 1, workerEvents: [{source: 'worker', sequence: 1, stage: 'tab_created', at: 1}]}, 'cancelled'],
  ];
  for (const [what, state, status] of ABSENT) {
    test(`${kind}: ${what} retires as tab_lost, not tab_closed`, async () => {
      const b = worker(leg(kind, state, status === 'cancelled' ? {serverStatus: 'cancelled'} : {}), {status, tab: null});
      await b.tick();
      assert.equal(b.pending(), undefined, 'retired');
      assert.deepEqual(historyOf(b), ['worker:tab_lost']);
      assert.equal((b.local.state.bridgeRecentRetired || []).find(entry => entry.jobId === leg(kind).jobId)?.stage, 'tab_lost');
    });
  }
  test(`${kind}: a leg cancelled while it waited for capacity (it never had a tab) retires with no tab step`, async () => {
    const b = worker(leg(kind, cancelledBeforeATab, {serverStatus: 'cancelled'}), {status: 'cancelled', tab: null});
    await b.tick();
    assert.equal(b.pending(), undefined, 'retired');
    assert.deepEqual([...uploaded(b)].filter(stage => /^worker:(tab_|cleanup_)/.test(stage)), [], 'no tab_lost (nor cleanup_pending) for a tab that never existed');
    assert.doesNotMatch((b.local.state.bridgeRecentRetired || []).find(entry => entry.jobId === leg(kind).jobId)?.stage ?? '-', /^(tab_|cleanup_)/);
  });
  test(`${kind}: a leg that hit a usage limit before it opened a tab retires with no tab step; its last step is its saved result`, async () => {
    const b = worker(leg(kind, {started: false, tabId: undefined}), {tab: null});
    b.local.state.quota = {chatgpt: Date.now() + 60 * 60_000};
    for (let i = 0; i < 4 && b.pending(); i++) await b.tick();
    assert.equal(b.pending(), undefined, 'retired');assert.equal(b.tabs.size, 0, 'no tab was opened');
    assert.ok(b.calls.some(call => call.action === 'failure' && /^quota:/.test(call.error)), 'the usage limit reached the server');
    assert.deepEqual([...uploaded(b)].filter(stage => /^worker:(tab_|cleanup_)/.test(stage)), [], 'no tab_lost (nor cleanup_pending) for a tab that never existed');
    assert.equal(uploaded(b).at(-1), 'worker:result_saved');
    assert.equal((b.local.state.bridgeRecentRetired || []).find(entry => entry.jobId === leg(kind).jobId)?.stage, 'result_saved');
  });
  test(`${kind}: a tab the user closed retires as tab_lost`, async () => {
    const b = worker(leg(kind, secured(kind)), {session: createdHere(kind), handler: () => owned});
    await b.closeTab(10);
    await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, []);
    assert.deepEqual(historyOf(b), ['worker:tab_lost']);
  });
  test(`${kind}: control: a close the worker issued before it stopped retires by absence as tab_closed`, async () => {
    const b = worker(leg(kind, {...secured(kind), closeRequested: true, closeIssued: true}), {tab: null});
    await b.tick();
    assert.equal(b.pending(), undefined);
    assert.deepEqual(historyOf(b), ['worker:tab_closed']);
  });
  test(`${kind}: a remove that failed is not the worker's close: the tab the user then closes is tab_lost`, async () => {
    const b = worker(leg(kind, {...secured(kind), conversation: URL_TAB}), {session: createdHere(kind), handler: () => owned});
    const remove = b.chrome.tabs.remove;
    b.chrome.tabs.remove = unableToEdit;
    await b.tick();
    assert.ok(b.pending(), 'not closed yet');assert.equal(b.pending().states.chatgpt.closeIssued, undefined);
    b.chrome.tabs.remove = remove;
    await b.closeTab(10);
    await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, []);
    assert.deepEqual(historyOf(b), ['worker:tab_lost']);
  });
  // A write the close makes before its remove fails (a storage quota, a transient error): no remove
  // was issued, so the tab the user then closes is not the worker's close either.
  const failsOnce = (store, failing) => { const set = store.set;let failed = false;
    store.set = async values => { if (!failed && failing(values)) { failed = true;throw new Error('QUOTA_BYTES quota exceeded'); } return set(values); };
    return () => failed; };
  const WRITES = [
    ['the closing ownership record', b => failsOnce(b.session, values => values['ashlar:tab:10']?.closing === true)],
    ['the leg registry', b => failsOnce(b.local, values => values.pendingReviewJobs?.[leg(kind).jobId]?.states?.chatgpt?.closeIssued === true)],
  ];
  for (const [write, failing] of WRITES) {
    test(`${kind}: a close whose write of ${write} failed before its remove is not the worker's close: the tab the user then closes is tab_lost`, async () => {
      const b = worker(leg(kind, {...secured(kind), conversation: URL_TAB}), {session: createdHere(kind), handler: () => owned});
      const failed = failing(b);
      await b.tick();
      assert.ok(failed(), `the write of ${write} failed`);assert.deepEqual(b.closedTabs, [], 'no remove was issued');
      assert.ok(b.pending(), 'not closed yet');assert.equal(b.pending().states.chatgpt.closeIssued, undefined);
      await b.closeTab(10);
      await b.tick();
      assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, []);
      assert.deepEqual(historyOf(b), ['worker:tab_lost']);
    });
  }
  test(`${kind}: control: a remove that failed once and then succeeded is tab_closed`, async () => {
    const b = worker(leg(kind, {...secured(kind), conversation: URL_TAB}), {session: createdHere(kind), handler: () => owned});
    const remove = b.chrome.tabs.remove;
    b.chrome.tabs.remove = unableToEdit;
    await b.tick();
    b.chrome.tabs.remove = remove;
    await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, [10]);
    assert.deepEqual(historyOf(b), ['worker:tab_closed']);
  });
}
test('review: a durably archived leg whose tab is gone releases it as tab_lost', async () => {
  const b = worker(leg('review', {sourceCapture: archived}, {captureProtocol: 1}), {tab: null});
  const jobs = await b.jobs();
  await b.context.cleanupProvider(jobs['job-A'], 'chatgpt', jobs);
  assert.equal(jobs['job-A'].states.chatgpt.cleanupDone, true, 'released: repair no longer needs the tab');
  assert.deepEqual([...stagesOf(jobs['job-A'].states.chatgpt.workerEvents)].filter(stage => /^worker:tab_/.test(stage)), ['worker:tab_lost']);
});

// ── onReplaced (#82 step 0): Chrome can swap a tab's page into a new tab id (a discard while its
// WebContentsDiscard study is off): onReplaced(added, removed) fires and onRemoved does not. The leg
// follows its tab; a leg that already released its tab is not revived by it.
/** A discarded (or not yet loaded) tab holds no page: nothing answers in it and nothing is injected. */
function noPageWhileDiscarded(b) {
  const send = b.chrome.tabs.sendMessage;
  b.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (!b.tabs.get(id)?.discarded) return send(id, msg, cb);
    b.messages.push({id, ...msg});b.chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};cb();b.chrome.runtime.lastError = null;
  };
  b.chrome.scripting.executeScript = async ({target}) => { if (b.tabs.get(target.tabId)?.discarded) throw new Error('Cannot access contents of the page'); };
}
test('the onReplaced listener is registered at the worker\'s top level (a replace never fires onRemoved)', () => {
  assert.match(source('extension/background.js'), /^chrome\.tabs\.onReplaced\.addListener\(\(added, removed\) => rekeyReplacedTab\(added, removed\)\);/m);
  assert.match(source('extension/background.js'), /^chrome\.tabs\.onRemoved\.addListener\(\(id, info\) => rememberClosedTab\(id, info\)\);/m);
});
// The tab queue (#85): the listeners record the fact in memory and queue its operation. They return
// nothing (Chrome never waits for a listener, and the worker's own close runs inside an operation
// that must not wait for the one it queues).
test('the replace and remove listeners return nothing: their operations are queued, never awaited', async () => {
  const b = worker(leg('review'), {session: createdHere('review'), tab: {id: 10, url: URL_TAB, status: 'complete'}});
  b.tabs.delete(10);b.tabs.set(11, {id: 11, url: URL_TAB, status: 'complete'});
  assert.equal(b.context.rekeyReplacedTab(11, 10), undefined);
  assert.equal(b.context.liveTabId(10), 11, 'the replace is known at once');
  assert.equal(b.context.rememberClosedTab(11, {isWindowClosing: false}), undefined);
  await b.queueIdle();
  assert.deepEqual(b.effects.filter(e => e.kind !== undefined), [], 'no tab effect');
  assert.equal(b.session.state['ashlar:closed:job-A:chatgpt:run-A'], true, 'the removal applied after the re-key');
});
for (const kind of ['review', 'fix']) {
  test(`${kind}: a secured leg whose tab Chrome replaced on discard follows it: woken under the new id, then closed`, async () => {
    const b = worker(leg(kind, {...secured(kind), conversation: TEMP, pageUrl: TEMP}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: blankVerdict});
    noPageWhileDiscarded(b);
    const reloads = [];
    b.chrome.tabs.reload = async id => { reloads.push(id); Object.assign(b.tabs.get(id), {discarded: false, status: 'loading'}); };
    await b.replaceTab(10, {id: 11, url: TEMP, status: 'unloaded', discarded: true});
    const state = b.pending().states.chatgpt;
    assert.equal(state.tabId, 11, 'the leg follows its tab');
    assert.ok(stagesOf(state.workerEvents).includes('worker:tab_rekeyed'), 'the replace reaches history');
    assert.equal(b.session.state['ashlar:tab:11']?.jobId, leg(kind).jobId, 'the ownership record names the new id');
    await b.tick();
    assert.deepEqual(reloads, [11], 'woken: the tab is still the one this browser session created for the leg');
    b.tabs.get(11).status = 'complete';
    await b.tick();
    assert.deepEqual(b.closedTabs, [11], 'closed on its page\'s verdict, not leaked');
    assert.equal(b.pending(), undefined);
    assert.ok(uploaded(b).includes('worker:tab_closed'), `${uploaded(b)}`);
  });
  test(`${kind}: an undispatched leg whose tab Chrome replaced sends its prompt into that tab, not a new one`, async () => {
    // An unbound page answers with no binding: only the creation record proves the tab is the leg's.
    const unbound = (_id, m) => (m.type === 'ashlar-run' ? {ok: false, code: 'busy', retry: true} : {ok: false, code: 'idle', jobId: '', runId: '', provider: 'chatgpt'});
    const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: unbound});
    await b.replaceTab(10, {id: 11, url: TEMP, status: 'complete'});
    await b.tick();
    const runs = b.messages.filter(m => m.type === 'ashlar-run');
    assert.deepEqual(runs.map(m => [m.id, m.prompt]), [[11, 'PROMPT']], 'dispatched once, into the replaced tab');
    assert.equal(b.pending().states.chatgpt.started, true);
    assert.equal(b.tabs.size, 1, 'no second tab was opened for the leg');
  });
}
test('fix: a created fix delivery record follows its tab (it keeps proving that tab)', async () => {
  const b = worker(leg('fix', {}, {deliveryId: 'delivery-A'}), {session: createdHere('fix')});
  b.local.state['ashlar:fixDeliveries'] = {'fix-A': {deliveryId: 'delivery-A', provider: 'chatgpt', phase: 'created', tabId: 10, at: Date.now()}};
  await b.replaceTab(10, {id: 11, url: URL_TAB, status: 'complete'});
  assert.equal(b.local.state['ashlar:fixDeliveries']['fix-A'].tabId, 11);
});
test('review: a leg that already released its tab is not revived by a replace; its preserved backstop follows the tab', async () => {
  // Released while its repair continues: the original is archived, the tab was kept for the user.
  const released = {sourceCapture: archived, cleanupDone: true, cleanupPending: false, preserveCause: 'draft',
    workerSequence: 1, workerEvents: [{source: 'worker', sequence: 1, stage: 'tab_preserved', at: 1}]};
  const backstop = 'ashlar:preserved:job-A:chatgpt:run-A';
  const b = worker(leg('review', released, {captureProtocol: 1}), {session: storage({[backstop]: {tabId: 10}}),
    handler: (_id, m) => (m.type === 'ashlar-tab-status' ? {ok: true, ownershipProtocol: 1, jobId: 'job-A', runId: 'run-A', provider: 'chatgpt', released: false, url: URL_TAB} : {ok: true})});
  await b.replaceTab(10, {id: 11, url: URL_TAB, status: 'complete'});
  const state = b.pending().states.chatgpt;
  assert.equal(state.tabId, 10, 'a released leg keeps its record as it was');
  assert.deepEqual(state.workerEvents.map(e => e.stage), ['tab_preserved'], 'no tab_rekeyed after its terminal step');
  assert.equal(b.session.state['ashlar:tab:11'], undefined, 'no ownership record is created for the new id');
  assert.deepEqual(b.session.state[backstop], {tabId: 11}, 'the preserved backstop names the tab it keeps');
  await b.tick();
  assert.deepEqual(b.messages.filter(m => m.type !== 'ashlar-tab-status' && m.type !== 'ashlar-fix-cancel'), [], 'the kept tab is never asked to run or collect');
  assert.deepEqual(b.closedTabs, []);
  await b.context.refreshTabInventory();
  assert.ok(await until(() => b.messages.some(m => m.id === 11 && m.type === 'ashlar-tab-status')));
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await b.context.tabCapacityReport({})).orphanTabs, 0, 'the kept binding never becomes an orphan holding capacity');
});
test('a leg whose tab the worker closed is not revived by a late replace naming that id; its sibling is untouched', async () => {
  const job = {...leg('review', {...secured('review'), cleanupDone: true, cleanupPending: false, closeRequested: true, closeIssued: true,
    workerSequence: 1, workerEvents: [{source: 'worker', sequence: 1, stage: 'tab_closed', at: 1}]}), providers: ['chatgpt', 'grok']};
  job.states.grok = {tabId: 20, started: true, runId: 'run-B'};
  const b = worker(job, {tab: {id: 20, url: 'https://grok.com/c/managed', status: 'complete'}});
  await b.replaceTab(10, {id: 11, url: URL_TAB, status: 'complete'});
  const states = b.pending().states;
  assert.equal(states.chatgpt.tabId, 10);assert.deepEqual(states.chatgpt.workerEvents.map(e => e.stage), ['tab_closed']);
  assert.equal(states.grok.tabId, 20);assert.equal(states.grok.workerEvents, undefined);
});
// Ashlar 4101062763: Chrome fires A -> B and then B -> C before the first re-key's storage round trips
// finished. Re-keys run in the tab queue in the order Chrome reported them, and each moves its records
// to the END of the chain known when it runs, so nothing is left naming the dead intermediate id B;
// operations that look B up meanwhile are told the tab lives on (replacedSince).
test('back-to-back replaces (A -> B -> C, the first still recording) end at C: the leg and its ownership, preserved and fix delivery records', async () => {
  const backstop = 'ashlar:preserved:fix-A:chatgpt:run-A';
  const session = createdHere('fix');session.state[backstop] = {tabId: 10};
  const b = worker(leg('fix', {}, {deliveryId: 'delivery-A'}), {session, tab: {id: 10, url: TEMP, status: 'complete'}});
  b.local.state['ashlar:fixDeliveries'] = {'fix-A': {deliveryId: 'delivery-A', provider: 'chatgpt', phase: 'created', tabId: 10, at: Date.now()}};
  const state = (await b.jobs())['fix-A'].states.chatgpt;
  // The first re-key's first storage read is held until the second replace has been dispatched.
  const get = b.session.get;let release, first = true;const gate = new Promise(resolve => { release = resolve; });
  b.session.get = async keys => { if (keys == null && first) { first = false;await gate; } return get(keys); };
  b.tabs.delete(10);b.tabs.set(12, {id: 12, url: TEMP, status: 'complete'});
  b.context.rekeyReplacedTab(11, 10);
  b.context.rekeyReplacedTab(12, 11);
  for (let i = 0; i < 10; i++) await flush();
  assert.ok(b.context.replacedSince(state, 10) && b.context.replacedSince(state, 11), 'A and B are covered while the chain settles');
  release();
  await b.queueIdle();
  assert.ok(b.context.replacedSince(state, 11), 'B is never taken for a tab that is gone');
  assert.equal(state.tabId, 12, 'the leg names the live tab');
  assert.equal(b.pending().states.chatgpt.tabId, 12, 'persisted');
  assert.deepEqual({jobId: b.session.state['ashlar:tab:12']?.jobId, replacedBy: b.session.state['ashlar:tab:12']?.replacedBy}, {jobId: 'fix-A', replacedBy: undefined}, 'the ownership record names C');
  assert.equal(b.session.state['ashlar:tab:10']?.replacedBy, 12, 'A\'s record says where its tab went');
  assert.deepEqual(b.session.state[backstop], {tabId: 12}, 'the preserved record names C');
  assert.equal(b.local.state['ashlar:fixDeliveries']['fix-A'].tabId, 12, 'the fix delivery record names C');
  assert.equal(b.context.replacedSince(state, 12), false, 'settled');
});
// A record written under an id Chrome already replaced (here the allocation's first records: the
// replace reached the worker before chrome.tabs.create's reply was handled) follows the chain too.
for (const kind of ['review', 'fix']) {
  test(`${kind}: an allocation whose new tab Chrome replaced before its records were written dispatches into the live tab, never a second one`, async () => {
    const unbound = (_id, m) => (m.type === 'ashlar-run' ? {ok: false, code: 'busy', retry: true} : {ok: false, code: 'idle', jobId: '', runId: '', provider: 'chatgpt'});
    const b = worker(leg(kind, {started: false, tabId: undefined}), {tab: null, handler: unbound});
    const create = b.chrome.tabs.create;
    b.chrome.tabs.create = async options => {
      const tab = await create(options);
      b.tabs.delete(tab.id);b.tabs.set(tab.id + 1000, {...tab, id: tab.id + 1000});
      await b.context.rekeyReplacedTab(tab.id + 1000, tab.id);
      return tab;
    };
    await b.tick();await b.tick();
    const live = [...b.tabs.keys()];
    assert.equal(live.length, 1, 'no second tab was opened for the leg');
    assert.equal(b.pending().states.chatgpt.tabId, live[0], 'the leg names the live tab');
    assert.equal(b.session.state[`ashlar:tab:${live[0]}`]?.jobId, leg(kind).jobId, 'its creation record follows it');
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' && !m.resume).map(m => m.id), [live[0]], 'dispatched once, into the live tab');
  });
}
/** Chrome already swapped tab 10's page into `tab`, but the onReplaced event reaches the worker only
 * while it searches for the leg's tab (findOriginalTab's query), after the old id's lookup failed.
 * Dispatched as the real listener does it: its re-key is queued behind the running operation
 * (`b.rekeyed` settles once the queue ran it), so the search ends before the re-key moved the leg. */
function replacedDuringLookup(b, tab) {
  b.tabs.delete(10);b.tabs.set(tab.id, tab);
  const query = b.chrome.tabs.query;let delivered = false;
  b.chrome.tabs.query = async filter => {
    if (filter?.url && !delivered) { delivered = true;b.context.rekeyReplacedTab(tab.id, 10);b.rekeyed = b.queueIdle(); }
    return query(filter);
  };
}
for (const kind of ['review', 'fix']) {
  test(`${kind}: a cancelled leg whose tab Chrome replaced during its cleanup's lookup is not retired as lost; it ${kind === 'fix' ? 'keeps the tab under its new id (a cancelled fix is never closed, #77)' : 'closes the tab under its new id'}`, async () => {
    const b = worker(leg(kind, {pageUrl: TEMP}), {status: 'cancelled', session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: blankVerdict});
    noPageWhileDiscarded(b);
    b.chrome.tabs.reload = async id => { Object.assign(b.tabs.get(id), {discarded: false, status: 'loading'}); };
    replacedDuringLookup(b, {id: 11, url: TEMP, status: 'unloaded', discarded: true});
    await b.tick();
    assert.ok(b.pending(), 'not retired: the tab is not absent, it has a new id');
    assert.deepEqual(historyOf(b), [], 'no tab_lost');
    await b.rekeyed;
    assert.equal(b.pending().states.chatgpt.tabId, 11);
    await b.tick();
    if (kind === 'fix') {
      assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, [], 'kept, not leaked: its binding is released');
      assert.ok(b.session.state['ashlar:preserved:fix-A:chatgpt:run-A']?.tabId === 11, 'the preserved backstop names the new id');
      assert.deepEqual(historyOf(b), ['worker:tab_preserved']);
      return;
    }
    b.tabs.get(11).status = 'complete';
    await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, [11], 'closed, not leaked');
    assert.deepEqual(historyOf(b), ['worker:tab_closed']);
  });
  test(`${kind}: a stalled leg whose tab Chrome replaced during the sweep's lookup is not gone`, async () => {
    const b = worker(leg(kind, {}), {session: createdHere(kind), tab: {id: 10, url: URL_TAB, status: 'complete'}});
    noPageWhileDiscarded(b);
    replacedDuringLookup(b, {id: 11, url: URL_TAB, status: 'unloaded', discarded: true});
    const jobs = await b.jobs();
    assert.equal(await b.context.providerTabGone(jobs[leg(kind).jobId], 'chatgpt'), false, 'the sweep keeps a leg whose tab lives on');
    await b.rekeyed;
    assert.equal(jobs[leg(kind).jobId].states.chatgpt.tabId, 11);
  });
  // CE-3: the lookup of a stalled leg's tab (findOriginalTab) skips a page that does not answer in
  // time or is backed off. That page may hold the leg's run: "unknown", never "gone".
  test(`${kind}: the stalled-job sweep keeps a leg whose run may be in a provider tab that did not answer`, async () => {
    const quiet = {workerSequence: 1, workerEvents: [{source: 'worker', sequence: 1, stage: 'run_dispatched', at: 1}]};
    const b = worker(leg(kind, quiet), {tab: null});
    b.tabs.set(20, {id: 20, url: 'https://chatgpt.com/c/elsewhere', status: 'complete'}); // the leg's tab 10 is gone
    // tab 20's page never answers
    b.chrome.tabs.sendMessage = (id, msg) => { b.messages.push({id, ...msg}); };
    b.context.pageReplyDeadline = expiresAtOnce;
    assert.equal((await b.context.clearStuckJobs({includeStalled: true, staleMs: 1})).ok, true);
    assert.ok(b.messages.some(m => m.id === 20 && m.type === 'ashlar-harvest'), 'the provider tab was asked');
    assert.equal(b.calls.some(c => c.action === 'failure'), false, 'no "tab closed" failure while that tab may hold the run');
    assert.equal(b.pending().states.chatgpt.outcome, undefined);
    // Swept again within the page's back-off: still unknown, not gone.
    assert.equal((await b.context.clearStuckJobs({includeStalled: true, staleMs: 1})).ok, true);
    assert.equal(b.calls.some(c => c.action === 'failure'), false);
    assert.equal(b.pending().states.chatgpt.outcome, undefined);
  });
  test(`${kind}: control: the stalled-job sweep settles a leg whose tab is gone when every provider page answers for another run`, async () => {
    const quiet = {workerSequence: 1, workerEvents: [{source: 'worker', sequence: 1, stage: 'run_dispatched', at: 1}]};
    const b = worker(leg(kind, quiet), {tab: null, handler: () => ({ok: false, code: 'job_mismatch', jobId: 'job-other', runId: 'run-other', provider: 'chatgpt'})});
    b.tabs.set(20, {id: 20, url: 'https://chatgpt.com/c/elsewhere', status: 'complete'});
    assert.equal((await b.context.clearStuckJobs({includeStalled: true, staleMs: 1})).ok, true);
    assert.ok(b.calls.some(c => c.action === 'failure' && /^tab_closed: /.test(c.error)), 'the stalled leg is settled');
  });
  // A re-key that failed (its storage round trips) is applied again by the leg's next operation
  // (applyPendingReplace): the leg still follows its tab, never retired as lost while it lives on.
  test(`${kind}: a replace whose re-key failed is applied by the leg's next operation; the leg follows its tab, never retired as lost`, async () => {
    const b = worker(leg(kind, {pageUrl: TEMP}), {status: 'cancelled', session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: blankVerdict});
    noPageWhileDiscarded(b);
    b.chrome.tabs.reload = async id => { Object.assign(b.tabs.get(id), {discarded: false, status: 'loading'}); };
    const move = b.context.moveReplacedTab;let failures = 0;
    b.context.moveReplacedTab = async (...args) => { if (!failures++) throw new Error('storage unavailable'); return move(...args); };
    replacedDuringLookup(b, {id: 11, url: TEMP, status: 'unloaded', discarded: true});
    await b.tick();
    assert.ok(b.pending(), 'not retired: the tab has a new id');
    await b.rekeyed;
    assert.equal(failures, 1, 'the queued re-key failed');
    assert.equal(b.pending().states.chatgpt.tabId, 10, 'nothing moved the leg yet');
    await b.tick();
    assert.equal(b.pending()?.states.chatgpt.tabId ?? 11, 11, 'the next operation moved it');
    if (kind === 'fix') {
      assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, [], 'kept (#77), not lost');
      assert.deepEqual(historyOf(b), ['worker:tab_preserved']);
      return;
    }
    b.tabs.get(11).status = 'complete';
    await b.tick();
    assert.equal(b.pending(), undefined);assert.deepEqual(b.closedTabs, [11], 'closed under its new id, not lost');
    assert.deepEqual(historyOf(b), ['worker:tab_closed']);
  });
}
for (const kind of ['review', 'fix']) {
  test(`${kind}: an undispatched leg whose tab is replaced while it reads its creation record still sends into that tab`, async () => {
    const unbound = (_id, m) => (m.type === 'ashlar-run' ? {ok: false, code: 'busy', retry: true} : {ok: false, code: 'idle', jobId: '', runId: '', provider: 'chatgpt'});
    const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: unbound});
    // Chrome swaps the tab, and the worker receives onReplaced while the poll reads the old id's record.
    const get = b.session.get;let delivered = false;
    b.session.get = async keys => {
      if (!delivered && [].concat(keys ?? []).includes('ashlar:tab:10')) {
        delivered = true;b.tabs.delete(10);b.tabs.set(11, {id: 11, url: TEMP, status: 'complete'});
        await b.context.rekeyReplacedTab(11, 10);
      }
      return get(keys);
    };
    await b.tick();await b.tick();
    assert.ok(delivered, 'the replace raced the record read');
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' && !m.resume).map(m => m.id), [11], 'dispatched once, into the replaced tab');
    assert.equal(b.tabs.size, 1, 'no second tab was opened for the leg');
  });
}
for (const kind of ['review', 'fix']) {
  test(`${kind}: a poll that runs while a replace is being recorded never sees the new id without its creation record`, async () => {
    const unbound = (_id, m) => (m.type === 'ashlar-run' ? {ok: false, code: 'busy', retry: true} : {ok: false, code: 'idle', jobId: '', runId: '', provider: 'chatgpt'});
    const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: unbound});
    // The re-key is held while it writes the new id's records; a tick runs meanwhile.
    const set = b.session.set;let release, held = false;const gate = new Promise(resolve => { release = resolve; });
    b.session.set = async values => { if ('ashlar:tab:11' in values) { held = true;await gate; } return set(values); };
    b.tabs.delete(10);b.tabs.set(11, {id: 11, url: TEMP, status: 'complete'});
    b.context.rekeyReplacedTab(11, 10);
    assert.ok(await until(() => held), 'the re-key is writing its records');
    // The tick's poll waits in the tab queue behind the re-key.
    const ticking = b.tick();
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(b.messages.some(m => m.type === 'ashlar-run'), false, 'nothing is dispatched while the re-key runs');
    release();await ticking;await b.queueIdle();
    await b.tick();
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' && !m.resume).map(m => m.id), [11], 'dispatched once, into the replaced tab');
    assert.equal(b.tabs.size, 1, 'no second tab was opened for the leg');
  });
}
for (const kind of ['review', 'fix']) {
  test(`${kind}: an allocation recovered after its tab was replaced takes the tab's current id, not the replaced one`, async () => {
    // The worker stopped right after chrome.tabs.create (its tab id never reached the registry), and
    // Chrome replaced that tab before the worker polled the leg again.
    const unbound = (_id, m) => (m.type === 'ashlar-run' ? {ok: false, code: 'busy', retry: true} : {ok: false, code: 'idle', jobId: '', runId: '', provider: 'chatgpt'});
    const job = leg(kind, {started: false, tabId: undefined, allocating: true}, kind === 'fix' ? {deliveryId: 'delivery-A'} : {});
    const b = worker(job, {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: unbound});
    if (kind === 'fix') b.local.state['ashlar:fixDeliveries'] = {'fix-A': {deliveryId: 'delivery-A', provider: 'chatgpt', phase: 'created', tabId: 10, at: Date.now()}};
    await b.replaceTab(10, {id: 11, url: TEMP, status: 'complete'});
    await b.tick();
    assert.equal(b.pending().states.chatgpt.tabId, 11);
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run' && !m.resume).map(m => m.id), [11], 'dispatched into the replaced tab');
    assert.equal(b.tabs.size, 1, 'no second tab was opened for the leg');
  });
}
// Ashlar 4101623043: moveReplacedTab writes the replacement's creation record, and marks the old id's
// record replacedBy, before it saves the leg's new id. A worker that stops in between restarts with
// the leg naming the dead id A while the session records name the live tab B. The leg follows that
// durable chain (the poll, the cleanup and the sweep), and the old id's tombstone never proves that A
// is still the leg's tab.
const tombstoned = kind => {
  const record = createdHere(kind).state['ashlar:tab:10'];
  return storage({'ashlar:tab:10': {...record, replacedBy: 11}, 'ashlar:tab:11': record});
};
const unboundPage = kind => (_id, m) => {
  if (m.type === 'ashlar-run') return {ok: false, code: 'busy', retry: true};
  if (m.type === 'ashlar-fix-cancel' && m.undispatched === true) {
    return kind === 'fix' ? {ok: false, code: 'job_mismatch', jobId: '', runId: ''}
      : {ok: true, releaseProtocol: 1, owned: true, canClose: true, ownership: 'owned', blank: true, unsent: false, url: TEMP, jobId: '', runId: ''};
  }
  return {ok: false, code: 'idle', jobId: '', runId: '', provider: 'chatgpt'};
};
for (const kind of ['review', 'fix']) {
  test(`${kind}: a replaced id's creation record is a tombstone: it never proves that the old id is the leg's tab`, async () => {
    const b = worker(leg(kind, {started: false}), {session: tombstoned(kind), tab: null});
    const job = leg(kind, {started: false});
    assert.equal(await b.context.tabCreatedForLeg(job, 'chatgpt', 10), false, 'the removed id');
    assert.equal(await b.context.tabCreatedForLeg(job, 'chatgpt', 11), true, 'the id its tab lives on');
  });
  test(`${kind}: a worker restarted between a replace and its registry write dispatches the undispatched leg into the live tab, once`, async () => {
    const b = worker(leg(kind, {started: false}), {session: tombstoned(kind), tab: null, handler: unboundPage(kind)});
    b.tabs.set(11, {id: 11, url: TEMP, status: 'complete'});
    await b.tick();
    const state = b.pending().states.chatgpt;
    assert.equal(state.tabId, 11, 'the leg names the live tab (persisted)');
    assert.ok(stagesOf(state.workerEvents).includes('worker:tab_rekeyed'), 'the move reaches history');
    assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run').map(m => [m.id, m.prompt, m.resume === true]), [[11, 'PROMPT', false]], 'dispatched once, into B');
    assert.equal(b.messages.some(m => m.id === 10), false, 'the dead id is never messaged');
    assert.deepEqual([...b.tabs.keys()], [11], 'no second tab was opened for the leg');
    assert.equal(state.connectionError, undefined, 'no connection-error recovery');
  });
  test(`${kind}: a cancelled undispatched leg whose replace the registry never recorded ${kind === 'fix' ? 'keeps the live tab (#77) and fences its run there' : 'closes the live tab'}, never leaking it as absent`, async () => {
    const b = worker(leg(kind, {started: false}), {status: 'cancelled', session: tombstoned(kind), tab: null, handler: unboundPage(kind)});
    b.tabs.set(11, {id: 11, url: TEMP, status: 'complete'});
    await b.tick();
    assert.ok(b.messages.some(m => m.id === 11 && m.type === 'ashlar-fix-cancel' && m.undispatched === true), 'its unbound page is told the run was never dispatched');
    assert.deepEqual(b.closedTabs, kind === 'fix' ? [] : [11]);
    assert.equal(b.pending(), undefined, 'retired');
    assert.deepEqual(historyOf(b), [kind === 'fix' ? 'worker:tab_preserved' : 'worker:tab_closed'], 'not tab_lost');
  });
  test(`${kind}: the stalled-job sweep never takes a leg whose replace the registry never recorded for gone`, async () => {
    const quiet = {started: false, workerSequence: 1, workerEvents: [{source: 'worker', sequence: 1, stage: 'tab_created', at: 1}]};
    const b = worker(leg(kind, quiet), {session: tombstoned(kind), tab: null, handler: unboundPage(kind)});
    b.tabs.set(11, {id: 11, url: TEMP, status: 'complete'});
    assert.equal((await b.context.clearStuckJobs({includeStalled: true, staleMs: 1})).ok, true);
    assert.equal(b.calls.some(c => c.action === 'failure'), false, 'no "tab closed" failure for a tab that lives on');
    const state = b.pending().states.chatgpt;
    assert.equal(state.outcome, undefined);
    assert.equal(state.tabId, 11, 'the sweep saved the leg\'s live tab');
  });
}

// X2 (#85): a new ChatGPT prompt is typed and sent only on the new chat its tab was opened on. The
// fresh tab is active, so the user can open one of their own conversations in it before the first
// dispatch (or Chrome swaps a prerendered page of theirs in). Nothing is sent there: the leg fails
// `taken_over`, the tab is kept (never closed, never messaged) and its slot is freed at once.
const MOVED = 'https://chatgpt.com/c/users-own';
const refusedRunVerdict = cause => (_id, m) => (m.type === 'ashlar-tab-status' ? {ok: true}
  : m.type === 'ashlar-run' ? {ok: false, code: 'taken_over', cause, jobId: '', runId: '', provider: 'chatgpt'} : {ok: false, code: 'busy', retry: true});
const failureOf = b => b.calls.find(c => c.action === 'failure')?.error || '';
for (const kind of ['review', 'fix']) {
  const kept = kind === 'fix' ? 'worker:preserve_undelivered' : 'worker:preserve_navigated';
  test(`${kind}: a fresh tab the user moved to their own conversation before the dispatch gets no run message; it is kept and its slot freed`, async () => {
    const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: MOVED, status: 'complete'}, handler: blankVerdict});
    for (let i = 0; i < 3 && b.pending(); i++) await b.tick();
    assert.deepEqual(b.messages.filter(m => m.id === 10 && m.type !== 'ashlar-tab-status').map(m => m.type), [], 'the tab is never messaged');
    assert.match(failureOf(b), /^taken_over: the tab left its new chat before the prompt was sent; nothing was sent/);
    assert.deepEqual(b.closedTabs, [], 'never closed');assert.ok(b.tabs.has(10));
    assert.equal(b.pending(), undefined, 'retired: the slot is free');
    assert.ok(uploaded(b).includes('worker:taken_before_send') && uploaded(b).includes(kept), `${uploaded(b)}`);
    assert.equal((await b.context.tabCapacityReport({})).managedTabs, 0, 'the kept tab holds no review slot');
  });
  test(`${kind}: a fresh tab Chrome replaced with a page on the user's conversation (prerender) gets no run message; it is kept`, async () => {
    const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: blankVerdict});
    await b.replaceTab(10, {id: 11, url: MOVED, status: 'complete'});
    for (let i = 0; i < 3 && b.pending(); i++) await b.tick();
    assert.equal(b.messages.some(m => m.type === 'ashlar-run'), false, 'no run message to either id');
    assert.match(failureOf(b), /^taken_over: /);
    assert.deepEqual(b.closedTabs, []);assert.ok(b.tabs.has(11));
    assert.equal(b.pending(), undefined);
    assert.ok(uploaded(b).includes('worker:taken_before_send') && uploaded(b).includes(kept), `${uploaded(b)}`);
  });
  test(`${kind}: a fresh tab with a navigation pending gets no run message`, async () => {
    const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, pendingUrl: MOVED, status: 'complete'}, handler: blankVerdict});
    await b.tick();
    assert.equal(b.messages.some(m => m.type === 'ashlar-run'), false);
    assert.match(failureOf(b), /^taken_over: /);assert.deepEqual(b.closedTabs, []);
  });
  // X2-g: the page refuses the new run (its own check: off the new chat, or a user turn there). It
  // bound nothing; the leg never counts as started, fails taken_over with the page's cause, and the
  // tab is kept without another message. A fix is kept as undelivered, never closed (#77).
  for (const cause of ['navigated', 'user_turn']) {
    test(`${kind}: a new run the page refuses (${cause}) is never started; the tab is kept and never messaged again`, async () => {
      const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler: refusedRunVerdict(cause)});
      for (let i = 0; i < 3 && b.pending(); i++) await b.tick();
      assert.deepEqual(b.messages.filter(m => m.id === 10 && m.type !== 'ashlar-tab-status').map(m => m.type), ['ashlar-run'], 'one run message, nothing after the refusal');
      assert.match(failureOf(b), cause === 'user_turn' ? /^taken_over: a user message appeared in the tab before the prompt was sent/ : /^taken_over: the tab left its new chat/);
      assert.deepEqual(b.closedTabs, [], 'never closed');
      assert.equal(b.pending(), undefined, 'retired');
      assert.equal(uploaded(b).includes('worker:run_dispatched'), false, 'never recorded as dispatched');
      assert.ok(uploaded(b).includes(kind === 'fix' ? 'worker:preserve_undelivered' : `worker:preserve_${cause}`), `${uploaded(b)}`);
    });
  }
}
// X2-c, controls: a fresh tab still on its new chat is dispatched (ChatGPT's temporary chat, with or
// without its query), and so is Grok's home (Grok's fresh-page check is deferred, #82).
for (const [provider, url] of [['chatgpt', TEMP], ['chatgpt', 'https://chatgpt.com/'], ['grok', 'https://grok.com/']]) {
  test(`control: a fresh ${provider} tab on ${url} is dispatched once, with its allocation page`, async () => {
    const job = {...leg('review', {started: false}), providers: [provider], states: {[provider]: {tabId: 10, started: false, runId: 'run-A'}}};
    const session = storage({'ashlar:tab:10': {jobId: job.jobId, provider, runId: 'run-A', closedKey: `ashlar:closed:${job.jobId}:${provider}:run-A`, closing: false}});
    const b = worker(job, {session, tab: {id: 10, url, status: 'complete'}});
    await b.tick();
    const runs = b.messages.filter(m => m.type === 'ashlar-run');
    assert.deepEqual(runs.map(m => [m.id, m.allocationUrl]), [[10, provider === 'grok' ? 'https://grok.com/' : TEMP]]);
    assert.equal(b.pending().states[provider].started, true);
    assert.equal(b.calls.some(c => c.action === 'failure'), false);
  });
}

// X4 (#85): a new run message carries `until`; a page that receives it later starts nothing.
for (const kind of ['review', 'fix']) {
  test(`${kind}: a run the page refused as stale is not started; the next poll dispatches it once more, into the same tab, with a new until`, async () => {
    let refuse = true;
    const b = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'},
      handler: (_id, m) => (m.type !== 'ashlar-run' ? {ok: true}
        : refuse ? {ok: false, code: 'stale_run', retry: true, jobId: '', runId: '', provider: 'chatgpt'} : {ok: false, code: 'busy', retry: true})});
    await b.tick();
    assert.equal(b.pending().states.chatgpt.started, false, 'never counted as dispatched');
    assert.equal(uploaded(b).includes('worker:run_dispatched'), false);
    refuse = false;
    await b.tick();
    const runs = b.messages.filter(m => m.type === 'ashlar-run');
    assert.deepEqual(runs.map(m => m.id), [10, 10], 'dispatched again into the same tab, no second tab');
    assert.ok(runs.every(m => Number.isFinite(m.until) && m.until > Date.now()), 'each carries a deadline ahead');
    assert.ok(runs[1].until >= runs[0].until);
    assert.equal(b.pending().states.chatgpt.started, true);
    assert.deepEqual([...b.tabs.keys()], [10]);
    assert.equal(b.calls.some(c => c.action === 'failure'), false);
  });
}
// Ashlar 4101623037, both branches: a run message askPage gave up on reaches the page late; an
// extension reload then clears the record of the tab this session created for the leg. Exactly one
// prompt is sent across all tabs: the page that received it in time bound the run and is adopted
// (cdc0cadd); a copy that arrives after its until (here: after the reloaded worker found the tab
// unbound and opened its own) starts nothing.
for (const kind of ['review', 'fix']) for (const branch of ['in time, before the reload', 'after its until, once the leg opened its own tab']) {
  test(`${kind}: a run message delivered late (${branch}) never makes a second prompt`, async () => {
    let prompts = 0;
    const pages = new Map();
    const pageOf = id => {
      if (!pages.has(id)) { const c = content('chatgpt'); c.context.runPrompt = () => { prompts++; return new Promise(() => {}); }; pages.set(id, c); }
      return pages.get(id);
    };
    const handler = (id, m) => { let reply; pageOf(id).listeners[0](m, {}, r => { reply = r; }); return reply; };
    const b1 = worker(leg(kind, {started: false}), {session: createdHere(kind), tab: {id: 10, url: TEMP, status: 'complete'}, handler});
    b1.context.pageReplyDeadline = expiresAtOnce;
    let late;
    const send = b1.chrome.tabs.sendMessage;
    b1.chrome.tabs.sendMessage = (id, msg, cb) => { if (id === 10 && msg.type === 'ashlar-run' && !late) { late = msg; return; } return send(id, msg, cb); };
    await b1.tick();
    assert.ok(late && b1.pending().states.chatgpt.started === false, 'the dispatch was given up on');
    const deliver = () => { pageOf(10).listeners[0](late, {}, () => {}); return flush(); };
    if (branch.startsWith('in time')) await deliver();
    // The extension reloads: same registry and tabs, no record of the tab this session created.
    const b2 = worker(JSON.parse(JSON.stringify(b1.pending())), {session: storage(), tab: b1.tabs.get(10), handler});
    for (const [id, tab] of b1.tabs) b2.tabs.set(id, tab);
    for (let i = 0; i < 3; i++) await b2.tick();
    if (!branch.startsWith('in time')) {
      const RealDate = Date;
      pageOf(10).context.Date = class extends RealDate { static now() { return RealDate.now() + 60_000; } };
      await deliver();
      await b2.tick();
    }
    await flush();
    assert.equal(prompts, 1, 'exactly one prompt across all tabs');
    assert.equal(b2.pending().states.chatgpt.started, true);
    assert.equal(b2.messages.filter(m => m.type === 'ashlar-run' && m.resume !== true).length, branch.startsWith('in time') ? 0 : 1);
  });
}
