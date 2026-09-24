// One worker, two work-item kinds: every cell of the review-vs-fix conformance table (the W rows;
// the S rows are in bridge-lease-conformance.test.mjs, the P rows in browser.e2e.mjs) runs the SAME
// scenario for a review job and a review-loop fix item. A shared cell asserts one outcome; a cell
// with an intended difference asserts each kind's documented outcome. A fix-path rule that drifts
// from the review path's proven one fails here instead of in a later review round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {background, storage, raw, flush, until} from './helpers.mjs';

const URL_TAB = 'https://chatgpt.com/c/managed';
const OTHER_TAB = 'https://chatgpt.com/c/users-own'; // a conversation the user moved the tab to
const ANSWER = {review: raw, fix: '{"summary":"guard","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}'};
const LATER_MS = 3 * 60_000; // past the fix ownership wait

function item(kind, patch = {}, state = {}) {
  return {jobId: kind === 'fix' ? 'fix-A' : 'job-A', ...(kind === 'fix' ? {kind: 'fix'} : {}), origin: 'http://bridge', leaseId: 'lease-A',
    prompt: 'PROMPT', providers: ['chatgpt'], reasoning: {chatgpt: 'pro', grok: 'heavy'},
    states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', ...state}}, ...patch};
}
function worker(kind, {job = item(kind), handler, api, status = 'complete', url = URL_TAB, session} = {}) {
  const tabs = new Map([[10, {id: 10, url, status}]]);
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {[job.jobId]: job}}), session, tabs, api, handler});
  b.context.crypto = webcrypto;b.context.TextEncoder = TextEncoder;
  b.job = job;
  b.pending = () => b.local.state.pendingReviewJobs[job.jobId];
  b.later = () => { const RealDate = b.context.Date || Date; const at = RealDate.now() + LATER_MS; b.context.Date = class extends RealDate { static now() { return at; } }; };
  return b;
}
const ping = (status, active) => async (_path, body) => (body?.action === 'ping'
  ? {ok: true, active, accepted: active, status, bridge: {captureProtocol: 1, localJsonRepairEnabled: false}} : {ok: true, job: null});
const active = ping('awaiting_chat', true);
const cancelled = ping('cancelled', false);
const httpError = (status, code) => Object.assign(new Error(`HTTP ${status}`), {status, code});

/** One row per behaviour: `run(kind)` drives the scenario and returns the observable outcome;
 * `same: true` — both kinds must give the same outcome (and `expect` pins it); otherwise
 * `expect[kind]` is each kind's documented outcome (the table's intended difference). */
