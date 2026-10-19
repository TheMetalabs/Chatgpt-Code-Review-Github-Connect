// Live 2026-10-20 (Mac Studio Chrome): 34 of 35 tabs were grok.com, mostly completed Ashlar reviews and
// duplicate Grok homes, although #167 (close on collect) and #169 (leftover reclaim) were deployed.
// A completed Grok review whose page cannot prove the close (its URL moved to /c/<id> with no pin, or
// the tab is frozen/discarded) is PRESERVED: the leg ends, the job retires, every session record naming
// the tab is dropped, and #169's reclaim can only name a tab whose live page answers: a frozen one never
// does. The worker now keeps a durable ledger of the Grok tabs it opened and a stale sweep closes what
// it names once the leg ended or its job vanished. These rows pin that lifecycle end to end.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {background, storage, raw, flush} from './helpers.mjs';
import {bridgeHarness, job as makeJob, loadTs} from './load-source.mjs';

const MIN = 60_000;
const GROK = 'https://grok.com/';
const CONV = 'https://grok.com/c/abc';
const CHATGPT = 'https://chatgpt.com/?temporary-chat=true';
const LEDGER = 'ashlar:tabLedger';
const LOG = 'ashlar:tabLog';

const entry = (tabId, extra = {}) => ({tabId, jobId: `old-${tabId}`, runId: `run-${tabId}`, createdAt: Date.now() - 60 * MIN, ...extra});
const events = b => (b.local.state[LOG]?.events || []).map(e => e.event);
const settled = async b => { await b.context.writeInOrder(async () => {}); await flush(); };
async function ticks(b, n = 2) { for (let i = 0; i < n; i++) { await b.tick(); await flush(); } await settled(b); }
function done(id, tabId, provider = 'grok', extra = {}) {
  return {jobId: id, origin: 'http://bridge', leaseId: 'lease-' + id, prompt: 'review', providers: [provider],
    states: {[provider]: {tabId, started: true, runId: id + '-run', outcome: {ok: true, raw, originalText: raw}, ...extra}}};
}
const OK_API = async () => ({ok: true, active: true, accepted: true, status: 'awaiting_chat'});
function rig({jobs = {}, ledger, tabs, handler, extra = {}, local} = {}) {
  return background({
    local: local || storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: jobs, ...(ledger ? {[LEDGER]: ledger} : {}), ...extra}),
    tabs, handler, api: OK_API,
  });
}
const ownedClose = url => (_id, msg) => msg.type === 'ashlar-can-close' ? {ok: true, canClose: true, ownership: 'owned', url, conversation: url} : {ok: false, code: 'busy'};
// The page of a finished review that Grok moved to /c/<id> without a pin: the verdict that preserves the tab.
const unpinned = (id, msg) => {
  if (msg.type === 'ashlar-tab-status') return id !== 10 ? {ok: true, ownershipProtocol: 1, jobId: '', runId: '', provider: 'grok', released: false, url: GROK} : {ok: true, ownershipProtocol: 1, jobId: 'A', runId: 'A-run', provider: 'grok', released: true, url: CONV};
  if (msg.type === 'ashlar-can-close') return {ok: true, canClose: false, ownership: 'unknown', identity: 'changed', cause: 'navigated', url: CONV};
  if (msg.type === 'ashlar-fix-cancel') return {ok: true, released: true};
  return {ok: false, code: 'busy'};
};

