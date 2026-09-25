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
// A delivered (secured) leg carries its outcome; delivered with none is an abandoned leg (#82).
// answerDelivered: the worker's record that the server acknowledged the answer (deliverOutcome, on
// the complete ACK), which a fix needs to take the proven-success path (#77); a review ignores it.
const secured = kind => ({delivered: true, cleanupPending: true, answerDelivered: true, outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind]}});

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
/** A page that answers BOTH release exits (can-close and the cancel exit) with one verdict, as json.js
 * does (tabOwnership); only the cancel exit stops its run. */
const sameVerdict = verdict => {
  let stopped = false;
  return (_id, m) => {
    if (m.type === 'ashlar-fix-cancel') stopped = true;
    return m.type === 'ashlar-can-close' || m.type === 'ashlar-fix-cancel' ? {...verdict, stopped} : {ok: false, code: 'busy', retry: true};
  };
};

/** One row per behaviour: `run(kind)` drives the scenario and returns the observable outcome;
 * `same: true` — both kinds must give the same outcome (and `expect` pins it); otherwise
 * `expect[kind]` is each kind's documented outcome (the table's intended difference). */
const ROWS = [
  {id: 'W1', name: 'a collected answer is delivered by complete, then its proven tab closes and the job retires', same: true,
    expect: {completed: true, closed: [10], retired: true},
    async run(kind) {
      // (a fix page also reports the conversation its run was bound in and its ownership verdict,
      // json.js fixOwnershipProof; a review worker ignores both)
      const b = worker(kind, {api: active, handler: (_id, m) => m.type === 'ashlar-can-close' ? {ok: true, canClose: true, ownership: 'owned', url: URL_TAB, conversation: URL_TAB} : {ok: true, raw: ANSWER[kind], responseText: ANSWER[kind], ownership: 'owned', conversation: URL_TAB}});
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
      const b = worker(kind, {api: active, job: item(kind, {}, secured(kind)), handler: () => ({ok: true, canClose: false, reason: 'repurposed', ownership: 'takenOver', url: URL_TAB})});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending(), asked: b.messages.some(m => m.type === 'ashlar-can-close')};
    }},
  {id: 'W6', name: 'after delivery, a tab navigated off the provider is preserved and the job retires', same: true,
    expect: {closed: 0, retired: true},
    async run(kind) {
      const b = worker(kind, {api: active, url: 'https://example.com/', job: item(kind, {}, secured(kind))});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W7', name: 'server cancelled while the answer is still pending',
    // Intended: a cancelled run can never be delivered, so the job retires and its run is stopped,
    // whatever kind it is (#82). A review's positively owned tab is closed by the cancel exit's
    // verdict (#82); a fix tab is closed only on the proven-success path, so it is preserved
    // (released) even when the page would vouch for it (#77).
    expect: {review: {closed: 1, retired: true}, fix: {closed: 0, retired: true}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', url: URL_TAB, conversation: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: URL_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W8', name: 'server cancelled while the tab never finishes loading',
    // Intended: a tab that cannot answer is never held forever (#82). A review is preserved after the
    // ownership wait; a cancelled fix is preserved at once (nothing is waited for: no page verdict can
    // authorise a close on a cancel, #77). Either way the page completes the release handshake once
    // it can answer (never counted as an orphan).
    expect: {review: {firstTick: true, afterWait: false, closed: 0}, fix: {firstTick: false, afterWait: false, closed: 0}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, status: 'loading', handler: () => ({ok: true, canClose: true, owned: true, url: URL_TAB})});
      await b.tick();
      const firstTick = Boolean(b.pending());
      b.later();await b.tick();
      return {firstTick, afterWait: Boolean(b.pending()), closed: b.closedTabs.length};
    }},
  {id: 'W9', name: 'server cancelled while the loaded tab cannot be messaged', same: true,
    expect: {afterWait: false, closed: 0},
    async run(kind) {
      const b = worker(kind, {api: cancelled});
      const chrome = b.context.chrome;
      chrome.tabs.sendMessage = (_id, _msg, cb) => { chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'};cb();chrome.runtime.lastError = null; };
      chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
      await b.tick();b.later();await b.tick();
      return {afterWait: Boolean(b.pending()), closed: b.closedTabs.length};
    }},
  {id: 'W10', name: 'server cancelled while the tab now carries another binding', same: true,
    // The leg retires after the ownership wait, never closing the tab and never touching the other
    // binding's record.
    expect: {afterWait: false, closed: 0, otherRecord: true},
    async run(kind) {
      const other = {jobId: 'job-B', provider: 'chatgpt', runId: 'run-B', closedKey: 'ashlar:closed:job-B:chatgpt:run-B', closing: false};
      const b = worker(kind, {api: cancelled, session: storage({'ashlar:tab:10': other}), handler: () => ({ok: false, code: 'job_mismatch', jobId: 'job-B', runId: 'run-B'})});
      await b.tick();b.later();await b.tick();
      return {afterWait: Boolean(b.pending()), closed: b.closedTabs.length, otherRecord: b.session.state['ashlar:tab:10']?.jobId === 'job-B'};
    }},
  {id: 'W15', name: 'server cancelled after the tab was opened but before the run was dispatched',
    // Intended: both jobs retire. A review's undispatched blank tab (the one this browser session
    // created) is closed while it holds nothing of the user's (#82, review flag R1 resolved); a fix's
    // is preserved (a fix tab is closed only on the proven-success path, and no fix page is ever asked
    // to vouch for an unbound tab, #77).
    expect: {review: {retired: true, closed: 1}, fix: {retired: true, closed: 0}},
    async run(kind) {
      const OPENED = 'https://chatgpt.com/?temporary-chat=true';
      const job = item(kind, {}, {started: false});
      // allocateProviderTab's record: this browser session created tab 10 for the leg
      const session = storage({'ashlar:tab:10': {jobId: job.jobId, provider: 'chatgpt', runId: 'run-A', closedKey: `ashlar:closed:${job.jobId}:chatgpt:run-A`, closing: false}});
      const b = worker(kind, {api: cancelled, url: OPENED, job, session,
        handler: (_id, m) => (m.type === 'ashlar-fix-cancel' && m.undispatched ? {ok: true, owned: true, ownership: 'owned', url: OPENED, jobId: '', runId: '', provider: 'chatgpt'} : {ok: false, code: 'job_mismatch', jobId: '', runId: '', provider: 'chatgpt'})});
      await b.tick();b.later();await b.tick();
      return {retired: !b.pending(), closed: b.closedTabs.length};
    }},
  // W23-W27, W40: the conversation identity cell. A run's page records the conversation it is bound
  // in (a fix when its send is proven; a review then too on a conversation page, else where the
  // provider put its new chat; the worker keeps it once). Page content alone never proves WHICH
  // conversation a tab shows: after an in-page move the old DOM can stay rendered under the user's
  // conversation URL, and the reply then echoes that URL. The worker checks the tab's URL first.
  {id: 'W23', name: 'server cancelled after an in-page move: the content still proves the run, the URL is another conversation', same: true,
    expect: {closed: 0, retired: true},
    async run(kind) {
      const b = worker(kind, {api: cancelled, url: OTHER_TAB, job: item(kind, {}, {conversation: URL_TAB}),
        handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', url: OTHER_TAB, conversation: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: OTHER_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W24', name: 'server cancelled; the page reports its bound conversation changed', same: true,
    // Waiting cannot change a recorded identity: the tab is preserved at once (slot freed).
    expect: {closed: 0, retired: true, released: true},
    async run(kind) {
      const b = worker(kind, {api: cancelled, url: OTHER_TAB, job: item(kind, {}, {conversation: URL_TAB}),
        handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: false, ownership: 'unknown', identity: 'changed', url: OTHER_TAB, conversation: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: OTHER_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending(), released: b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true)};
    }},
  {id: 'W40', name: 'server cancelled; the page reports its sent journal carries no send-time conversation (identity "unestablished")', same: true,
    // Round 13: the identity is recorded only when the send is proven, so waiting cannot establish
    // it: the tab is preserved at once (slot freed), never closed. Only a fix page reports this (a
    // review with no recorded conversation answers `unpinned`, json.js tabOwnership); since #82 a
    // cancelled review takes the same cancel exit, so the worker treats the reply the same way.
    expect: {closed: 0, retired: true, released: true},
    async run(kind) {
      const b = worker(kind, {api: cancelled,
        handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: false, ownership: 'unknown', identity: 'unestablished', url: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: URL_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending(), released: b.messages.some(m => m.type === 'ashlar-fix-cancel' && m.preserve === true)};
    }},
  {id: 'W25', name: 'server cancelled; the bound conversation identity was never established',
    // Not established = unknown ownership: a review is asked again, then preserved (never closed,
    // #82); a cancelled fix is preserved at once, whatever the page says (#77).
    expect: {review: {firstTick: true, afterWait: false, closed: 0}, fix: {firstTick: false, afterWait: false, closed: 0}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', url: URL_TAB} : {ok: true, canClose: false, reason: 'pending', url: URL_TAB}});
      await b.tick();
      const firstTick = Boolean(b.pending());
      b.later();await b.tick();
      return {firstTick, afterWait: Boolean(b.pending()), closed: b.closedTabs.length};
    }},
  {id: 'W26', name: 'server cancelled; the just-clicked (unsent) prompt proves content, but the tab left its allocation page', same: true,
    expect: {closed: 0, retired: true},
    async run(kind) {
      const b = worker(kind, {api: cancelled, url: OTHER_TAB,
        handler: (_id, m) => m.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, ownership: 'owned', unsent: true, url: OTHER_TAB} : {ok: true, canClose: false, reason: 'pending', url: OTHER_TAB}});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W27', name: 'after delivery, can-close passes on a tab that is not in the stored bound conversation', same: true,
    // The final check is the stored identity (origin + path), for both kinds: the user's conversation.
    expect: {closed: 0, retired: true},
    async run(kind) {
      const b = worker(kind, {api: active, url: OTHER_TAB, job: item(kind, {}, {...secured(kind), conversation: URL_TAB}),
        handler: () => ({ok: true, canClose: true, ownership: 'owned', url: OTHER_TAB, conversation: URL_TAB})});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W28', name: 'the worker keeps the bound conversation the page reports once, and never replaces it', same: true,
    // Both kinds pin their conversation (review replies report it too).
    expect: {first: URL_TAB, kept: URL_TAB},
    async run(kind) {
      let reported = URL_TAB;
      const b = worker(kind, {api: active, handler: () => ({ok: false, code: 'busy', retry: true, conversation: reported})});
      await b.tick();
      const first = b.pending().states.chatgpt.conversation;
      reported = OTHER_TAB;
      await b.tick();
      return {first, kept: b.pending().states.chatgpt.conversation};
    }},
  {id: 'W29', name: 'a bound identity on a bare new-chat page is never replaced by a later location (no location-based upgrade)', same: true,
    // Ashlar 4096068011: a URL the tab moves to is no evidence of whose conversation it is (the user
    // can navigate before the provider assigns one), so the first identity reported (recorded at
    // send, or a new-chat review's pin) is kept (both kinds report one).
    expect: {kept: ['https://chatgpt.com/', 'https://chatgpt.com/', 'https://chatgpt.com/']},
    async run(kind) {
      const reports = ['https://chatgpt.com/', URL_TAB, OTHER_TAB], kept = [];
      let reported;
      const b = worker(kind, {api: active, handler: () => ({ok: false, code: 'busy', retry: true, conversation: reported})});
      for (const next of reports) { reported = next;await b.tick();kept.push(b.pending().states.chatgpt.conversation); }
      return {kept};
    }},
  // W30-W32: the fix worker acts only on the page's full ownership verdict (json.js
  // fixOwnershipProof), re-established at the moment of each decision.
  {id: 'W30', name: 'a collected answer the page hands out without a positive ownership verdict',
    // Intended: a fix answer is taken only with ownership "owned" (the page re-proves the tab when
    // it hands the answer out); a review result carries no verdict and is taken as today.
    expect: {review: {completed: true}, fix: {completed: false}},
    async run(kind) {
      const b = worker(kind, {api: active, handler: (_id, m) => m.type === 'ashlar-can-close' ? {ok: true, canClose: false, reason: 'pending', url: URL_TAB} : {ok: true, raw: ANSWER[kind], responseText: ANSWER[kind], conversation: URL_TAB}});
      await b.tick();
      return {completed: b.calls.some(c => c.action === 'complete')};
    }},
  {id: 'W31', name: 'after delivery, can-close says canClose without a positive ownership verdict',
    // Intended: the fix worker closes only on ownership "owned" (it waits otherwise, the tab kept);
    // a review closes on canClose as today.
    expect: {review: {closed: 1}, fix: {closed: 0}},
    async run(kind) {
      const b = worker(kind, {api: active, job: item(kind, {}, {delivered: true, cleanupPending: true, answerDelivered: true, conversation: URL_TAB, outcome: {ok: true, raw: ANSWER[kind]}}),
        handler: () => ({ok: true, canClose: true, url: URL_TAB, conversation: URL_TAB})});
      await b.tick();
      return {closed: b.closedTabs.length};
    }},
  {id: 'W32', name: 'after a delivered FAILURE (no answer), the tab close decision',
    // Intended: a fix with no delivered answer never reaches the proven-success path, so its tab is
    // preserved (released) and the job retires, whatever the page says; a review closes on
    // can-close as today.
    expect: {review: {closed: 1, retired: true}, fix: {closed: 0, retired: true}},
    async run(kind) {
      const b = worker(kind, {api: active, job: item(kind, {}, {delivered: true, cleanupPending: true, conversation: URL_TAB, outcome: {ok: false, code: 'quota', error: 'limit'}}),
        handler: () => ({ok: true, owned: true, ownership: 'owned', canClose: true, reason: 'complete', url: URL_TAB, conversation: URL_TAB})});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  // W33-W35, W41 (round 12, Ashlar 4097631101, under #82's release rule and #77's proven-success
  // path): whether a leg whose answer was collected closes never follows the server status. The
  // server settling or forgetting the item (a restart or a terminal-retention prune reports an
  // unknown fix id as cancelled) after the answer was collected releases the tab by the page's verdict
  // alone: closed when Ashlar's, kept (and released) when the user's. The page mock answers BOTH exits
  // with the same verdict, as json.js does for a review (tabOwnership). Which exit is asked differs by
  // kind: a cancelled review takes the cancel exit (it also stops the page's run, #82); a fix whose
  // answer was DELIVERED (answerDelivered, the worker's own record of the complete ACK) asks can-close
  // whatever the server says since (its run already ended with that answer; a fix page's cancel reply
  // carries no verdict), and a fix whose answer was never delivered is never closed (W35, W41, #77).
  // The verdict compares nothing about the answer, so a regenerated or replaced answer with no user
  // signal closes (browser.e2e "a delivered fix whose server then reports ..."). (`serverStatus`: what
  // an earlier heartbeat stored; cleanup runs before the tick's own heartbeat.)
  {id: 'W33', name: 'an answer was delivered, then the server reports cancelled / unknown, and the page\'s verdict is the user\'s: the tab is kept',
    expect: {review: {cancelled: {askedCancel: true, closed: 0, retired: true, released: true}, unknown: {askedCancel: false, closed: 0, retired: true, released: true}},
      fix: {cancelled: {askedCancel: false, closed: 0, retired: true, released: true}, unknown: {askedCancel: false, closed: 0, retired: true, released: true}}},
    async run(kind) {
      const got = {};
      for (const status of ['cancelled', 'unknown']) {
        const b = worker(kind, {api: ping(status, false), job: item(kind, {serverStatus: status}, {delivered: true, cleanupPending: true, answerDelivered: true, conversation: URL_TAB,
          outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind], completion: {responseId: 'response-A', context: URL_TAB}}}),
        handler: sameVerdict({ok: true, releaseProtocol: 1, ownership: 'takenOver', cause: 'user_turn', url: URL_TAB})});
        await b.tick();await b.tick();
        got[status] = {askedCancel: b.messages.some(m => m.type === 'ashlar-fix-cancel' && !m.preserve), closed: b.closedTabs.length, retired: !b.pending(),
          released: b.messages.some(m => m.preserve === true)};
      }
      return got;
    }},
  {id: 'W34', name: 'an answer was delivered, then the server reports cancelled / unknown, and the page\'s verdict is Ashlar\'s: the tab closes (control)',
    expect: {review: {cancelled: {askedCancel: true, closed: [10], retired: true}, unknown: {askedCancel: false, closed: [10], retired: true}},
      fix: {cancelled: {askedCancel: false, closed: [10], retired: true}, unknown: {askedCancel: false, closed: [10], retired: true}}},
    async run(kind) {
      const got = {};
      for (const status of ['cancelled', 'unknown']) {
        const b = worker(kind, {api: ping(status, false), job: item(kind, {serverStatus: status}, {delivered: true, cleanupPending: true, answerDelivered: true, conversation: URL_TAB,
          outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind], completion: {responseId: 'response-A', context: URL_TAB}}}),
        handler: sameVerdict({ok: true, releaseProtocol: 1, ownership: 'owned', url: URL_TAB, conversation: URL_TAB})});
        await b.tick();await b.tick();
        got[status] = {askedCancel: b.messages.some(m => m.type === 'ashlar-fix-cancel' && !m.preserve), closed: b.closedTabs, retired: !b.pending()};
      }
      return got;
    }},
  {id: 'W41', name: 'an answer was collected but no acknowledged delivery is recorded (the leg ended by a cancel), completion unchanged',
    // Intended: a review is released by the page's verdict (#82: closed when Ashlar's); a fix without
    // its delivery record never reaches the proven-success path: preserved (released), never closed,
    // the job retires (#77).
    expect: {review: {closed: 1, retired: true}, fix: {closed: 0, retired: true}},
    async run(kind) {
      const b = worker(kind, {api: cancelled, job: item(kind, {serverStatus: 'cancelled'}, {delivered: true, cleanupPending: true, conversation: URL_TAB,
        outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind], completion: {responseId: 'response-A', context: URL_TAB}}}),
      handler: () => ({ok: true, canClose: true, reason: 'complete', ownership: 'owned', url: URL_TAB, conversation: URL_TAB})});
      await b.tick();
      return {closed: b.closedTabs.length, retired: !b.pending()};
    }},
  {id: 'W35', name: 'a collected answer the server rejected (400: its outcome became a failure): a review is released by the page\'s verdict, a fix is never closed',
    // Intended: a review's collected answer is proven locally by rejectedRaw, so the leg is released
    // like a secured one: kept when the user's, closed when Ashlar's (#82). A rejected fix answer was
    // never delivered: the fix tab is preserved whatever the page says (#77).
    expect: {review: {takenOver: {closed: 0, retired: true}, owned: {closed: 1, retired: true}},
      fix: {takenOver: {closed: 0, retired: true}, owned: {closed: 0, retired: true}}},
    async run(kind) {
      const got = {};
      for (const ownership of ['takenOver', 'owned']) {
        const b = worker(kind, {api: active, job: item(kind, {}, {delivered: true, cleanupPending: true, conversation: URL_TAB, rejectedRaw: ANSWER[kind],
          outcome: {ok: false, code: 'error', error: 'completed review was rejected: HTTP 400'}}),
        handler: sameVerdict({ok: true, releaseProtocol: 1, ownership, ...(ownership === 'owned' ? {conversation: URL_TAB} : {cause: 'user_turn'}), url: URL_TAB})});
        await b.tick();
        got[ownership] = {closed: b.closedTabs.length, retired: !b.pending()};
      }
      return got;
    }},
  // W36 (round 12, Ashlar 4097631112): an allocation intent is not a tab. Intended difference: a fix
  // whose intent never became a proven tab (no owned record, no bound page, delivery record never
  // `created`) allocates again, once; a review keeps its intent as before (FLAG R8: it waits forever).
  {id: 'W36', name: 'the worker stopped between the allocation intent and chrome.tabs.create (registry intact, no tab)',
    expect: {review: {tabs: 0, runs: 0, waiting: true}, fix: {tabs: 1, runs: 1, waiting: false}},
    async run(kind) {
      const job = item(kind, kind === 'fix' ? {deliveryId: 'delivery-1'} : {}, {tabId: undefined, started: undefined, allocating: true});
      const b = worker(kind, {job, api: active, handler: () => ({ok: false, code: 'busy', retry: true})});
      b.tabs.delete(10);
      if (kind === 'fix') await b.local.set({'ashlar:fixDeliveries': {'fix-A': {deliveryId: 'delivery-1', provider: 'chatgpt', phase: 'creating', at: Date.now()}}});
      await b.tick();await b.tick();
      return {tabs: b.tabs.size, runs: b.messages.filter(m => m.type === 'ashlar-run' && !m.resume).length,
        waiting: /tab creation outcome unknown/.test(b.pending().states.chatgpt.connectionError || '')};
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
