import fs from 'node:fs';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const source = name => fs.readFileSync(new URL(name, `file://${root}`), 'utf8');
// A schema-VALID review payload: completeBridgeJob accepts it as-is (no salvage/repair), so ACK-flow
// tests can assert the stored leg equals it. (A finding missing required fields would now be salvaged.)
export const raw = JSON.stringify({ findings: [{ severity: 'P1', file: 'x.ts', line: 1, side: 'RIGHT', title: 'Bug', failure_scenario: 'a real finding', root_cause: 'missing lock', evidence: 'x.ts:1: commit()', recommended_fix: 'hold the lock', recommended_test: 'two concurrent writes' }], merge_recommendation: 'REQUEST_CHANGES' });
export function storage(initial = {}) {
  const state = structuredClone(initial);
  return { state,
    get: async keys => Object.fromEntries((keys == null ? Object.keys(state) : [].concat(keys)).map(k => [k, structuredClone(state[k])])),
    set: async values => { Object.assign(state, structuredClone(values)); },
    remove: async keys => { for (const k of [].concat(keys)) delete state[k]; },
  };
}
export const flush = () => new Promise(resolve => setImmediate(resolve));
/** Flush until `check()` holds or `ms` of wall clock passed; returns whether it held. For steps
 * that finish off the event loop (webcrypto digests run on the threadpool): a fixed flush count
 * races them and fails under CPU load. Callers still assert the condition, with their message. */