test('a completed Grok review closes its tab, leaves the ledger, and logs the close; personal tabs stay', async () => {
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete'}], [99, {id: 99, url: 'https://grok.com/c/personal', status: 'complete'}]]);
  const b = rig({jobs: {A: done('A', 10)}, tabs, handler: ownedClose(GROK), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
  await ticks(b);
  assert.deepEqual(b.closedTabs, [10]);
  assert.equal(b.tabs.has(99), true);
  assert.deepEqual(b.local.state[LEDGER], {}, 'a closed tab is no longer owned');
  assert.equal(events(b).includes('tab_closed'), true, JSON.stringify(events(b)));
});

test('a Grok tab the worker opens is recorded in the durable ledger the moment it exists', async () => {
  const tabs = new Map();
  const job = {jobId: 'N', origin: 'http://bridge', leaseId: 'l', prompt: 'review', providers: ['grok'], states: {grok: {}}};
  const b = rig({jobs: {N: job}, tabs});
  await ticks(b, 1);
  const [id] = [...b.tabs.keys()];
  assert.equal(Number.isInteger(id), true, 'a tab was opened');
  const owned = b.local.state[LEDGER][id];
  assert.equal(owned.jobId, 'N');
  assert.equal(typeof owned.runId, 'string');
  assert.equal(Number.isFinite(owned.createdAt), true);
  assert.equal(events(b).includes('tab_created'), true);
});

test('a finished Grok review the page cannot prove closable is kept, stays owned, and the stale sweep closes it after the grace (even frozen)', async () => {
  const tabs = new Map([[10, {id: 10, url: CONV, status: 'complete'}], [99, {id: 99, url: 'https://grok.com/c/personal', status: 'complete'}]]);
  const b = rig({jobs: {A: done('A', 10)}, tabs, handler: unpinned, ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
  await ticks(b);
  assert.deepEqual(b.closedTabs, [], 'the verdict keeps the tab');
  assert.deepEqual(Object.keys(b.local.state.pendingReviewJobs), [], 'the job retired');
  const kept = b.local.state[LEDGER][10];
  assert.equal(kept.how, 'preserved');
  assert.equal(kept.cause, 'navigated');
  assert.equal(Number.isFinite(kept.endedAt), true);
  tabs.get(10).frozen = true; // Chrome froze the hidden tab: its page can no longer answer #169's status probe
  const early = await b.context.sweepGrokTabs();
  assert.equal(early.closed, 0, 'inside the grace nothing is closed');
  assert.equal(b.tabs.has(10), true);
  const reclaim = await b.context.reclaimPreservedTabs({force: true});
  assert.equal(reclaim.closed, 0, 'the status-probe reclaim of #169 cannot name a frozen tab (the leak)');
  b.local.state[LEDGER][10].endedAt = Date.now() - 6 * MIN;
  const late = await b.context.sweepGrokTabs();
  assert.equal(late.closed, 1, JSON.stringify(late));
  assert.deepEqual(b.closedTabs, [10]);
  assert.equal(b.tabs.has(99), true, 'a grok.com tab the ledger does not name is never closed');
  assert.deepEqual(b.local.state[LEDGER], {});
  assert.equal(events(b).includes('tab_preserved') && events(b).includes('tab_closed_by_sweep'), true, JSON.stringify(events(b)));
});

test('ownership survives a service-worker restart and an extension reload: a new worker closes the tab the old one opened', async () => {
  const tabs = new Map();
  const first = rig({jobs: {N: {jobId: 'N', origin: 'http://bridge', leaseId: 'l', prompt: 'review', providers: ['grok'], states: {grok: {}}}}, tabs});
  await ticks(first, 1);
  const [id] = [...tabs.keys()];
  // The new worker: no memory, no session records (an extension reload clears storage.session), same storage.local and tabs.
  const persisted = structuredClone(first.local.state);
  delete persisted.pendingReviewJobs; // the job retired meanwhile (the registry no longer names the tab)
  persisted[LEDGER][id].endedAt = Date.now() - 10 * MIN;
  persisted[LEDGER][id].how = 'preserved';
  persisted[LEDGER][id].cause = 'unreachable';
  const second = rig({tabs, handler: unpinned, local: storage(persisted)});
  assert.equal(Object.keys(second.session.state).length, 0, 'no session ownership record');
  const swept = await second.context.sweepGrokTabs();
  assert.equal(swept.closed, 1, JSON.stringify(swept));
  assert.deepEqual(second.closedTabs, [id]);
});

test('a leg ended after the worker restarted still closes: the ledger names the tab although session records are gone', async () => {
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete'}]]);
  const b = rig({jobs: {A: done('A', 10)}, tabs, handler: ownedClose(GROK), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
  assert.equal(Object.keys(b.session.state).length, 0);
  await ticks(b);
  assert.deepEqual(b.closedTabs, [10]);
  assert.deepEqual(b.local.state[LEDGER], {});
});

test('stale sweep reclaims orphaned and completed Ashlar Grok tabs past their grace, and nothing else', async () => {
  const now = Date.now();
  const tabs = new Map([
    [1, {id: 1, url: CONV, status: 'complete'}],                      // ended, old: closed
    [2, {id: 2, url: 'https://grok.com/c/two', status: 'complete'}],  // orphan (job gone), older than the orphan grace: closed
    [3, {id: 3, url: 'https://grok.com/c/three', status: 'complete'}],// orphan inside the orphan grace: kept
    [4, {id: 4, url: CONV + '4', status: 'complete'}],                // ended 1 min ago: kept
    [5, {id: 5, url: CONV + '5', status: 'complete', active: true}],  // the user is looking at it: kept
    [6, {id: 6, url: CONV + '6', status: 'complete'}],                // a live leg works on it: kept
    [7, {id: 7, url: 'https://grok.com/c/personal', status: 'complete'}], // not in the ledger: the user's
    [8, {id: 8, url: 'https://chatgpt.com/c/x?temporary-chat=true', status: 'complete'}], // ChatGPT: out of scope
    [9, {id: 9, url: 'https://example.com/', status: 'complete'}],    // left grok.com: released from the ledger, not closed
  ]);
  const live = {jobId: 'L', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {tabId: 6, started: true, runId: 'L-run'}}};
  const b = rig({jobs: {L: live}, tabs, handler: (_id, msg) => msg.type === 'ashlar-can-close' ? {ok: true, ownership: 'unknown', cause: 'navigated'} : {ok: false, code: 'busy'},
    ledger: {
      1: entry(1, {endedAt: now - 10 * MIN, how: 'preserved', cause: 'navigated'}),
      2: entry(2, {createdAt: now - 50 * MIN}),
      3: entry(3, {createdAt: now - 20 * MIN}),
      4: entry(4, {endedAt: now - MIN, how: 'preserved', cause: 'unreachable'}),
      5: entry(5, {endedAt: now - 30 * MIN, how: 'preserved', cause: 'navigated'}),
      6: entry(6, {jobId: 'L', runId: 'L-run', createdAt: now - 90 * MIN}),
      9: entry(9, {endedAt: now - 30 * MIN, how: 'preserved', cause: 'navigated'}),
      77: entry(77, {endedAt: now - 30 * MIN}),                       // its tab is gone: dropped
    }});
  const result = await b.context.sweepGrokTabs();
  assert.deepEqual(b.closedTabs.sort((x, y) => x - y), [1, 2], JSON.stringify(result));
  assert.deepEqual([...b.tabs.keys()].sort((x, y) => x - y), [3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Object.keys(b.local.state[LEDGER]).map(Number).sort((x, y) => x - y), [3, 4, 5, 6]);
});

test('a forced reclaim skips the age grace but never closes the active tab or one the user opened after Ashlar finished', async () => {
  const now = Date.now();
  const tabs = new Map([
    [1, {id: 1, url: CONV, status: 'complete', active: true}],                       // the user is viewing it
    [2, {id: 2, url: CONV + '2', status: 'complete', lastAccessed: now}],             // opened after the leg ended
    [3, {id: 3, url: CONV + '3', status: 'complete'}],                                // young: force skips the grace
  ]);
  const b = rig({tabs, handler: unpinned, ledger: {
    1: entry(1, {endedAt: now - 30 * MIN, how: 'preserved', cause: 'navigated'}),
    2: entry(2, {endedAt: now - 30 * MIN, how: 'preserved', cause: 'navigated'}),
    3: entry(3, {endedAt: now - 10_000, how: 'preserved', cause: 'navigated'}),
  }});
  const result = await b.context.sweepGrokTabs({force: true});
  assert.deepEqual(b.closedTabs, [3], JSON.stringify(result));
  assert.equal(b.tabs.has(1), true, 'the active tab stays open');
  assert.equal(b.local.state[LEDGER][1].endedAt > 0, true, 'and stays owned');
  assert.equal(b.tabs.has(2), true);
  assert.equal(b.local.state[LEDGER][2], undefined, 'a tab the user opened is released, never closed');
});

test('the sweep releases a tab the user took over instead of closing it', async () => {
  const tabs = new Map([[1, {id: 1, url: CONV, status: 'complete'}]]);
  const b = rig({tabs, handler: (_id, msg) => msg.type === 'ashlar-can-close' ? {ok: true, ownership: 'takenOver', cause: 'draft'} : {ok: false},
    ledger: {1: entry(1, {endedAt: Date.now() - 30 * MIN, how: 'preserved', cause: 'navigated'})}});
  const result = await b.context.sweepGrokTabs();
  assert.equal(result.closed, 0);
  assert.equal(result.released, 1);
  assert.deepEqual(b.closedTabs, []);
  assert.deepEqual(b.local.state[LEDGER], {}, 'no longer owned: never swept again');
});

test('a user takeover preserved by the worker is never put in the ledger', async () => {
  const tabs = new Map([[10, {id: 10, url: CONV, status: 'complete'}]]);
  const b = rig({jobs: {A: done('A', 10)}, tabs, ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})},
    handler: (_id, msg) => msg.type === 'ashlar-can-close' ? {ok: true, canClose: false, ownership: 'takenOver', cause: 'user_turn', url: CONV}
      : msg.type === 'ashlar-fix-cancel' ? {ok: true, released: true} : {ok: false, code: 'busy'}});
  await ticks(b);
  assert.deepEqual(b.closedTabs, []);
  assert.deepEqual(b.local.state[LEDGER], {});
  b.local.state[LEDGER] = {10: entry(10, {endedAt: 1})};
  assert.equal((await b.context.sweepGrokTabs()).closed, 0, 'the page still says user_turn at the sweep too');
});

test('duplicate idle Ashlar Grok home tabs are closed past the grace; the user\'s home tab and a live leg\'s stay', async () => {
  const now = Date.now();
  const tabs = new Map([1, 2, 3, 4, 5, 6].map(id => [id, {id, url: GROK, status: 'complete'}]));
  tabs.get(3).active = false;
  const live = {jobId: 'L', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {tabId: 4, runId: 'L-run'}}};
  const b = rig({jobs: {L: live}, tabs,
    handler: (_id, msg) => msg.type === 'ashlar-can-close' ? {ok: false, code: 'job_mismatch'}
      : msg.type === 'ashlar-fix-cancel' ? {ok: true, owned: true, canClose: true, ownership: 'owned', blank: true} : {ok: false, code: 'busy'},
    ledger: {
      1: entry(1, {createdAt: now - 30 * MIN}), 2: entry(2, {createdAt: now - 40 * MIN}), 3: entry(3, {createdAt: now - 12 * MIN}),
      4: entry(4, {jobId: 'L', runId: 'L-run', createdAt: now - 30 * MIN}),
      5: entry(5, {createdAt: now - 2 * MIN}),
    }});
  await b.context.sweepGrokTabs();
  assert.deepEqual(b.closedTabs.sort(), [1, 2, 3]);
  assert.deepEqual([...b.tabs.keys()].sort(), [4, 5, 6], 'live leg, a fresh home, and the user\'s own home tab remain');
});

test('an ended Grok tab on /c/<id> whose page carries no binding is closed past the grace, not dropped; another job\'s binding is released', async () => {
  const now = Date.now();
  const tabs = new Map([[1, {id: 1, url: CONV, status: 'complete'}], [2, {id: 2, url: CONV + '2', status: 'complete'}], [3, {id: 3, url: CONV + '3', status: 'complete'}]]);
  const bound = {1: '', 2: 'other-job'};
  const b = rig({tabs, ledger: {
    1: entry(1, {endedAt: now - 30 * MIN, how: 'preserved', cause: 'navigated'}),
    2: entry(2, {endedAt: now - 30 * MIN, how: 'preserved', cause: 'navigated'}),
    3: entry(3, {endedAt: now - 30 * MIN, how: 'preserved', cause: 'navigated'}),
  }, handler: (id, msg) => {
    if (msg.type === 'ashlar-can-close') return {ok: false, code: 'job_mismatch'};
    if (msg.type === 'ashlar-tab-status') return id === 3 ? {ok: false} : {ok: true, ownershipProtocol: 1, jobId: bound[id], runId: '', provider: 'grok', released: false, url: tabs.get(id).url};
    return {ok: false, code: 'busy'};
  }});
  const result = await b.context.sweepGrokTabs();
  assert.deepEqual(b.closedTabs, [1], JSON.stringify(result));
  assert.equal(b.tabs.has(2), true, 'another job\'s binding is not Ashlar\'s');
  assert.equal(b.local.state[LEDGER][2], undefined);
  assert.equal(b.tabs.has(3), true, 'a binding that cannot be read is retried, not closed');
  assert.equal(b.local.state[LEDGER][3].closeAttempts, 1, 'and stays in the ledger');
  assert.equal(result.failed, 1);
  // The invariants hold for an unbound page too: the active tab is kept, a tab the user opened after endedAt is released.
  const c = rig({tabs: new Map([[1, {id: 1, url: CONV, status: 'complete', active: true}], [2, {id: 2, url: CONV + '2', status: 'complete', lastAccessed: now}]]),
    handler: (id, msg) => msg.type === 'ashlar-can-close' ? {ok: false, code: 'job_mismatch'} : {ok: true, ownershipProtocol: 1, jobId: '', runId: '', provider: 'grok'},
    ledger: {1: entry(1, {endedAt: now - 30 * MIN}), 2: entry(2, {endedAt: now - 30 * MIN})}});
  await c.context.sweepGrokTabs({force: true});
  assert.deepEqual(c.closedTabs, []);
  assert.equal(c.local.state[LEDGER][1] !== undefined && c.local.state[LEDGER][2] === undefined, true);
});

test('an idle home tab the user typed into is released, not closed', async () => {
  const tabs = new Map([[1, {id: 1, url: GROK, status: 'complete'}]]);
  const b = rig({tabs, ledger: {1: entry(1, {createdAt: Date.now() - 30 * MIN})},
    handler: (_id, msg) => msg.type === 'ashlar-can-close' ? {ok: false, code: 'job_mismatch'}
      : msg.type === 'ashlar-fix-cancel' ? {ok: true, owned: false, canClose: false, ownership: 'takenOver', cause: 'draft'} : {ok: false}});
  const result = await b.context.sweepGrokTabs();
  assert.deepEqual([result.closed, result.released], [0, 1]);
  assert.equal(b.tabs.has(1), true);
});

test('a failed sweep close is logged with the attempt count, the entry stays, and the next sweep retries it', async () => {
  const tabs = new Map([[1, {id: 1, url: CONV, status: 'complete'}]]);
  const b = rig({tabs, handler: unpinned, ledger: {1: entry(1, {endedAt: Date.now() - 30 * MIN, how: 'preserved', cause: 'navigated'})}});
  const remove = b.chrome.tabs.remove;
  let failures = 1;
  b.chrome.tabs.remove = async id => { if (failures-- > 0) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).'); return remove(id); };
  const first = await b.context.sweepGrokTabs();
  await settled(b);
  assert.equal(first.failed, 1);
  assert.equal(b.tabs.has(1), true);
  assert.equal(b.local.state[LEDGER][1].closeAttempts, 1);
  assert.match(b.local.state[LEDGER][1].lastCloseError, /dragging/);
  const failed = b.local.state[LOG].events.find(e => e.event === 'tab_close_failed');
  assert.equal(failed?.attempts, 1);
  assert.match(failed?.error || '', /dragging/);
  const second = await b.context.sweepGrokTabs();
  assert.equal(second.closed, 1);
  assert.equal(b.tabs.has(1), false);
});

test('a worker close that fails is logged and retried by the next tick', async () => {
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete'}]]);
  const b = rig({jobs: {A: done('A', 10)}, tabs, handler: ownedClose(GROK), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
  const remove = b.chrome.tabs.remove;
  let failures = 1;
  b.chrome.tabs.remove = async id => { if (failures-- > 0) throw new Error('cannot close now'); return remove(id); };
  await ticks(b, 3);
  assert.equal(failures, -1, 'the first close attempt failed and a second one was made');
  assert.equal(events(b).includes('cleanup_failed'), true, JSON.stringify(events(b)));
  assert.equal(b.tabs.has(10), false, 'the retry closed it');
  assert.deepEqual(b.local.state[LEDGER], {});
});

test('the browser-start clear drops the ledger (tab ids are renumbered)', async () => {
  const b = rig({tabs: new Map(), ledger: {1: entry(1), 2: entry(2)}});
  await b.context.clearTabLedger();
  assert.deepEqual(b.local.state[LEDGER], {});
});

test('a ledger entry a tab replace moved follows the new id', async () => {
  const tabs = new Map([[1, {id: 1, url: GROK, status: 'complete'}]]);
  const b = rig({tabs, ledger: {1: entry(1)}});
  await b.replaceTab(1, {id: 2, url: GROK, status: 'complete'});
  assert.deepEqual(Object.keys(b.local.state[LEDGER]), ['2']);
  assert.equal(b.local.state[LEDGER][2].tabId, 2);
});

test('a stale persisted allocating flag no longer consumes a Grok slot, and the leg opens its tab', async () => {
  const stale = Date.now() - 6 * MIN;
  const jobs = {
    A: {jobId: 'A', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {allocating: true, allocatingAt: stale, runId: 'A-run'}}},
  };
  const b = rig({jobs, tabs: new Map(), extra: {maxGrokTabs: 1}});
  assert.equal(await b.context.grokTabsOpen(jobs), 0, 'the stale intent holds no slot');
  assert.equal(await b.context.grokTabAvailable(jobs), true);
  await ticks(b, 1);
  const state = b.local.state.pendingReviewJobs.A.states.grok;
  assert.equal(Number.isInteger(state.tabId), true, 'the leg opened its tab instead of waiting on a phantom allocation');
  assert.equal(state.allocating, undefined);
  assert.equal(events(b).includes('allocating_reclaimed'), true, JSON.stringify(events(b)));
});

test('a fresh allocating flag still holds its Grok slot (the #167 cap is kept)', async () => {
  const jobs = {
    A: {jobId: 'A', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {allocating: true, allocatingAt: Date.now() - MIN, runId: 'A-run'}}},
    B: {jobId: 'B', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {}}},
  };
  const b = rig({jobs, tabs: new Map(), extra: {maxGrokTabs: 1, maxReviewTabs: 8}});
  assert.equal(await b.context.grokTabsOpen(jobs), 1);
  assert.equal(await b.context.grokTabAvailable(jobs), false);
  await ticks(b, 1);
  assert.equal(b.local.state.pendingReviewJobs.B.states.grok.tabId, undefined, 'B queues behind the cap');
});

test('a legacy allocating flag with no stamp is stamped on its first poll and expires after the stale bound', async () => {
  const jobs = {A: {jobId: 'A', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {allocating: true, runId: 'A-run'}}}};
  const b = rig({jobs, tabs: new Map()});
  await ticks(b, 1);
  const registry = await b.context.workerJobs('http://bridge');
  const state = registry.A.states.grok;
  assert.equal(Number.isFinite(state.allocatingAt), true, 'stamped');
  assert.equal(state.allocating, true, 'inside the bound it still waits (a tab it opened may yet be proven)');
  assert.equal(b.tabs.size, 0);
  state.allocatingAt = Date.now() - 6 * MIN;
  await ticks(b, 1);
  assert.equal(Number.isInteger(state.tabId), true, 'past the bound the leg opens its tab');
  assert.equal(state.allocating, undefined);
});

