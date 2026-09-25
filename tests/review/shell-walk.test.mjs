// Generated interleavings against the REAL worker (extension/background.js) in the repo's vm harness:
// a seeded random walk over server, tab, page and user events, invariants after every step, bounded
// termination at quiescence, and greedy shrinking of a failing walk. It found the #82 residual: a
// page that accepts a message but never answers ([hang, tick]) or a frozen tab ([freeze, tick]) held
// the job's lane forever, because the poll sent its page messages without a reply deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {background, storage, raw, until} from './helpers.mjs';

const URL_TAB = 'https://chatgpt.com/c/managed', OTHER = 'https://chatgpt.com/c/users-own';
const ANSWER = {review: raw, fix: '{"summary":"guard","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}'};
const EVENTS = ['tick', 'tick', 'tick', 'later', 'cancel', 'missing', 'sweep', 'followup', 'navigate', 'userClose',
  'freeze', 'thaw', 'discard', 'loading', 'loaded', 'hang', 'noReceiver', 'pageOk', 'notRendered', 'rendered', 'browserRestart'];
const START = ['secured', 'generating', 'undispatched'];
/** A page reply deadline that expires at once (the real one is PAGE_REPLY_MS). */
const expiresAtOnce = () => ({promise: new Promise((_resolve, reject) => setImmediate(() => reject(new Error('the page did not answer in time')))), cancel() {}});

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Replays `events` on one leg (`kind`, starting `start`) and returns the first violated invariant ('' if none). */
async function run(kind, start, events) {
  const jobId = kind === 'fix' ? 'fix-A' : 'job-A';
  const state = start === 'secured' ? {delivered: true, cleanupPending: true, outcome: {ok: true, raw: ANSWER[kind], originalText: ANSWER[kind]}, conversation: URL_TAB, pageUrl: URL_TAB}
    : start === 'undispatched' ? {started: false} : {};
  const job = {jobId, ...(kind === 'fix' ? {kind: 'fix'} : {}), origin: 'http://bridge', leaseId: 'lease-A', prompt: 'PROMPT',
    providers: ['chatgpt'], reasoning: {chatgpt: 'pro'}, states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', ...state}}};
  const session = storage({'ashlar:tab:10': {jobId, provider: 'chatgpt', runId: 'run-A', closedKey: `ashlar:closed:${jobId}:chatgpt:run-A`, closing: false}});
  const tab = {id: 10, url: start === 'undispatched' ? 'https://chatgpt.com/?temporary-chat=true' : URL_TAB, status: 'complete'};
  const w = {status: 'awaiting_chat', mode: 'ok', user: false, reused: false, notRendered: false, clean: true, now: Date.now()};
  const page = {bound: start !== 'undispatched', sent: start !== 'undispatched'};
  const handler = (_id, m) => {
    if (w.reused) return {ok: false, code: 'job_mismatch', jobId: '', runId: '', provider: 'chatgpt'}; // the user's tab now
    if (m.type === 'ashlar-tab-status') return {ok: true};
    if (m.type === 'ashlar-run') page.bound = true;
    if (m.type === 'ashlar-can-close' || m.type === 'ashlar-fix-cancel') {
      const url = b.tabs.get(10)?.url;
      if (w.user) return {ok: true, releaseProtocol: 1, ownership: 'takenOver', cause: 'user_turn', url, conversation: URL_TAB};
      if (!page.bound && !m.undispatched) return {ok: false, code: 'job_mismatch', jobId: '', runId: '', provider: 'chatgpt'};
      if (!page.bound) return {ok: true, releaseProtocol: 1, ownership: 'owned', blank: true, url, jobId: '', runId: '', provider: 'chatgpt'};
      if (!page.sent) return {ok: true, releaseProtocol: 1, ownership: 'owned', blank: true, url};
      if (w.notRendered) return {ok: true, releaseProtocol: 1, ownership: 'unknown', cause: 'not_rendered', url};
      return {ok: true, releaseProtocol: 1, ownership: 'owned', conversation: URL_TAB, url};
    }
    return {ok: false, code: 'busy', retry: true};
  };
  const api = async (_path, body) => (body?.action === 'ping'
    ? {ok: true, active: w.status === 'awaiting_chat', accepted: w.status === 'awaiting_chat', status: w.status, bridge: {captureProtocol: 1, localJsonRepairEnabled: false}}
    : {ok: true, job: null});
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {[jobId]: job}}), session, tabs: new Map([[10, tab]]), api, handler});
  b.context.crypto = webcrypto; b.context.TextEncoder = TextEncoder;
  const RealDate = Date; b.context.Date = class extends RealDate { static now() { return w.now; } };
  b.context.pageReplyDeadline = expiresAtOnce;
  b.chrome.tabs.reload = async () => { const t = b.tabs.get(10); if (t) Object.assign(t, {status: 'complete', discarded: false}); };
  const realSend = b.chrome.tabs.sendMessage;
  b.chrome.tabs.sendMessage = (id, msg, cb) => {
    const t = b.tabs.get(id);
    if (t && (w.mode === 'hang' || t.frozen)) { b.messages.push({id, ...msg}); return; } // accepted, never answered
    if (t && w.mode === 'noReceiver') { b.messages.push({id, ...msg}); b.chrome.runtime.lastError = {message: 'Could not establish connection. Receiving end does not exist.'}; cb(); b.chrome.runtime.lastError = null; return; }
    return realSend(id, msg, cb);
  };
  b.chrome.scripting.executeScript = async () => { if (w.mode === 'noReceiver') throw new Error('Cannot access contents of the page'); };
  const pending = () => b.local.state.pendingReviewJobs?.[jobId];
  const settles = async operation => { let settled = false; operation().then(() => { settled = true; }); return until(() => settled, 2000); };
  const tick = async () => {
    const userBefore = w.user || w.reused;
    const closedBefore = b.closedTabs.length;
    if (!await settles(() => b.tick())) return 'tick_never_settles';
    if (b.closedTabs.length > closedBefore && userBefore) return 'closed_user_tab';
    return '';
  };
  const apply = async ev => {
    const t = b.tabs.get(10);
    switch (ev) {
      case 'tick': return tick();
      case 'later': w.now += 45_000; return '';
      case 'cancel': if (w.status === 'awaiting_chat') w.status = 'cancelled'; return '';
      case 'missing': w.status = 'missing'; return '';
      case 'sweep': return await settles(() => b.context.autoSweepStuckJobs()) ? '' : 'sweep_never_settles';
      case 'followup': if (t && !w.reused) { w.user = true; } return '';
      case 'navigate': if (t && !w.reused) { w.user = true; t.url = OTHER; } return '';
      case 'userClose': if (t) await b.closeTab(10); return '';
      case 'freeze': if (t) { t.frozen = true; w.clean = false; } return '';
      case 'thaw': if (t) t.frozen = false; return '';
      case 'discard': if (t) { Object.assign(t, {discarded: true, status: 'unloaded'}); w.clean = false; } return '';
      case 'loading': if (t) { t.status = 'loading'; w.clean = false; } return '';
      case 'loaded': if (t && !t.discarded) t.status = 'complete'; return '';
      case 'hang': w.mode = 'hang'; w.clean = false; return '';
      case 'noReceiver': w.mode = 'noReceiver'; w.clean = false; return '';
      case 'pageOk': w.mode = 'ok'; return '';
      case 'notRendered': w.notRendered = true; w.clean = false; return '';
      case 'rendered': w.notRendered = false; return '';
      case 'browserRestart': // storage.session is cleared; tab id 10 may now be a tab the user opened
        if (t) { for (const k of Object.keys(b.session.state)) delete b.session.state[k]; w.reused = true; w.clean = false; }
        return '';
    }
    return '';
  };
  for (const ev of events) { const v = await apply(ev); if (v) return v; }
  // Quiescence: the user is away. A leg the server still wants is ended by the server's own deadline.
  if (pending() && w.status === 'awaiting_chat') w.status = 'cancelled';
  for (let i = 0; i < 8 && pending(); i++) { w.now += 60_000; const v = await tick() || await apply('sweep'); if (v) return v; }
  if (pending()) return `not_terminal(${pending().states.chatgpt.cleanupWaitReason || pending().states.chatgpt.connectionError || ''})`;
  if (w.clean && !w.user && b.tabs.has(10)) return 'untouched_reachable_tab_preserved';
  return '';
}