export async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await flush();
  }
  return true;
}
/** The page a provider tab is opened on (background.js providerUrl): where a new run may start. */
export const allocationUrl = provider => (provider === 'grok' ? 'https://grok.com/' : 'https://chatgpt.com/?temporary-chat=true');
export function content(provider = 'chatgpt', persisted = new Map()) {
  const listeners = [];
  // The page shows the new chat its tab was opened on (a row that needs another page sets its own).
  const context = vm.createContext({ console, URL, location: { href: allocationUrl(provider) }, sessionStorage: { getItem: key => persisted.get(key), setItem: (key, value) => persisted.set(key, value) }, chrome: { runtime: { onMessage: { addListener: fn => listeners.push(fn), removeListener: fn => { const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1); } } } } });
  for (const file of ['quota.js', 'model.js', 'json.js', `content-${provider}.js`]) {
    vm.runInContext(source(`extension/${file}`), context, { filename: file });
  }
  // This lightweight runner fixture represents an already accepted legacy request.
  // Real submission/DOM/journal boundaries are tested in submission.e2e.mjs.
  context.resumeSubmission = async () => {};
  context.stopButtonVisible = () => true;
  context.replyDoneVisible = () => false;
  context.assistantCorpus = () => [raw];
  context.quotaHit = () => false;
  // A run message carries the page it may start on and its deadline, as the worker's does (a row
  // that tests the fresh-page check or the deadline names its own).
  const stamp = msg => (msg?.type === 'ashlar-run'
    ? {...('allocationUrl' in msg ? {} : {allocationUrl: allocationUrl(provider)}), ...('until' in msg ? {} : {until: vm.runInContext('Date.now()', context) + 10_000}), ...msg}
    : msg);
  return { context, listeners, message(msg) { let reply; listeners[0](stamp(msg), {}, r => { reply = r; }); return reply; } };
}
export function background({ local = storage({ origin: 'http://bridge', token: 'token' }), session = storage(), handler, tabs = new Map(), api } = {}) {
  const messages = [], calls = [], closedTabs = []; const removed = [], replaced = [];
  let nextTab = Math.max(100, ...tabs.keys());
  const chrome = {
    storage: { local, session }, runtime: { lastError: null },
    alarms: { create: async () => {}, clear: async () => {} },
    tabs: {
      onRemoved: { addListener: fn => removed.push(fn) },
      onReplaced: { addListener: fn => replaced.push(fn) },
      remove: async id => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`); closedTabs.push(id); tabs.delete(id); for (const fn of removed) await fn(id, {isWindowClosing:false}); },
      query: async () => [...tabs.values()],
      get: async id => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`); return tabs.get(id); },
      create: async ({ url }) => { const tab = { id: ++nextTab, url, status: 'complete' }; tabs.set(tab.id, tab); return tab; },
      sendMessage(id, msg, cb) {
        messages.push({ id, ...msg });
        if (!tabs.has(id)) { chrome.runtime.lastError = { message: `No tab with id: ${id}.` }; cb(); chrome.runtime.lastError = null; return; }
        let result = handler ? handler(id, msg) : { ok: false, code: 'busy', retry: true };
        // Protocol fields are fixtures, not assertions: explicit wrong IDs in tests win.
        result = {jobId:msg.jobId, provider:msg.provider, runId:msg.runId, ...result};
        if (msg.type === 'ashlar-can-close' && result.canClose === undefined && result.code !== 'job_mismatch') {
          result = {...result, ok:true, canClose:result.ok === true || ['quota','empty','error'].includes(result.code), url:tabs.get(id).url};
        }
        cb(result);
      },
    },
    scripting: { executeScript: async () => {} },
  };
  const context = vm.createContext({ console, chrome, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, URL, AbortSignal, AbortController, crypto: {randomUUID: () => "fixture-client"} });
  const code = source('extension/background.js');
  vm.runInContext(code.slice(0, code.indexOf('\nchrome.alarms.onAlarm.addListener')), context, { filename: 'background.js' });
  // The tab queue (#85): each tab effect is recorded with the kind of operation it ran in (undefined:
  // none), and `queue.overlapped` says whether two operation bodies ever ran at once.
  const opContext = new AsyncLocalStorage(), effects = [], queue = {overlapped: false, running: 0};
  const recorded = (target, name, effect) => {
    let fn = target[name];
    Object.defineProperty(target, name, {configurable: true, enumerable: true, set: value => { fn = value; },
      get: () => { const current = fn; return current && ((...args) => { effects.push({effect, kind: opContext.getStore()?.kind}); return current(...args); }); }});
  };
  for (const [name, effect] of [['sendMessage', 'message'], ['create', 'create'], ['remove', 'remove'], ['reload', 'reload']]) recorded(chrome.tabs, name, effect);
  recorded(chrome.scripting, 'executeScript', 'inject');
  if (context.tabOp) {
    const tabOp = context.tabOp;
    context.tabOp = (kind, body) => tabOp(kind, () => opContext.run({kind}, async () => {
      if (++queue.running > 1) queue.overlapped = true;
      try { return await body(); } finally { queue.running--; }
    }));
  }
  if (context.rememberClosedTab) chrome.tabs.onRemoved.addListener(context.rememberClosedTab);
  if (context.rekeyReplacedTab) chrome.tabs.onReplaced.addListener(context.rekeyReplacedTab);
  context.waitTab = async () => {};
  let sleeps = 0;
  context.sleep = async () => { if (++sleeps > 8) throw new Error("test-only polling guard: tick did not return"); };
  const rpc = context.api;
  context.api = async (path, body, origin, signal) => { calls.push({ path, ...body }); return api ? api(path, body, origin, signal) : { ok: true, job: null }; };
  return { context, rpc, local, session, tabs, messages, calls, closedTabs, chrome, effects, queue,
    /** Run `fn` as one operation in the tab queue (a direct call of an operation body). */
    op: (fn, kind = 'test') => context.tabOp(kind, fn),
    queueIdle: () => context.tabQueueIdle(),
    closeTab: async id => { tabs.delete(id); for (const fn of removed) await fn(id, {isWindowClosing:false}); },
    // Chrome swapped tab `removedId`'s page into `tab` (a new id): onReplaced(added, removed), no onRemoved.
    replaceTab: async (removedId, tab) => { tabs.delete(removedId); tabs.set(tab.id, tab); for (const fn of replaced) await fn(tab.id, removedId); },
    tick: () => context.tick() };
}