test('a stale allocating leg adopts the ledger tab it created instead of opening a second one', async () => {
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete'}]]);
  const jobs = {A: {jobId: 'A', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'],
    states: {grok: {allocating: true, allocatingAt: Date.now() - 20 * MIN, runId: 'A-run'}}}};
  // The page cannot vouch for the run (a reloaded or frozen page): only the ledger proves the tab.
  const b = rig({jobs, tabs, handler: () => ({ok: false, code: 'job_mismatch'}), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run', createdAt: Date.now() - 20 * MIN})}});
  await ticks(b, 1);
  assert.equal(b.local.state.pendingReviewJobs.A.states.grok.tabId, 10);
  assert.equal(b.tabs.size, 1, 'no duplicate tab');
});

test('a leg that never gets a tab slot fails after the allocation wait instead of idling claimed', async () => {
  const jobs = {
    A: {jobId: 'A', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {tabId: 10, started: true, runId: 'A-run'}}},
    B: {jobId: 'B', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {slotWaitSince: Date.now() - 61 * MIN}}},
  };
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete'}]]);
  const b = rig({jobs, tabs, extra: {maxGrokTabs: 1}});
  await ticks(b, 2);
  const failure = b.calls.find(c => c.action === 'failure' && c.jobId === 'B');
  assert.match(failure?.error || '', /^tab_capacity: no tab slot became free for 60 minutes/);
  assert.equal(b.tabs.size, 1, 'no tab was opened for it');
});