async function shrink(kind, start, events, violation) {
  let cur = events;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < cur.length; i++) {
      const cand = cur.slice(0, i).concat(cur.slice(i + 1));
      if ((await run(kind, start, cand)) === violation) { cur = cand; changed = true; break; }
    }
  }
  return cur;
}

// The shrunk traces the walk found on #82 (fc3fae26): each held the job's lane forever.
for (const kind of ['review', 'fix']) {
  for (const start of START) {
    for (const trace of [['hang', 'tick'], ['hang', 'missing'], ['hang', 'cancel', 'tick'], ['hang', 'tick', 'pageOk', 'tick']]) {
      test(`${kind} ${start}: [${trace.join(', ')}] settles every tick and ends the leg`, async () => {
        assert.equal(await run(kind, start, trace), '');
      });
    }
  }
}

test('generated interleavings against the real worker: invariants and bounded termination', {timeout: 120_000}, async () => {
  const found = new Map();
  const SEEDS = Number(process.env.WALK_SEEDS || 400);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const kind = r() < 0.5 ? 'review' : 'fix';
    const start = START[Math.floor(r() * START.length)];
    const events = Array.from({length: 4 + Math.floor(r() * 10)}, () => EVENTS[Math.floor(r() * EVENTS.length)]);
    const v = await run(kind, start, events);
    if (v && !found.has(`${kind}:${start}:${v}`)) found.set(`${kind}:${start}:${v}`, {seed, minimal: await shrink(kind, start, events, v)});
  }
  assert.deepEqual([...found].map(([key, {seed, minimal}]) => `${key} seed=${seed} minimal=[${minimal.join(', ')}]`), []);
});

