// The tab queue (#85): every tab operation (a leg's poll, its release, the tab inventory and its
// probes) runs one at a time, first in first out, from its first read to its last write, and every
// await inside it is bounded. These rows pin its invariants: a static guard over background.js's
// call graph (I1, I2, R2), and the interleavings the queue closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {source} from './load-source.mjs';
import {background, storage, until} from './helpers.mjs';

// ── Static guard: the call graph of background.js's top-level functions.

/** `text` with comments removed and the contents of string, template and regex literals blanked
 * (same length; a template's ${...} code is kept), so a scan sees only code. */
function codeOnly(text) {
  const out = [...text];
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const templateDepth = [];
  const regexAllowed = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    return k < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(out[k]) || /\b(?:return|typeof|void|case|in|of)$/.test(out.slice(Math.max(0, k - 6), k + 1).join(''));
  };
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const end = text.indexOf('\n', i); blank(i, end < 0 ? text.length : end); i = end < 0 ? text.length : end; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2) + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === '`' || (c === '}' && templateDepth.at(-1) === 0)) {
      if (c === '}') templateDepth.pop();
      let j = i + 1;
      while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      if (text[j] === '$') { templateDepth.push(0); i = j + 2; } else i = j + 1;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, klass = false;
      while (j < text.length && (klass || text[j] !== '/')) { if (text[j] === '[') klass = true; if (text[j] === ']') klass = false; j += text[j] === '\\' ? 2 : 1; }
      blank(i + 1, j); i = j + 1; continue;
    }
    if (templateDepth.length && c === '{') templateDepth[templateDepth.length - 1]++;
    if (templateDepth.length && c === '}') templateDepth[templateDepth.length - 1]--;
    i++;
  }
  return out.join('');
}
/** The index of the bracket that closes the one at `open`. */
function closing(code, open) {
  const pairs = {'(': ')', '{': '}', '[': ']'};
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (pairs[code[k]]) depth++;
    else if (')}]'.includes(code[k]) && --depth === 0) return k;
  }
  return code.length;
}
/** Each top-level function: its body, the calls in it, and the argument spans of tabOp /
 * writeInOrder / maintenanceInOrder calls in it. */