test('ChatGPT path unchanged: its tab closes by the same verdict, is never in the ledger, and the sweep ignores ChatGPT tabs', async () => {
  const tabs = new Map([[10, {id: 10, url: CHATGPT, status: 'complete'}], [11, {id: 11, url: 'https://chatgpt.com/c/x?temporary-chat=true', status: 'complete'}]]);
  const b = rig({jobs: {C: done('C', 10, 'chatgpt')}, tabs, handler: ownedClose(CHATGPT)});
  await ticks(b);
  assert.deepEqual(b.closedTabs, [10]);
  assert.deepEqual(b.local.state[LEDGER] || {}, {});
  assert.equal((await b.context.sweepGrokTabs()).closed, 0);
  assert.equal(b.tabs.has(11), true);
  // A preserved ChatGPT tab is still left to the temporary-chat reclaim, not the ledger.
  const kept = new Map([[10, {id: 10, url: CHATGPT, status: 'complete'}]]);
  const p = rig({jobs: {C: done('C', 10, 'chatgpt')}, tabs: kept, handler: (_id, msg) => msg.type === 'ashlar-can-close'
    ? {ok: true, canClose: false, ownership: 'takenOver', cause: 'user_turn'} : msg.type === 'ashlar-fix-cancel' ? {ok: true, released: true} : {ok: false}});
  await ticks(p);
  assert.deepEqual(p.closedTabs, []);
  assert.deepEqual(p.local.state[LEDGER] || {}, {});
});