const ROWS = [
  {id: 'W1', name: 'a collected answer is delivered by complete, then its proven tab closes and the job retires', same: true,
    expect: {completed: true, closed: [10], retired: true},
    async run(kind) {
      // (a fix page also reports the conversation its run was bound in; a review worker ignores it)
      const b = worker(kind, {api: active, handler: (_id, m) => m.type === 'ashlar-can-close' ? {ok: true, canClose: true, url: URL_TAB, conversation: URL_TAB} : {ok: true, raw: ANSWER[kind], responseText: ANSWER[kind], conversation: URL_TAB}});
      await b.tick();
      return {completed: b.calls.some(c => c.action === 'complete' && c.raw === ANSWER[kind]), closed: b.closedTabs, retired: !b.pending()};
    }},
  {id: 'W2', name: 'a tab the user closed explicitly settles the leg as a tab_closed failure', same: true,
    expect: {failure: 'tab_closed'},
    async run(kind) {
      const job = item(kind);
      const b = worker(kind, {job, api: active, session: storage({[`ashlar:closed:${job.jobId}:chatgpt:run-A`]: true})});
      await b.tick();
      return {failure: b.calls.find(c => c.action === 'failure')?.error.split(':')[0]};
    }},
  {id: 'W3', name: 'a quota verdict from the page is delivered as a quota failure and blocks the provider', same: true,
    expect: {failure: 'quota', blocked: true},
    async run(kind) {
      const b = worker(kind, {api: active, handler: () => ({ok: false, code: 'quota', error: 'usage limit'})});
      await b.tick();
      return {failure: b.calls.find(c => c.action === 'failure')?.error.split(':')[0], blocked: Boolean(b.local.state.quota?.chatgpt)};
    }},
  {id: 'W4', name: 'a page bound to another run is never harvested: the leg waits for its binding', same: true,
    expect: {outcome: false, waiting: true, closed: 0},
    async run(kind) {
      const b = worker(kind, {api: active, handler: () => ({ok: true, raw: ANSWER[kind], jobId: 'other', runId: 'run-B'})});
      await b.tick();
      const state = b.pending().states.chatgpt;
      return {outcome: Boolean(state.outcome), waiting: /binding unavailable/.test(state.connectionError || ''), closed: b.closedTabs.length};
    }},
  {id: 'W5', name: 'after delivery, a tab the user continued (follow-up/draft) is preserved and the job retires', same: true,
    expect: {closed: 0, retired: true, asked: true},
    async run(kind) {
      const b = worker(kind, {api: active, job: item(kind, {}, {delivered: true, cleanupPending: true}), handler: () => ({ok: true, canClose: false, reason: 'repurposed', url: URL_TAB})});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending(), asked: b.messages.some(m => m.type === 'ashlar-can-close')};
    }},
  {id: 'W6', name: 'after delivery, a tab navigated off the provider is preserved and the job retires', same: true,
    expect: {closed: 0, retired: true},
    async run(kind) {
      const b = worker(kind, {api: active, url: 'https://example.com/', job: item(kind, {}, {delivered: true, cleanupPending: true})});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W7', name: 'server cancelled while the answer is still pending',
    // Intended: a review has no deadline and waits for its answer; a cancelled fix can never be
    // delivered, so its positively owned tab is force-closed and the job retires.
    expect: {review: {closed: 0, retired: false}, fix: {closed: 1, retired: true}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', url: URL_TAB, conversation: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: URL_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W8', name: 'server cancelled while the tab never finishes loading',
    // Intended: a review waits (no deadline); a fix is preserved after the ownership wait, and the
    // page completes the release handshake once it can answer (never counted as an orphan).
    expect: {review: {firstTick: true, afterWait: true, closed: 0}, fix: {firstTick: true, afterWait: false, closed: 0}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, status: 'loading', handler: () => ({ok: true, canClose: true, owned: true, url: URL_TAB})});
      await b.tick();
      const firstTick = Boolean(b.pending());
      b.later();await b.tick();
      return {firstTick, afterWait: Boolean(b.pending()), closed: b.closedTabs.length};
    }},
  {id: 'W9', name: 'server cancelled while the loaded tab cannot be messaged',
    expect: {review: {afterWait: true, closed: 0}, fix: {afterWait: false, closed: 0}},
    async run(kind) {
      const b = worker(kind, {api: cancelled});
      const chrome = b.context.chrome;
      chrome.tabs.sendMessage = (_id, _msg, cb) => { chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};cb();chrome.runtime.lastError = null; };
      chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
      await b.tick();b.later();await b.tick();
      return {afterWait: Boolean(b.pending()), closed: b.closedTabs.length};
    }},
  {id: 'W10', name: 'server cancelled while the tab now carries another binding',
    // Intended: a review waits for positive ownership; a fix retires after the ownership wait
    // (never closing the tab, never touching the other binding's record).
    expect: {review: {afterWait: true, closed: 0, otherRecord: true}, fix: {afterWait: false, closed: 0, otherRecord: true}},
    async run(kind) {
      const other = {jobId: 'job-B', provider: 'chatgpt', runId: 'run-B', closedKey: 'ashlar:closed:job-B:chatgpt:run-B', closing: false};
      const b = worker(kind, {api: cancelled, session: storage({'ashlar:tab:10': other}), handler: () => ({ok: false, code: 'job_mismatch', jobId: 'job-B', runId: 'run-B'})});
      await b.tick();b.later();await b.tick();
      return {afterWait: Boolean(b.pending()), closed: b.closedTabs.length, otherRecord: b.session.state['ashlar:tab:10']?.jobId === 'job-B'};
    }},
  {id: 'W15', name: 'server cancelled after the tab was opened but before the run was dispatched',
    // Intended for the fix (its undispatched blank tab is closed while it holds nothing of the
    // user's). The review cell is FLAGGED, not changed here: an unbound page answers can-close with
    // job_mismatch, so a cancelled review whose run never started waits (and holds its slot) until
    // an operator clears it (table row W15, review flag R1).
    expect: {review: {retired: false, closed: 0}, fix: {retired: true, closed: 1}},
    async run(kind) {
      const OPENED = 'https://chatgpt.com/?temporary-chat=true';
      const b = worker(kind, {api: cancelled, url: OPENED, job: item(kind, {}, {started: false}),
        handler: (_id, m) => (m.type === 'ashlar-fix-cancel' && m.undispatched ? {ok: true, owned: true, ownership: 'owned', url: OPENED, jobId: '', runId: '', provider: 'chatgpt'} : {ok: false, code: 'job_mismatch', jobId: '', runId: '', provider: 'chatgpt'})});
      await b.tick();b.later();await b.tick();
      return {retired: !b.pending(), closed: b.closedTabs.length};
    }},
  // W23-W27: the conversation identity cell. A fix's bound turn pins the conversation it is shown
  // in (the page's journal; the worker keeps it once). Page content alone never proves WHICH
  // conversation a tab shows: after an in-page move the old DOM can stay rendered under the user's
  // conversation URL, and the cancel reply then echoes that URL. A review has no forced close.
  {id: 'W23', name: 'server cancelled after an in-page move: the content still proves the fix, the URL is another conversation',
    expect: {review: {closed: 0, retired: false}, fix: {closed: 0, retired: true}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, url: OTHER_TAB, job: item(kind, {}, {conversation: URL_TAB}),
        handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', url: OTHER_TAB, conversation: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: OTHER_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W24', name: 'server cancelled; the page reports its bound conversation changed',
    // Waiting cannot change a pinned identity: the fix tab is preserved at once (slot freed).
    expect: {review: {closed: 0, retired: false, released: false}, fix: {closed: 0, retired: true, released: true}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, url: OTHER_TAB, job: item(kind, {}, {conversation: URL_TAB}),
        handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: false, ownership: 'unknown', identity: 'changed', url: OTHER_TAB, conversation: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: OTHER_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending(), released: b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true)};
    }},
  {id: 'W25', name: 'server cancelled; the bound conversation identity was never established',
    // Not established = unknown ownership: asked again, then preserved (never closed).
    expect: {review: {firstTick: true, afterWait: true, closed: 0}, fix: {firstTick: true, afterWait: false, closed: 0}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', url: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: URL_TAB}});
      await b.tick();
      const firstTick = Boolean(b.pending());
      b.later();await b.tick();
      return {firstTick, afterWait: Boolean(b.pending()), closed: b.closedTabs.length};
    }},
  {id: 'W26', name: 'server cancelled; the just-clicked (unsent) prompt proves content, but the tab left its allocation page',
    expect: {review: {closed: 0, retired: false}, fix: {closed: 0, retired: true}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, url: OTHER_TAB,
        handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', unsent: true, url: OTHER_TAB} : {ok: true, canClose: false, reason: 'pending', url: OTHER_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W27', name: 'after delivery, can-close passes on a tab that is not in the stored bound conversation',
    // Intended for the fix (the final check is the stored identity). The review cell keeps its
    // page-context proof (FLAG R4: a review that collected the lingering DOM after an in-page move
    // records its context under the new URL, so this close passes there). Asserted as today.
    expect: {review: {closed: 1, retired: true}, fix: {closed: 0, retired: true}},
    async run(kind) {
      const b = worker(kind, {api: active, url: OTHER_TAB, job: item(kind, {}, {delivered: true, cleanupPending: true, conversation: URL_TAB}),
        handler: () => ({ok: true, canClose: true, url: OTHER_TAB, conversation: URL_TAB})});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W28', name: 'the worker keeps the bound conversation the page reports once, and never replaces it',
    // Intended: only a fix run is bound to a conversation identity; review replies carry none.
    expect: {review: {first: undefined, kept: undefined}, fix: {first: URL_TAB, kept: URL_TAB}},
    async run(kind) {
      let reported = URL_TAB;
      const b = worker(kind, {api: active, handler: () => ({ok: false, code: 'busy', retry: true, ...(kind === 'fix' ? {conversation: reported} : {})})});
      await b.tick();
      const first = b.pending().states.chatgpt.conversation;
      reported = OTHER_TAB;
      await b.tick();
      return {first, kept: b.pending().states.chatgpt.conversation};
    }},
  {id: 'W29', name: 'a bound identity on a bare new-chat page follows the provider-assigned conversation once, then never again',
    expect: {review: {kept: [undefined, undefined, undefined]}, fix: {kept: ['https://chatgpt.com/', URL_TAB, URL_TAB]}},
    async run(kind) {
      const reports = ['https://chatgpt.com/', URL_TAB, OTHER_TAB], kept = [];
      let reported;
      const b = worker(kind, {api: active, handler: () => ({ok: false, code: 'busy', retry: true, ...(kind === 'fix' ? {conversation: reported} : {})})});
      for (const next of reports) { reported = next;await b.tick();kept.push(b.pending().states.chatgpt.conversation); }
      return {kept};
    }},
  {id: 'W11', name: 'a lease conflict (409) on complete drops the lease; the outcome is kept for redelivery', same: true,
    expect: {lease: undefined, kept: true},
    async run(kind) {
      const api = async (path, body) => { if (body?.action === 'complete') throw httpError(409, 'lease_conflict'); return active(path, body); };
      const b = worker(kind, {api, job: item(kind, {}, {outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind]}})});
      await b.tick();
      return {lease: b.pending().leaseId, kept: b.pending().states.chatgpt.outcome?.ok === true};
    }},
  {id: 'W12', name: 'a rejected completion (400) becomes an explicit failure, never a silent drop', same: true,
    expect: {failed: true},
    async run(kind) {
      const api = async (path, body) => { if (body?.action === 'complete') throw httpError(400); return active(path, body); };
      const b = worker(kind, {api, job: item(kind, {}, {outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind]}})});
      await b.tick();await b.tick();
      return {failed: b.calls.some(c => c.action === 'failure' && /rejected/.test(c.error))};
    }},
  {id: 'W13', name: 'after a worker restart, a positively bound tab is recovered as a resume (never re-sent)', same: true,
    expect: {recovered: true, started: true, resume: true, sent: false},
    async run(kind) {
      const jobId = kind === 'fix' ? 'fix-A' : 'job-A';
      const offer = {jobId, ...(kind === 'fix' ? {kind: 'fix'} : {}), leaseId: 'lease-R', provider: 'chatgpt', providers: ['chatgpt'], resumeProviders: ['chatgpt'],
        bindings: [{jobId, provider: 'chatgpt', runId: 'run-A'}], prompt: 'PROMPT', reasoning: {chatgpt: 'pro', grok: 'heavy'}};
      const api = async (path, body) => (body?.action === 'recover' ? {ok: true, job: offer} : active(path, body));
      const tabs = new Map([[10, {id: 10, url: URL_TAB, status: 'complete'}]]);
      const b = background({local: storage({origin: 'http://bridge', token: 'token', bridgeHealth: {origin: 'http://bridge', recoveryProtocol: 1}}), tabs, api,
        handler: (_id, m) => (m.type === 'ashlar-tab-status' ? {ok: true, ownershipProtocol: 1, jobId, runId: 'run-A', provider: 'chatgpt', released: false, url: URL_TAB} : {ok: false, code: 'busy', retry: true})});
      b.context.crypto = webcrypto;b.context.TextEncoder = TextEncoder;
      await b.context.refreshTabInventory();await until(() => false, 100);
      const job = await b.context.recoverOwnedJob({origin: 'http://bridge'}, {});
      return {recovered: job?.jobId === jobId && (kind !== 'fix' || job.kind === 'fix'), started: job?.states.chatgpt.started === true,
        resume: JSON.stringify(job?.resumeProviders) === '["chatgpt"]', sent: b.messages.some(m => m.type === 'ashlar-run' && !m.resume)};
    }},
  {id: 'W14', name: 'tab messages name their kind',
    // Intended: only fix messages carry kind:"fix"; review messages stay exactly as before.
    expect: {review: {kind: undefined}, fix: {kind: 'fix'}},
    async run(kind) {
      const b = worker(kind, {api: active, handler: () => ({ok: false, code: 'busy', retry: true})});
      await b.tick();
      return {kind: b.messages.find(m => m.jobId)?.kind};
    }},
];

for (const row of ROWS) {
  test(`${row.id} ${row.name}`, async () => {
    const got = {};
    for (const kind of ['review', 'fix']) got[kind] = await row.run(kind);
    await flush();
    if (row.same) {
      assert.deepEqual(got.fix, got.review, `${row.id}: the fix path diverges from the review path`);
      assert.deepEqual(got.review, row.expect);
    } else {
      assert.deepEqual(got, row.expect, `${row.id}: each kind keeps its documented behaviour`);
    }
  });
}