function callGraph(text) {
  const code = codeOnly(text);
  const fns = new Map();
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const params = code.indexOf('(', m.index);
    const open = code.indexOf('{', closing(code, params));
    fns.set(m[1], {start: open, end: closing(code, open)});
  }
  for (const [name, fn] of fns) {
    const body = code.slice(fn.start, fn.end + 1);
    const spans = kind => [...body.matchAll(new RegExp(`(?<![.\\w$])${kind}\\s*\\(`, 'g'))].map(m => [m.index, closing(body, m.index + m[0].length - 1)]);
    fn.name = name;
    fn.body = body;
    fn.opSpans = spans('tabOp');
    fn.orderSpans = [...spans('writeInOrder'), ...spans('maintenanceInOrder')];
    fn.calls = [...body.matchAll(/(?<![.\w$])(void\s+)?([A-Za-z_$][\w$]*)\s*(\()?/g)]
      .filter(m => fns.has(m[2]) && m[2] !== name && (m[3] || fn.opSpans.some(([a, b]) => m.index > a && m.index < b)))
      .map(m => ({name: m[2], at: m.index, void: Boolean(m[1]), called: Boolean(m[3])}));
    fn.effects = [...body.matchAll(/\bchrome\.(?:tabs\.(sendMessage|create|remove|reload)|scripting\.(executeScript))\s*\(/g)]
      .map(m => ({effect: m[1] || m[2], at: m.index}));
  }
  const inside = (spans, at) => spans.some(([a, b]) => at > a && at < b);
  // Operation bodies: what an operation runs (the tabOp arguments), and everything they call.
  const opBodies = new Set();
  // (A `void` call runs detached, outside the operation: R2 allows `void flushProgress(...)`.)
  const visit = name => { if (opBodies.has(name)) return; opBodies.add(name); for (const call of fns.get(name).calls) if (!call.void) visit(call.name); };
  for (const fn of fns.values()) for (const call of fn.calls) if (inside(fn.opSpans, call.at)) visit(call.name);
  // Functions that perform a tab effect outside any tabOp argument of their own, directly or through a call.
  const effectful = new Set([...fns.values()].filter(fn => fn.effects.some(e => !inside(fn.opSpans, e.at))).map(fn => fn.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const fn of fns.values()) {
      if (effectful.has(fn.name)) continue;
      if (fn.calls.some(call => call.called && !inside(fn.opSpans, call.at) && effectful.has(call.name))) { effectful.add(fn.name); grew = true; }
    }
  }
  return {fns, opBodies, effectful, inside};
}

/** Tab effects reached from outside the queue, as `caller→callee` edges (or `fn` for a direct
 * effect): none. */
const OUTSIDE_QUEUE_UNTIL_MOVED = new Set([]);
test('guard (I1): every tab effect is reached only from inside a tab operation', () => {
  const {fns, opBodies, effectful, inside} = callGraph(source('extension/background.js'));
  assert.ok(opBodies.has('pollProviderBody') && opBodies.has('cleanupProviderBody') && opBodies.has('probeTabOwner'), 'sanity: the operation bodies are found');
  assert.ok(effectful.has('askPage') && effectful.has('closeProvenTab') && effectful.has('allocateProviderTab'), 'sanity: the effects are found');
  const outside = [];
  for (const fn of fns.values()) {
    if (opBodies.has(fn.name)) continue;
    if (fn.effects.some(e => !inside(fn.opSpans, e.at))) outside.push(fn.name);
    for (const call of fn.calls) {
      const callee = fns.get(call.name);
      if (!call.called || inside(fn.opSpans, call.at) || !effectful.has(call.name)) continue;
      // The boundary: outside code calling into code that performs a tab effect.
      if (opBodies.has(call.name) || callee.effects.length) outside.push(`${fn.name}→${call.name}`);
    }
  }
  assert.deepEqual([...new Set(outside)].filter(edge => !OUTSIDE_QUEUE_UNTIL_MOVED.has(edge)).sort(), []);
});
test('guard (I2, R2): an operation body never waits for another operation, a single-flight lane or a bridge call', () => {
  const {fns, opBodies} = callGraph(source('extension/background.js'));
  // An entry: a function that queues an operation (and waits for it).
  const entries = new Set([...fns.values()].filter(fn => fn.opSpans.length).map(fn => fn.name));
  const blocking = new Set(['tabOp', 'singleFlight', 'joinLanes', 'api', 'heartbeat', 'flushProgress', ...entries]);
  const found = [];
  for (const name of opBodies) {
    // (`void` schedules without waiting, which R1 allows: the inventory schedules its probes.)
    for (const call of fns.get(name).calls) if (call.called && !call.void && blocking.has(call.name)) found.push(`${name}→${call.name}`);
  }
  assert.deepEqual([...new Set(found)].sort(), []);
});
test('guard (I2): no ordered storage write waits for a tab operation', () => {
  const {fns, inside} = callGraph(source('extension/background.js'));
  const reaches = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    const fn = fns.get(name);
    return fn.opSpans.length > 0 || fn.calls.some(call => call.called && reaches(call.name, seen));
  };
  const found = [];
  for (const fn of fns.values()) {
    for (const call of fn.calls) if (inside(fn.orderSpans, call.at) && reaches(call.name)) found.push(`${fn.name}→${call.name}`);
  }
  assert.deepEqual(found, []);
});

// ── Interleavings.

const TEMP = 'https://chatgpt.com/?temporary-chat=true';
function leg(state = {}) {
  return {jobId: 'job-A', origin: 'http://bridge', leaseId: 'lease-A', prompt: 'PROMPT', providers: ['chatgpt'],
    states: {chatgpt: {runId: 'run-A', ...state}}};
}
function worker(job, {tab, session = storage(), handler} = {}) {
  const api = async (_path, body) => (body?.action === 'ping' ? {ok: true, active: true, accepted: true, status: 'awaiting_chat'} : {ok: true, job: null});
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {[job.jobId]: job}}), session,
    tabs: new Map(tab ? [[tab.id, tab]] : []), api, handler});
  b.context.crypto = webcrypto; b.context.TextEncoder = TextEncoder;
  b.pending = () => b.local.state.pendingReviewJobs[job.jobId];
  b.jobs = () => b.context.workerJobs('http://bridge');
  return b;
}
const createdHere = () => storage({'ashlar:tab:10': {jobId: 'job-A', provider: 'chatgpt', runId: 'run-A', closedKey: 'ashlar:closed:job-A:chatgpt:run-A', closing: false}});

