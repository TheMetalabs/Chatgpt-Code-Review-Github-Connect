// Tab release (#82): once a leg's result is secured, or nobody wants it (cancelled / forgotten), its
// chat tab is closed unless the user positively took it over. These rows pin the worker side (vm
// harness) and the history diagnostics; the real-page scenarios are in tab-release.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {webcrypto} from 'node:crypto';
import {root, source} from './load-source.mjs';
import {PROGRESS_LABELS, sanitizeProgressEvents} from '../../src/lib/review-progress.ts';
import {background, storage, raw, until} from './helpers.mjs';

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
const secured = kind => ({delivered: true, cleanupPending: true, outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind]}});

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
// undispatched leg's stored id (no session record of its creation) can name the user's own tab.
for (const kind of ['review', 'fix']) {
  test(`${kind}: an undispatched leg never sends its prompt into a tab id this browser session did not create for it; it opens its own tab`, async () => {
    const b = worker(leg(kind, {started: false}), {tab: {id: 10, url: 'https://chatgpt.com/', status: 'complete'}, handler: () => ({ok: false, code: 'busy', retry: true})});
    await b.tick();
    assert.equal(b.messages.some(m => m.id === 10 && m.type === 'ashlar-run'), false, 'no prompt is sent into the reused id');
    assert.equal(b.pending().states.chatgpt.tabId, undefined, 'the stale id is dropped');
    await b.tick();
    const run = b.messages.find(m => m.type === 'ashlar-run');
    assert.ok(run && run.id !== 10 && run.prompt === 'PROMPT', 'the leg dispatched into the tab it created');
    assert.equal(b.pending().states.chatgpt.tabId, run.id);
    assert.ok(b.tabs.has(10), 'the user\'s tab is untouched');
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
for (const [kind, what, state, patch = {}] of ABANDONED_AFTER_COLLECT) {
  for (const verdict of ['owned', 'takenOver']) {
    test(`${kind}: a cancelled leg with ${what} is stopped, and its tab ${verdict === 'owned' ? 'closed as nobody\'s result' : 'kept'} by the page's verdict`, async () => {
      const page = pageExits(verdict === 'owned' ? owned : {ok: true, releaseProtocol: 1, ownership: 'takenOver', cause: 'user_turn', url: URL_TAB});
      const job = leg(kind, state, {serverStatus: 'cancelled', ...patch});
      const b = worker(job, {status: 'cancelled', handler: page.handler});
      await b.tick();
      assert.equal(page.stopped, true, 'the cancel exit stopped the page\'s run');
      assert.equal(b.messages.some(m => m.type === 'ashlar-can-close'), false);
      assert.equal(b.pending(), undefined, 'retired');
      assert.deepEqual(b.closedTabs, verdict === 'owned' ? [10] : []);
      const note = (b.local.state.bridgeRecentRetired || []).find(entry => entry.jobId === job.jobId)?.note;
      assert.equal(note, verdict === 'owned' ? 'no result wanted; tab closed' : 'the user took over the tab; tab preserved', 'a result never secured is not reported as secured');
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
// A page that accepts a release message but never runs its handler (a frozen tab, a hung page): the
// reply is bounded (pageReplyDeadline, replaced here by one that expires at once), so the cleanup
// lane is never held and the bounded ownership wait applies.
const TEMP = 'https://chatgpt.com/?temporary-chat=true';
const expiresAtOnce = () => ({promise: new Promise((_resolve, reject) => setImmediate(() => reject(new Error('the page did not answer in time')))), cancel() {}});
for (const kind of ['review', 'fix']) {
  for (const [mode, state, status] of [['secured', secured(kind), 'awaiting_chat'], ['cancelled', {}, 'cancelled']]) {
    test(`${kind}: a ${mode} leg whose page never answers the release message is preserved after the wait, never held`, async () => {
      const b = worker(leg(kind, {...state, conversation: TEMP, pageUrl: TEMP}), {status, tab: {id: 10, url: TEMP, status: 'complete'}});
      b.chrome.tabs.sendMessage = (id, msg) => { b.messages.push({id, ...msg}); }; // accepted, never answered
      b.context.pageReplyDeadline = expiresAtOnce;
      let settled = false;
      const ticked = b.tick().then(() => { settled = true; });
      assert.ok(await until(() => settled), 'the tick settles: an unanswered page does not hold the cleanup lane');
      await ticked;
      assert.ok(b.messages.some(m => m.type === (mode === 'secured' ? 'ashlar-can-close' : 'ashlar-fix-cancel')), 'the page was asked');
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