// Every other page message the worker sends is bounded the same way: a page that accepts it but
// never answers leaves the lane (a capture or repair receipt, a repair source read, an inventory
// probe) free for the next attempt instead of holding it for the worker's lifetime.
function unanswered(states, patch = {}) {
  const job = {jobId: 'job-A', origin: 'http://bridge', leaseId: 'lease-A', providers: ['chatgpt'], captureProtocol: 1,
    states: {chatgpt: {tabId: 10, started: true, runId: 'run-A', ...states}}, ...patch};
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {'job-A': job}}),
    tabs: new Map([[10, {id: 10, url: URL_TAB, status: 'complete'}]])});
  b.context.crypto = webcrypto; b.context.TextEncoder = TextEncoder;
  b.chrome.tabs.sendMessage = (id, msg) => { b.messages.push({id, ...msg}); }; // accepted, never answered
  b.context.pageReplyDeadline = expiresAtOnce;
  b.settles = async operation => { let settled = false; operation().then(() => { settled = true; }, () => { settled = true; }); return until(() => settled, 2000); };
  return b;
}
const durable = {id: 'capture-A', archiveDurable: true, responseId: 'response-A', text: 'not json', context: '[]', sourceHash: 'h', totalChars: 8};
const RECEIPTS = [
  ['the repair source read', 'ashlar-repair-source', {formatError: true, outcome: {ok: true, raw: 'not json'}}, (b, jobs) => b.context.readRepairSource(jobs['job-A'], 'chatgpt', jobs)],
  ['the capture receipt', 'ashlar-capture-accepted', {sourceCapture: durable}, (b, jobs) => b.context.captureProvider(jobs['job-A'], 'chatgpt', jobs)],
  ['the repair receipt', 'ashlar-repair-accepted', {delivered: true, repairReceiptPending: true, repairAttempt: {id: 'repair-A', raw, text: 'original', responseId: 'response-A', sourceHash: 'h', status: 'accepted'}},
    (b, jobs) => b.context.notifyRepairReceipt(jobs['job-A'], 'chatgpt', jobs)],
];
for (const [what, type, states, send] of RECEIPTS) {
  test(`${what} to a page that never answers settles (bounded like the release path)`, async () => {
    const b = unanswered(states);
    const jobs = await b.context.workerJobs('http://bridge');
    assert.ok(await b.settles(() => send(b, jobs)), `${what} does not hold its lane`);
    assert.ok(b.messages.some(m => m.type === type), 'the page was asked');
  });
}
test('an inventory probe of a page that never answers ends, so the tab is probed again', async () => {
  const b = unanswered({});
  await b.context.refreshTabInventory();
  assert.ok(await until(() => b.messages.filter(m => m.type === 'ashlar-tab-status').length === 1), 'probed');
  // The probe's lane is single-flight per tab: a second probe is sent only once the first ended.
  assert.ok(await until(() => vm.runInContext('inventoryLanes.size', b.context) === 0), 'the unanswered probe ended');
  await b.context.refreshTabInventory();
  assert.equal(b.messages.filter(m => m.type === 'ashlar-tab-status').length, 2, 'the unanswered probe released its lane');
});
