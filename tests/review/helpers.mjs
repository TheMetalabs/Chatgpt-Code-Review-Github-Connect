import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const source = name => fs.readFileSync(new URL(name, `file://${root}`), 'utf8');
export const raw = JSON.stringify({ findings: [{ severity: 'P1', file: 'x.ts', line: 1, title: 'Bug', failure_scenario: 'a real finding' }], merge_recommendation: 'REQUEST_CHANGES' });
export function storage(initial = {}) {
  const state = structuredClone(initial);
  return { state,
    get: async keys => Object.fromEntries((keys == null ? Object.keys(state) : [].concat(keys)).map(k => [k, structuredClone(state[k])])),
    set: async values => { Object.assign(state, structuredClone(values)); },
    remove: async keys => { for (const k of [].concat(keys)) delete state[k]; },
  };
}
export const flush = () => new Promise(resolve => setImmediate(resolve));
export function content(provider = 'chatgpt', persisted = new Map()) {
  const listeners = [];
  const context = vm.createContext({ console, sessionStorage: { getItem: key => persisted.get(key), setItem: (key, value) => persisted.set(key, value) }, chrome: { runtime: { onMessage: { addListener: fn => listeners.push(fn), removeListener: fn => { const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1); } } } } });
  for (const file of ['quota.js', 'model.js', 'json.js', `content-${provider}.js`]) {
    vm.runInContext(source(`extension/${file}`), context, { filename: file });
  }
  context.stopButtonVisible = () => true;
  context.replyDoneVisible = () => false;
  context.assistantCorpus = () => [raw];
  context.quotaHit = () => false;
  return { context, listeners, message(msg) { let reply; listeners[0](msg, {}, r => { reply = r; }); return reply; } };
}
export function background({ local = storage({ origin: 'http://bridge', token: 'token' }), session = storage(), handler, tabs = new Map(), api } = {}) {
  const messages = [], calls = [], closedTabs = []; const removed = [];
  let nextTab = Math.max(100, ...tabs.keys());
  const chrome = {
    storage: { local, session }, runtime: { lastError: null },
    alarms: { create: async () => {}, clear: async () => {} },
    tabs: {
      onRemoved: { addListener: fn => removed.push(fn) },
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
  const context = vm.createContext({ console, chrome, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, URL, AbortSignal, crypto: {randomUUID: () => "fixture-client"} });
  const code = source('extension/background.js');
  vm.runInContext(code.slice(0, code.indexOf('\nchrome.alarms.onAlarm.addListener')), context, { filename: 'background.js' });
  if (context.rememberClosedTab) chrome.tabs.onRemoved.addListener(context.rememberClosedTab);
  context.waitTab = async () => {};
  let sleeps = 0;
  context.sleep = async () => { if (++sleeps > 8) throw new Error("test-only polling guard: tick did not return"); };
  context.api = async (path, body) => { calls.push({ path, ...body }); return api ? api(path, body) : { ok: true, job: null }; };
  return { context, local, session, tabs, messages, calls, closedTabs, chrome, closeTab: async id => { tabs.delete(id); for (const fn of removed) await fn(id, {isWindowClosing:false}); }, tick: () => context.tick() };
}
