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
 * effect), until their lanes move into it: capture and repair (commit 5), the stall sweep (commit 7). */
const OUTSIDE_QUEUE_UNTIL_MOVED = new Set([
  'captureProvider→askPage', 'notifyRepairReceipt→askPage', 'readRepairSource→askPage', 'providerTabGone→findOriginalTab',
]);
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