// CE-2: saveJobs persists the shared registry whenever any lane saves (a sibling leg's delivery, a
// heartbeat claim). A tab id the leg named before its owned-tab record was written would be persisted
// without it: after a worker stop, that tab could not be proven the leg's.
test('a registry save by another lane during an allocation never persists a tab id without its creation record', async () => {
  const b = worker(leg());
  const jobs = await b.jobs();
  const set = b.session.set;
  let seen;
  b.session.set = async values => {
    if (!seen && Object.keys(values).some(key => /^ashlar:tab:\d+$/.test(key))) {
      await b.context.saveJobs(jobs); // another lane saves the registry now
      seen = structuredClone(b.local.state.pendingReviewJobs['job-A'].states.chatgpt);
    }
    return set(values);
  };
  await b.tick();
  assert.ok(seen, 'the allocation wrote its creation record');
  assert.equal(seen.tabId, undefined, 'the persisted leg does not name the tab yet');
  assert.equal(seen.allocating, true, 'only the intent is persisted');
  const state = b.pending().states.chatgpt;
  assert.ok(Number.isInteger(state.tabId) && b.session.state[`ashlar:tab:${state.tabId}`], 'then the leg names the tab its record proves');
});
// D1: a run message's `until` follows the reply window its send actually has. With less than
// MIN_DISPATCH_WINDOW_MS of the operation's budget left, the poll does not dispatch: the next does.
test('a poll with less than 8 s of its budget left does not dispatch; the next poll does', async () => {
  const b = worker(leg({tabId: 10, started: false}), {session: createdHere(), tab: {id: 10, url: TEMP, status: 'complete'}});
  const RealDate = Date;
  let shift = 0, spend = true;
  b.context.Date = class extends RealDate { static now() { return RealDate.now() + shift; } };
  const get = b.chrome.tabs.get;
  b.chrome.tabs.get = async id => {
    // The poll's reads took 25 s of its 30 s budget (a slow browser).
    if (spend && id === 10 && vm.runInContext('activeOp?.kind', b.context) === 'poll') { spend = false; shift += 25_000; }
    return get(id);
  };
  await b.tick();
  assert.equal(b.messages.some(m => m.type === 'ashlar-run'), false, 'not dispatched with 5 s left');
  assert.equal(b.pending().states.chatgpt.started, false);
  await b.tick();
  const runs = b.messages.filter(m => m.type === 'ashlar-run');
  assert.equal(runs.length, 1, 'dispatched by the next poll');
  assert.ok(runs[0].until - b.context.Date.now() > 8_000 && runs[0].until - b.context.Date.now() <= 10_000, `until from a full window: ${runs[0].until - b.context.Date.now()}`);
});
// R6: an operation takes only ids from its caller and re-reads the registry when it starts: a job
// that retired (or was reset) while its operation waited in the queue is not acted on.
test('a poll and a release queued for a job that retired meanwhile do nothing', async () => {
  const b = worker(leg({tabId: 10, started: false, delivered: true, cleanupPending: true, outcome: {ok: false, code: 'error', error: 'x'}}),
    {session: createdHere(), tab: {id: 10, url: TEMP, status: 'complete'}, handler: () => ({ok: true, releaseProtocol: 1, ownership: 'owned', blank: true, url: TEMP})});
  const jobs = await b.jobs();
  const job = jobs['job-A'];
  let release;
  const held = b.op(() => new Promise(resolve => { release = resolve; }));
  assert.ok(await until(() => release), 'the queue is held');
  const queued = [b.context.cleanupProvider(job, 'chatgpt', jobs), b.context.pollProvider(job, 'chatgpt', jobs)];
  delete jobs['job-A'];
  release();
  await held;await Promise.all(queued);
  assert.deepEqual(b.messages.filter(m => m.id === 10), [], 'its tab is never messaged');
  assert.deepEqual([b.closedTabs, [...b.tabs.keys()]], [[], [10]], 'nothing closed or opened');
  assert.equal(job.states.chatgpt.cleanupDone, undefined);
});
test('operations run one at a time, in the order they were queued', async () => {
  const b = worker(leg());
  const order = [];
  let release;
  const first = b.op(async () => { order.push('first:start'); await new Promise(resolve => { release = resolve; }); order.push('first:end'); });
  const second = b.op(async () => { order.push('second'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first:start'], 'the second waits');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  assert.equal(b.queue.overlapped, false);
  // A failed operation does not block the next.
  await assert.rejects(b.op(async () => { throw new Error('boom'); }));
  assert.equal(await b.op(async () => 'next'), 'next');
});

// ── Capture and repair (the review-JSON lanes): their bridge calls stay outside the queue, their
// page steps (the source read, the capture receipt, the repair receipt) run inside it.
const TEXT = 'not json at all';
const durable = {id: 'capture-A', archiveDurable: true, responseId: 'response-A', text: TEXT, context: '[]', sourceHash: 'h', totalChars: TEXT.length};
const pageSource = {text: TEXT, totalChars: TEXT.length, truncated: false, completed: true, stable: true, responseId: 'response-A', context: '[]'};
function reviewLeg(state) {
  return {...leg({tabId: 10, started: true, ...state}), captureProtocol: 1};
}
const pageAnswers = (_id, m) => (m.type === 'ashlar-repair-source' ? {ok: true, source: pageSource}
  : m.type === 'ashlar-capture-accepted' || m.type === 'ashlar-repair-accepted' ? {ok: true, accepted: true}
    : m.type === 'ashlar-can-close' ? {ok: true, releaseProtocol: 1, ownership: 'owned', url: 'https://chatgpt.com/c/managed', conversation: 'https://chatgpt.com/c/managed'}
      : m.type === 'ashlar-tab-status' ? {ok: true} : {ok: false, code: 'busy', retry: true});
const kindsOf = (b, type) => [...new Set(b.effects.filter(e => e.type === type).map(e => e.kind))];
const captureApi = async (_path, body) => (body?.action === 'capture'
  ? {ok: true, capture: {id: 'capture-A', jobId: body.jobId, provider: body.provider, runId: body.runId, responseId: body.responseId, sourceHash: body.sourceHash, totalChars: body.source.text.length}}
  : body?.action === 'ping' ? {ok: true, active: true, accepted: true, status: 'awaiting_chat', bridge: {captureProtocol: 1, localJsonRepairEnabled: false}} : {ok: true, job: null});
for (const [what, state, run, types] of [
  ['the source read and the capture receipt', {observation: {state: 'response_completed_json_invalid', text: TEXT}},
    (b, jobs) => b.context.captureProvider(jobs['job-A'], 'chatgpt', jobs), {'ashlar-repair-source': 'sourceRead', 'ashlar-capture-accepted': 'captureCommit'}],
  ['a committed capture receipt', {formatError: true, outcome: {ok: true, raw: TEXT}, sourceCapture: durable},
    (b, jobs) => b.context.captureProvider(jobs['job-A'], 'chatgpt', jobs), {'ashlar-capture-accepted': 'captureCommit'}],
  ['the repair receipt', {delivered: true, repairReceiptPending: true, outcome: {ok: true, raw: '{}'}, repairAttempt: {id: 'repair-A', raw: '{}', text: TEXT, responseId: 'response-A', sourceHash: 'h', status: 'accepted'}},
    (b, jobs) => b.context.notifyRepairReceipt(jobs['job-A'], 'chatgpt', jobs), {'ashlar-repair-accepted': 'repairReceipt'}],
]) {
  test(`${what}: the page is messaged only inside the tab queue, and no bridge call runs inside an operation`, async () => {
    const b = worker(reviewLeg(state), {session: createdHere(), tab: {id: 10, url: 'https://chatgpt.com/c/managed', status: 'complete'}, handler: pageAnswers});
    b.context.api = (orig => async (path, body, ...rest) => { await orig(path, body, ...rest); return captureApi(path, body); })(b.context.api);
    const jobs = await b.jobs();
    await run(b, jobs);
    for (const [type, kind] of Object.entries(types)) assert.deepEqual(kindsOf(b, type), [kind], `${type} runs in ${kind}`);
    assert.deepEqual(b.queue.bridgeInOp, [], 'no bridge call inside an operation');
    assert.deepEqual(kindsOf(b, 'ashlar-can-close'), ['release'], 'the release it enables follows in its own operation');
  });
}
// W3: the capture lane against the next tick's poll of the same leg. The poll waits for its harvest
// reply; the capture lane's page messages (and the release they enable) wait for it: no message to
// the tab while another is unanswered, the tab closed once, and no owned record left for it.
test('a capture commit and the next tick\'s harvest of the same leg never interleave: the tab is closed once, and no owned record survives it', async () => {
  const b = worker(reviewLeg({observation: {state: 'response_completed_json_invalid', text: TEXT}}), {session: createdHere(),
    tab: {id: 10, url: 'https://chatgpt.com/c/managed', status: 'complete'}, handler: pageAnswers});
  b.context.api = (orig => async (path, body, ...rest) => { await orig(path, body, ...rest); return captureApi(path, body); })(b.context.api);
  const jobs = await b.jobs();
  const send = b.chrome.tabs.sendMessage;
  let held, outstanding = 0;
  const overlapping = [];
  b.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (outstanding) overlapping.push(msg.type);
    if (msg.type === 'ashlar-harvest' && !held) { outstanding++; b.messages.push({id, ...msg}); held = () => { outstanding--; send(id, msg, cb); }; return; }
    return send(id, msg, cb);
  };
  const ticked = b.tick();
  assert.ok(await until(() => held), 'the poll waits for its harvest reply');
  const lanes = vm.runInContext('captureLanes', b.context);
  const captured = b.context.singleFlight(lanes, 'http://bridge:job-A:chatgpt', () => b.context.captureProvider(jobs['job-A'], 'chatgpt', jobs));
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(overlapping, [], 'the capture lane waits for the poll');
  held();
  await Promise.all([ticked, captured]);
  await b.queueIdle();
  assert.deepEqual(overlapping, [], 'no page message while another is unanswered');
  assert.deepEqual(b.closedTabs, [10], 'closed once');
  assert.equal(b.session.state['ashlar:tab:10'], undefined, 'no owned record survives the closed tab');
});

// ── Chrome's events inside an operation (commit 6): a replace, a close, a navigation or a discard
// reported while an operation runs is applied by its own operation after it (the re-key, the
// removal), and the operation itself checks the synchronously kept facts (liveTabId) before it reads
// an id as absent.

// W7: the inventory read the tab list before a replace A -> B. Its re-key (which moves the preserved
// record to B) runs after the inventory's own drops, so the record is never taken for a gone tab's.
test('an inventory that read the tab list before a replace keeps the preserved record, under the new id', async () => {
  const backstop = 'ashlar:preserved:job-A:chatgpt:run-A';
  const b = worker(leg({tabId: 10, started: true, delivered: true, cleanupDone: true}), {session: storage({[backstop]: {tabId: 10}}),
    tab: {id: 10, url: 'https://chatgpt.com/c/users-own', status: 'complete'},
    handler: (_id, m) => (m.type === 'ashlar-tab-status' ? {ok: true, ownershipProtocol: 1, jobId: 'job-A', runId: 'run-A', provider: 'chatgpt', released: true, url: 'https://chatgpt.com/c/users-own'} : {ok: true})});
  const query = b.chrome.tabs.query;
  let fired = false;
  b.chrome.tabs.query = async filter => {
    const tabs = await query(filter);
    if (!fired && !filter?.url) {
      fired = true;
      b.tabs.delete(10);b.tabs.set(11, {id: 11, url: 'https://chatgpt.com/c/users-own', status: 'complete'});
      b.context.rekeyReplacedTab(11, 10);
      // (Before the queue, the re-key ran beside the inventory and could finish before its drops.)
      await until(() => b.session.state[backstop]?.tabId === 11, 200);
    }
    return tabs;
  };
  await b.context.refreshTabInventory();
  await b.queueIdle();
  assert.ok(fired);
  assert.deepEqual(b.session.state[backstop], {tabId: 11}, 'the preserved record follows the tab, never dropped as stale');
});

// Q2: each operation shape, with a replace, a close, a navigation to the user's own conversation, or a
// discard fired just before its k-th chrome call (tabs or session storage), for every k. After the
// worker settles: the leg names the live id; a replaced tab is never read as absent; no owned record
// is left for a closed tab; a tab whose page moved before the close's own re-check of its URL is never
// removed (a move after that re-check is the O1 window of milliseconds); no fresh run starts in a tab
// off its new chat (a run message that races a move is refused by the page, json.js, and never counts
// as started).
const CONV = 'https://chatgpt.com/c/managed', OWN = 'https://chatgpt.com/c/users-own';
const Q2_SHAPES = {
  'a dispatching poll': {kinds: ['poll'], state: {started: false}, url: TEMP},
  'a harvesting poll': {kinds: ['poll'], state: {started: true, pageUrl: CONV}, url: CONV},
  'a closing release': {kinds: ['release'], state: {started: true, delivered: true, cleanupPending: true, answerDelivered: true, outcome: {ok: true, raw: '{}'}, conversation: CONV, pageUrl: CONV}, url: CONV},
  'a preserving release': {kinds: ['release'], state: {started: true, delivered: true, cleanupPending: true, answerDelivered: true, outcome: {ok: true, raw: '{}'}, conversation: CONV, pageUrl: CONV}, url: CONV, takenOver: true},
  'the inventory': {kinds: ['inventory', 'probe'], state: {started: true, pageUrl: CONV}, url: CONV},
  'a capture commit': {kinds: ['captureCommit'], state: {started: true, pageUrl: CONV, observation: {state: 'response_completed_json_invalid', text: TEXT}}, url: CONV, capture: true},
};
function q2World(shape, perturb) {
  const b = worker({...leg({tabId: 10, runId: 'run-A', ...shape.state}), ...(shape.capture ? {captureProtocol: 1} : {})},
    {session: createdHere(), tab: {id: 10, url: shape.url, status: 'complete'}});
  const page = {bound: shape.state.started, navigated: false, live: 10};
  const violations = [];
  const answer = (id, m) => {
    const tab = b.tabs.get(id);
    const unbound = {jobId: '', runId: '', provider: 'chatgpt'};
    if (page.navigated) {
      return m.type === 'ashlar-tab-status' ? {ok: true, ownershipProtocol: 1, ...unbound, released: false, url: tab.url}
        : m.type === 'ashlar-run' && !m.resume ? {ok: false, code: 'taken_over', cause: 'navigated', ...unbound} : {ok: false, code: 'job_mismatch', ...unbound};
    }
    if (m.type === 'ashlar-tab-status') return {ok: true, ownershipProtocol: 1, jobId: page.bound ? 'job-A' : '', runId: page.bound ? 'run-A' : '', provider: 'chatgpt', released: false, url: tab.url};
    if (m.type === 'ashlar-run') { if (!page.bound && !m.resume) page.bound = true; return {ok: false, code: 'busy', retry: true}; }
    if (m.type === 'ashlar-harvest') return page.bound ? {ok: false, code: 'busy', retry: true} : {ok: false, code: 'idle', ...unbound};
    if (m.type === 'ashlar-repair-source') return {ok: true, source: pageSource};
    if (m.type === 'ashlar-capture-accepted') return {ok: true, accepted: true};
    if (m.type === 'ashlar-can-close' || m.type === 'ashlar-fix-cancel') {
      return shape.takenOver ? {ok: true, releaseProtocol: 1, ownership: 'takenOver', cause: 'user_turn', url: tab.url, conversation: CONV}
        : {ok: true, releaseProtocol: 1, ownership: 'owned', url: tab.url, conversation: CONV};
    }
    return {ok: true};
  };
  b.chrome.tabs.sendMessage = (id, msg, cb) => {
    b.messages.push({id, ...msg});
    const tab = b.tabs.get(id);
    if (msg.type === 'ashlar-run' && !msg.resume && tab && !b.context.samePage(tab.url, TEMP)) page.runOffNewChat = true;
    if (!tab || tab.discarded) { b.chrome.runtime.lastError = {message: tab ? 'Could not establish connection. Receiving end does not exist.' : `No tab with id: ${id}.`};cb();b.chrome.runtime.lastError = null;return; }
    cb({jobId: msg.jobId, runId: msg.runId, provider: msg.provider, ...answer(id, msg)});
  };
  b.chrome.scripting.executeScript = async ({target}) => { if (!b.tabs.get(target.tabId) || b.tabs.get(target.tabId).discarded) throw new Error('Cannot access contents of the page'); };
  b.chrome.tabs.reload = async id => { const tab = b.tabs.get(id); if (tab) Object.assign(tab, {discarded: false, status: 'complete'}); };
  const remove = b.chrome.tabs.remove;
  b.chrome.tabs.remove = async id => { if (page.navigated && page.navigatedAt <= page.lastGet) violations.push(`removed the user's tab ${id}`); return remove(id); };
  b.context.api = (orig => async (path, body, ...rest) => { await orig(path, body, ...rest); return captureApi(path, body); })(b.context.api);
  // The k-th chrome call inside an operation of the shape's kinds: the event fires just before it.
  let calls = 0;
  const counted = (target, name) => {
    const real = target[name];
    target[name] = (...args) => {
      if (shape.kinds.includes(vm.runInContext('activeOp?.kind', b.context))) {
        if (++calls === perturb?.k) { page.firedAt = calls; perturb.fire(b, page); }
        if (target === b.chrome.tabs && name === 'get') page.lastGet = calls;
      }
      return real.apply(target, args);
    };
  };
  for (const name of ['get', 'query', 'sendMessage', 'create', 'remove', 'reload']) counted(b.chrome.tabs, name);
  for (const name of ['get', 'set', 'remove']) counted(b.session, name);
  b.calls_ = () => calls;
  b.violations = violations;
  b.page = page;
  return b;
}
const Q2_EVENTS = {
  replace: (b, page) => { const tab = b.tabs.get(page.live); if (!tab) return; b.tabs.delete(tab.id);page.live = tab.id + 100;b.tabs.set(page.live, {...tab, id: page.live});page.replaced = tab.id;b.context.rekeyReplacedTab(page.live, tab.id); },
  close: (b, page) => { if (!b.tabs.has(page.live)) return; b.tabs.delete(page.live);page.closed = page.live;b.context.rememberClosedTab(page.live, {isWindowClosing: false}); },
  navigate: (b, page) => { const tab = b.tabs.get(page.live); if (!tab) return; tab.url = OWN;page.navigated = true;page.navigatedAt = page.firedAt ?? Infinity;page.boundBefore = page.bound;b.context.noteTabUpdated(tab.id, {url: OWN}); },
  discard: (b, page) => { const tab = b.tabs.get(page.live); if (!tab) return; Object.assign(tab, {discarded: true, status: 'unloaded'}); },
};
async function settle(b) {
  const RealDate = Date;let shift = 0;
  b.context.Date = class extends RealDate { static now() { return RealDate.now() + shift; } };
  for (let i = 0; i < 5; i++) { await b.tick();await b.queueIdle();shift += 3 * 60_000; }
}
for (const [what, shape] of Object.entries(Q2_SHAPES)) {
  test(`Q2: ${what}, with a replace, a close, a navigation or a discard before any of its chrome calls, holds every invariant`, async () => {
    const base = q2World(shape);
    await base.tick();await base.queueIdle();
    const total = base.calls_();
    assert.ok(total > 0, `sanity: ${what} ran (${total} chrome calls)`);
    const found = [];
    for (const [event, fire] of Object.entries(Q2_EVENTS)) {
      for (let k = 1; k <= total; k++) {
        const b = q2World(shape, {k, fire});
        await settle(b);
        const page = b.page, state = b.pending()?.states.chatgpt;
        const history = (state?.workerEvents || []).map(e => e.stage);
        const bad = [...b.violations];
        if (page.replaced !== undefined) {
          if (state && !state.cleanupDone && state.tabId !== page.live) bad.push(`leg names ${state.tabId}, live ${page.live}`);
          if (history.includes('tab_lost') || b.calls.some(c => c.action === 'failure' && /^tab_closed/.test(c.error || ''))) bad.push('replaced tab read as absent');
        }
        if (page.closed !== undefined && b.session.state[`ashlar:tab:${page.closed}`]) bad.push('owned record left for the closed tab');
        if (page.navigated && !page.boundBefore && state?.started === true) bad.push('a run refused off its new chat counted as started');
        if (page.navigated && !page.boundBefore && (b.closedTabs.length || page.bound)) bad.push('a fresh run started, or its tab closed, off its new chat');
        if (bad.length) found.push(`${event}@${k}: ${[...new Set(bad)].join('; ')}`);
      }
    }
    assert.deepEqual(found, []);
  });
}

// ── The sweep, retirement and the hard reset (commit 7).

// W1: the sweep abandons a job whose poll is between its run message and saving `started`. The
// abandon is an operation: it runs after that poll, so the release that follows sees the dispatched
// run (it stops it with fix-cancel, never the undispatched fence), and nothing else ends the leg.
for (const kind of ['review', 'fix']) {
  test(`${kind}: the sweep's abandon of a job whose poll is sending its run waits for that poll; the release stops the dispatched run`, async () => {
    const job = {...leg({tabId: 10, started: false}), ...(kind === 'fix' ? {kind: 'fix'} : {})};
    const server = {status: 'awaiting_chat'};
    let reply;
    const b = worker(job, {session: createdHere(), tab: {id: 10, url: TEMP, status: 'complete'},
      handler: (_id, m) => (m.type === 'ashlar-tab-status' ? {ok: true}
        : m.type === 'ashlar-can-close' || m.type === 'ashlar-fix-cancel' ? {ok: true, releaseProtocol: 1, ownership: 'owned', url: TEMP} : {ok: false, code: 'busy', retry: true})});
    b.context.api = (orig => async (path, body, ...rest) => { await orig(path, body, ...rest);
      return body?.action === 'ping' ? (server.status === 'awaiting_chat' ? {ok: true, active: true, accepted: true, status: server.status} : {ok: true, active: false, status: server.status}) : {ok: true, job: null}; })(b.context.api);
    const send = b.chrome.tabs.sendMessage;
    b.chrome.tabs.sendMessage = (id, msg, cb) => {
      if (msg.type === 'ashlar-run' && !reply) { b.messages.push({id, ...msg}); reply = () => send(id, msg, cb); return; }
      return send(id, msg, cb);
    };
    const ticking = b.tick();
    assert.ok(await until(() => reply), 'the poll sent its run message');
    // The server cancels the job; the next heartbeat records it, and the sweep takes it.
    server.status = 'cancelled';
    await b.context.heartbeatTick();
    const sweeping = b.context.clearStuckJobs();
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    const jobs = await b.jobs();
    assert.equal(jobs['job-A'].states.chatgpt.abandoned, undefined, 'the abandon waits for the poll');
    reply();
    await Promise.all([ticking, sweeping]);
    await b.queueIdle();
    const stops = b.messages.filter(m => m.id === 10 && m.type === 'ashlar-fix-cancel');
    assert.ok(stops.length >= 1, 'the dispatched run is stopped');
    assert.equal(b.messages.some(m => m.undispatched === true), false, 'never the undispatched fence');
    assert.equal(b.calls.some(c => c.action === 'failure' || c.action === 'complete'), false, 'nothing else ends the leg');
    const state = (await b.jobs())['job-A']?.states.chatgpt;
    assert.ok(!state || (state.started === true && state.abandoned === true), 'abandoned after the poll recorded its dispatch');
  });
}
// W12: a hard reset is an operation: every later operation does nothing, and no registry write from
// a lane that still holds the old registry lands after it (the reload follows).
test('operations queued behind a hard reset do nothing, and no registry write lands after it', async () => {
  const b = worker(leg({tabId: 10, started: false}), {session: createdHere(), tab: {id: 10, url: TEMP, status: 'complete'}});
  const jobs = await b.jobs();
  let release;
  const held = b.op(() => new Promise(resolve => { release = resolve; }));
  assert.ok(await until(() => release));
  const reset = b.context.hardReset();
  const polled = b.context.pollProvider(jobs['job-A'], 'chatgpt', jobs);
  release();
  await held;
  assert.equal((await reset)?.ok, true);
  await polled;
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'the registry is empty');
  assert.deepEqual(b.messages.filter(m => m.type === 'ashlar-run'), [], 'the queued poll did nothing');
  jobs['job-A'].states.chatgpt.note = 'late';
  await b.context.saveJobs(jobs);
  assert.deepEqual(b.local.state.pendingReviewJobs, {}, 'a lane holding the old registry writes nothing');
  assert.equal(Object.keys(await b.context.workerJobs('http://bridge')).length, 0, 'the cached registry is empty');
});
