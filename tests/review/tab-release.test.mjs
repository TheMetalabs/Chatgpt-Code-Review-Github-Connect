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
import {background, storage, raw} from './helpers.mjs';

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
function worker(job, {handler, status = 'awaiting_chat', tab = {id: 10, url: URL_TAB, status: 'complete'}} = {}) {
  const tabs = new Map(tab ? [[10, tab]] : []);
  const api = async (_path, body) => (body?.action === 'ping'
    ? {ok: true, active: status === 'awaiting_chat', accepted: status === 'awaiting_chat', status, bridge: {captureProtocol: 1, localJsonRepairEnabled: false}}
    : {ok: true, job: null});
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {[job.jobId]: job}}), tabs, api, handler});
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