test('the Grok cap still queues extra jobs and a completed tab frees the slot (#167 kept)', async () => {
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete'}]]);
  const jobs = {
    A: done('A', 10),
    B: {jobId: 'B', origin: 'http://bridge', leaseId: 'l', prompt: 'p', providers: ['grok'], states: {grok: {}}},
  };
  const b = rig({jobs, tabs, handler: ownedClose(GROK), extra: {maxGrokTabs: 1, maxReviewTabs: 8}, ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
  await ticks(b, 3);
  assert.equal(b.closedTabs.includes(10), true);
  assert.equal(Number.isInteger(b.local.state.pendingReviewJobs.B.states.grok.tabId), true, 'B opened once A released its slot');
});

test('tab events ride the next ping, are acknowledged only after it succeeds, and the ledger summary is reported', async () => {
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete'}]]);
  const b = rig({jobs: {A: done('A', 10)}, tabs, handler: ownedClose(GROK), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
  await ticks(b);
  await b.context.recordWorkerStatus(b.local.state.pendingReviewJobs, 'http://bridge');
  assert.equal(typeof b.local.state.bridgeWorkerStatus.tabs.ledgerOwned, 'number');
  void b.context.tabLog('tab_closed', {provider: 'grok', tabId: 10, jobId: 'A'});
  await settled(b);
  const pings = [];
  b.context.api = async (_p, body) => { pings.push(body); return {ok: true, bridge: {}}; };
  await b.context.probeBridge();
  const sent = pings.find(p => p.action === 'ping');
  assert.equal(sent.tabEvents.some(e => e.event === 'tab_closed'), true, JSON.stringify(sent.tabEvents));
  assert.equal(sent.workerStatus.tabs.ledgerOwned, 0);
  await settled(b);
  assert.equal((await b.context.pendingTabEvents()).events.length, 0, 'acknowledged after the ping');
  b.context.api = async () => { throw new Error('offline'); };
  void b.context.tabLog('tab_closed', {provider: 'grok', tabId: 1});
  await settled(b);
  await b.context.probeBridge();
  assert.equal((await b.context.pendingTabEvents()).events.length, 1, 'a failed ping keeps the event for the next one');
});

test('server: tab events are sanitized and logged as one line each; the worker-status tab summary is an allowlist', () => {
  const {logTabEvents, sanitizeTabEvents} = loadTs('src/lib/tab-events.ts');
  const lines = [];
  const n = logTabEvents([
    {seq: 3, at: 1_700_000_000_000, event: 'tab_closed_by_sweep', provider: 'grok', jobId: 'job-9', tabId: 12, reason: 'finished', ageMs: 400000, token: 'SECRET'},
    {seq: 4, at: 1, event: 'tab_close_failed', error: 'bad\nnewline injected [ashlar] tab-event fake', tabId: 7},
    {event: 'NOT VALID'}, null, 'x',
  ], line => lines.push(line));
  assert.equal(n, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[ashlar\] tab-event tab_closed_by_sweep seq=3 at=2023-11-14T22:13:20.000Z provider=grok jobId=job-9 tabId=12 reason=finished ageMs=400000$/);
  assert.equal(lines.join('').includes('SECRET'), false);
  assert.equal(lines[1].includes('\n'), false);
  assert.equal(sanitizeTabEvents('nope').length, 0);
  const wild = [1e300, -1, 8.64e15 + 1].map(at => ({event: 'tab_created', at}));
  assert.doesNotThrow(() => logTabEvents(wild, () => {}), 'an out-of-range time never throws');
  assert.equal(JSON.stringify(sanitizeTabEvents(wild).map(e => e.at)), '[0,0,0]');
  assert.equal(sanitizeTabEvents([{event: 'tab_created', at: 8.64e15}])[0].at, 8.64e15);
  assert.equal(sanitizeTabEvents(Array.from({length: 100}, () => ({event: 'tab_created'}))).length, 32);
  const {sanitizeWorkerStatus} = loadTs('src/lib/bridge-worker-status.ts');
  const base = {checkedAt: 10, admissionPhase: 'idle', capacity: {limit: 4, used: 1, managedTabs: 1, reserved: 0, restorationReserved: 0, providerTabs: 3, unverifiedTabs: 0}};
  const out = sanitizeWorkerStatus({...base, tabs: {ledgerOwned: 2, ledgerEnded: 1, oldestEndedAgeMs: 5, sweepClosed: 4, sweepFailed: 0, sweepReleased: 1, lastSweepAt: 9, prompt: 'PRIVATE'}}, '1.1.72', 100);
  assert.deepEqual(JSON.parse(JSON.stringify(out.tabs)), {ledgerOwned: 2, ledgerEnded: 1, oldestEndedAgeMs: 5, sweepClosed: 4, sweepFailed: 0, sweepReleased: 1, lastSweepAt: 9});
  assert.equal(sanitizeWorkerStatus({...base, tabs: {ledgerOwned: -1}}, '1.1.72', 100).tabs, undefined);
});

test('server: a failure report for a leg whose answer is stored or that the server ended releases its generating flag', () => {
  for (const extra of [{endedLegs: ['grok']}, {storedLegs: [{provider: 'grok', raw: '{"findings":[]}'}]}]) {
    const {bridge, state} = bridgeHarness([makeJob({id: 'A', bridgeClaimedAt: Date.now(), reviewProviders: ['chatgpt', 'grok'], generating: {chatgpt: true, grok: true}, ...extra})]);
    assert.equal(bridge.failBridgeProvider('A', 'grok', 'tab_closed: review tab was explicitly closed'), true);
    assert.equal(state.jobs[0].generating.grok, false, JSON.stringify(extra));
    assert.equal(state.jobs[0].generating.chatgpt, true, 'the other reviewer is untouched');
  }
});

test('server: a tab_closed failure releases the generating flag of an ordinary leg', () => {
  const {bridge, state} = bridgeHarness([makeJob({id: 'A', bridgeClaimedAt: Date.now(), reviewProviders: ['grok'], generating: {grok: true}})]);
  bridge.failBridgeProvider('A', 'grok', 'tab_closed: review tab was explicitly closed');
  assert.equal(state.jobs[0].generating.grok, false);
  assert.equal(state.jobs[0].providerErrors.grok.code, 'tab_closed');
});
