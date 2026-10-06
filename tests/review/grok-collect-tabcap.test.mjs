// Hidden Grok tabs (managedTabs=10, providerTabs=14): the answer finished on screen but the
// page collector never left waiting_for_response (Chrome throttles background timers / rAF).
// Harvest is driven by the worker, not page timers. Grok tabs are capped so extras queue.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {background, content, storage, raw, flush} from './helpers.mjs';

const GROK = 'https://grok.com/';
const MIN = 60_000;
function grokJob(id, tabId, extra = {}) {
  return {jobId: id, origin: 'http://bridge', leaseId: 'lease-' + id, prompt: 'review ' + id, providers: ['grok'],
    states: {grok: tabId ? {tabId, started: true, runId: id + '-grok', ...extra} : {...extra}}};
}
function harvest(c) {
  return c.message({type: 'ashlar-harvest', jobId: 'A', runId: 'run-A', provider: 'grok'});
}
function stages(c) {
  return (c.context.__ashlarRunnerState?.steps?.events || []).map(e => e.stage);
}
function sentBound(c, {conversation, href, followup = false, responseId = 'answer-A'} = {}) {
  if (href) c.context.location = {href};
  const page = c.context.location.href;
  const record = {phase: 'sent', expected: 'review', messageId: 'user-A', baseline: 0, submittedUsers: 1};
  if (conversation !== null) record.conversation = conversation === undefined ? page : conversation;
  c.context.savedSubmission = () => record;
  c.context.boundReviewResponse = () => ({identified: true, followup, root: {}, responseId, message: {}});
}
async function throttledGrok() {
  const c = content('grok');
  c.context.stopButtonVisible = () => false;
  c.context.replyDoneVisible = () => true;
  c.context.responseStreaming = () => false;
  c.context.sleep = () => new Promise(() => {});
  c.context.waitForPageChange = () => new Promise(() => {});
  c.context.runPrompt = () => new Promise(() => {});
  assert.equal(c.message({type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'grok', prompt: 'review'})?.code, 'busy');
  await flush();
  return c;
}
/** The job is deleted after close; snapshot workerEvents from the durable save that recorded them. */
function watchWorkerStages(b, jobId, provider) {
  const stages = [];
  const set = b.local.set;
  b.local.set = async values => {
    const events = values.pendingReviewJobs?.[jobId]?.states?.[provider]?.workerEvents;
    if (Array.isArray(events)) stages.push(...events.map(e => e.stage));
    return set(values);
  };
  return stages;
}

test('harvest collects a completed Grok answer while page timers never fire (throttled background tab)', async () => {
  const c = await throttledGrok();
  sentBound(c);
  assert.equal(c.context.__ashlarRunnerState.running, true);
  assert.equal((await harvest(c))?.code, 'busy', 'first completed snapshot is not yet stable');
  const second = await harvest(c);
  assert.equal(second?.ok, true, JSON.stringify(second));
  assert.equal(second.raw, raw);
  assert.equal(stages(c).includes('response_collected'), true, JSON.stringify(stages(c)));
  assert.equal((await harvest(c))?.raw, raw, 'later harvests keep the collected result');
});

test('harvest does not collect while Grok is still generating in a throttled tab', async () => {
  const c = content('grok');
  c.context.stopButtonVisible = () => true;
  c.context.replyDoneVisible = () => false;
  c.context.runPrompt = () => new Promise(() => {});
  sentBound(c);
  c.message({type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'grok', prompt: 'review'});
  await flush();
  assert.equal((await harvest(c))?.code, 'busy');
  assert.equal((await harvest(c))?.code, 'busy');
  assert.notEqual(c.context.__ashlarRunnerState.result?.ok, true);
  assert.equal(stages(c).includes('response_collected'), false);
});

test('harvest replies busy when reply-done is visible but no sent submission is bound', async () => {
  const c = await throttledGrok();
  assert.equal((await harvest(c))?.code, 'busy');
  assert.equal((await harvest(c))?.code, 'busy');
  assert.notEqual(c.context.__ashlarRunnerState.result?.ok, true);
  assert.equal(c.context.__ashlarRunnerState.result?.ok, undefined);
});

test('harvest does not settle two stable snapshots from a different conversation than the run', async () => {
  const c = await throttledGrok();
  sentBound(c, {conversation: 'https://grok.com/c/run', href: 'https://grok.com/c/other'});
  assert.equal((await harvest(c))?.code, 'busy');
  assert.equal((await harvest(c))?.code, 'busy');
  assert.notEqual(c.context.__ashlarRunnerState.result?.ok, true);
});

test('harvest does not settle a new-chat answer the collector refused to pin', async () => {
  for (const reason of ['edited', 'tabRepurposed']) {
    const c = await throttledGrok();
    sentBound(c, {conversation: null});
    if (reason === 'edited') c.context.journaledTurnIntegrity = () => 'edited';
    else c.context.__ashlarRunnerState.tabRepurposed = true;
    assert.equal((await harvest(c))?.code, 'busy', reason);
    assert.equal((await harvest(c))?.code, 'busy', reason);
    assert.notEqual(c.context.__ashlarRunnerState.result?.ok, true, reason);
  }
});

test('a generating harvest poke does not clear collector stability hits', async () => {
  const c = await throttledGrok();
  sentBound(c);
  const json = c.context.harvestJson({allowThin: true});
  const text = c.context.assistantCorpus().join('\n\n');
  const key = JSON.stringify([json, text]);
  c.context.__ashlarRunnerState.collectStability = {stable: key, hits: 1};
  c.context.stopButtonVisible = () => true;
  c.context.replyDoneVisible = () => false;
  assert.equal((await harvest(c))?.code, 'busy');
  assert.equal(c.context.__ashlarRunnerState.collectStability.hits, 1, 'stop poke must not clear hits');
  assert.equal(c.context.__ashlarRunnerState.collectStability.stable, key);
  c.context.stopButtonVisible = () => false;
  c.context.replyDoneVisible = () => true;
  const settled = await harvest(c);
  assert.equal(settled?.ok, true, JSON.stringify(settled));
  assert.equal(settled.raw, raw);
});

test('harvest of a bound sent submission replies raw after persistedResult resolves', async () => {
  const c = await throttledGrok();
  sentBound(c);
  let persistResolved = false;
  c.context.chrome.storage = {session: {set: async () => {
    await new Promise(resolve => setImmediate(resolve));
    persistResolved = true;
  }}};
  assert.equal((await harvest(c))?.code, 'busy', 'first completed snapshot is not yet stable');
  const second = await harvest(c);
  assert.equal(persistResolved, true, 'persistedResult resolved before the harvest reply');
  assert.equal(second?.ok, true, JSON.stringify(second));
  assert.equal(second.raw, raw);
  assert.equal(c.context.__ashlarRunnerState.persistedResult !== undefined, true);
});

test('a harvest success is not overwritten when the throttled collector then throws', async () => {
  let rejectRun;
  const c = content('grok');
  c.context.stopButtonVisible = () => false;
  c.context.replyDoneVisible = () => true;
  c.context.responseStreaming = () => false;
  c.context.sleep = () => new Promise(() => {});
  c.context.waitForPageChange = () => new Promise(() => {});
  c.context.runPrompt = () => new Promise((_, reject) => { rejectRun = reject; });
  assert.equal(c.message({type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'grok', prompt: 'review'})?.code, 'busy');
  await flush();
  sentBound(c);
  let releasePersist;
  c.context.chrome.storage = {session: {set: () => new Promise(resolve => { releasePersist = resolve; })}};
  assert.equal((await harvest(c))?.code, 'busy', 'first completed snapshot is not yet stable');
  const settling = harvest(c);
  assert.equal(c.context.__ashlarRunnerState.result?.ok, true, 'latched before the persist reply');
  rejectRun(Object.assign(new Error('response wait expired'), {code: 'response_timeout'}));
  await flush();
  releasePersist();
  const first = await settling;
  assert.equal(first?.ok, true, JSON.stringify(first));
  assert.equal(first.raw, raw);
  assert.equal(c.context.__ashlarRunnerState.result?.ok, true);
  assert.equal(c.context.__ashlarRunnerState.result.raw, raw);
  assert.equal((await harvest(c))?.raw, raw);
});

test('worker harvest of a completed inactive Grok tab posts the answer and closes the managed tab', async () => {
  const job = grokJob('A', 10);
  const tabs = new Map([
    [10, {id: 10, url: GROK, status: 'complete', active: false, frozen: false}],
    [99, {id: 99, url: 'https://grok.com/c/personal', status: 'complete', active: false}],
  ]);
  const b = background({
    local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {A: job}}),
    tabs,
    handler: (_id, msg) => {
      if (msg.type === 'ashlar-can-close') return {ok: true, canClose: true, ownership: 'owned', url: GROK, conversation: GROK};
      if (msg.type === 'ashlar-harvest') return {ok: true, raw};
      return {ok: false, code: 'busy'};
    },
    api: async () => ({ok: true, active: true, accepted: true, status: 'awaiting_chat'}),
  });
  const workerStages = watchWorkerStages(b, 'A', 'grok');
  await b.tick();
  assert.equal(b.messages.some(m => m.id === 10 && m.type === 'ashlar-harvest'), true, 'the worker asked the tab to harvest');
  const complete = b.calls.find(c => c.action === 'complete' && c.jobId === 'A');
  assert.equal(complete?.raw, raw);
  assert.equal(workerStages.includes('response_collected'), true, 'harvest recorded response_collected in workerEvents');
  assert.deepEqual(b.closedTabs, [10]);
  assert.equal(b.tabs.has(99), true, 'a grok.com tab Ashlar does not manage stays open');
});

test('a Grok POSTSEND_CAP timeout closes the managed tab when the page is still Ashlar-owned', async () => {
  const at = Date.now() - 31 * MIN;
  const job = grokJob('A', 10, {
    runDispatchedAt: at - 5000,
    pageEvents: [
      {source: 'page', sequence: 1, at: at - 2000, stage: 'send_waiting'},
      {source: 'page', sequence: 2, at, stage: 'send_attempted'},
      {source: 'page', sequence: 3, at: at + 1000, stage: 'waiting_for_response'},
    ],
  });
  const tabs = new Map([[10, {id: 10, url: GROK, status: 'complete', active: false}],
    [99, {id: 99, url: 'https://grok.com/c/personal', status: 'complete'}]]);
  const b = background({
    local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {A: job}}),
    tabs,
    handler: (_id, msg) => msg.type === 'ashlar-can-close'
      ? {ok: true, canClose: true, ownership: 'owned', url: GROK, conversation: GROK}
      : {ok: false, code: 'busy'},
    api: async () => ({ok: true, active: true, accepted: true, status: 'awaiting_chat'}),
  });
  const workerStages = watchWorkerStages(b, 'A', 'grok');
  await b.tick(); await flush(); await b.tick();
  const failure = b.calls.find(c => c.action === 'failure' && c.jobId === 'A');
  assert.match(failure?.error || '', /response_timeout/);
  assert.equal(workerStages.includes('postsend_watchdog'), true, 'timeout recorded postsend_watchdog in workerEvents');
  assert.deepEqual(b.closedTabs, [10]);
  assert.equal(b.tabs.has(99), true, 'personal Grok tab stays open after the cap');
});

test('Grok tab cap queues extra jobs; completing one opens the next; personal tabs are ignored', async () => {
  const jobs = {
    A: grokJob('A', 10), B: grokJob('B', 11), C: grokJob('C'), D: grokJob('D'),
  };
  const tabs = new Map([
    [10, {id: 10, url: GROK, status: 'complete'}],
    [11, {id: 11, url: GROK, status: 'complete'}],
    [99, {id: 99, url: 'https://grok.com/c/personal', status: 'complete'}],
  ]);
  const done = new Set();
  const b = background({
    local: storage({origin: 'http://bridge', token: 'token', maxGrokTabs: 2, maxReviewTabs: 8,
      pendingReviewJobs: jobs}),
    tabs,
    handler: (id, msg) => {
      const jobId = msg.jobId;
      if (msg.type === 'ashlar-can-close') {
        const url = tabs.get(id)?.url || GROK;
        return {ok: true, canClose: true, ownership: 'owned', url, conversation: url};
      }
      if (done.has(jobId)) return {ok: true, raw};
      return {ok: false, code: 'busy'};
    },
    api: async () => ({ok: true, active: true, accepted: true, status: 'awaiting_chat'}),
  });
  let n = 0;
  b.context.crypto.randomUUID = () => `run-${++n}`;
  await b.tick();
  assert.equal(await b.context.grokTabsOpen(b.local.state.pendingReviewJobs), 2);
  assert.equal(b.local.state.pendingReviewJobs.C.states.grok.tabId, undefined, 'C queued behind the cap');
  assert.equal(b.local.state.pendingReviewJobs.D.states.grok.tabId, undefined, 'D queued behind the cap');
  assert.equal(b.tabs.has(99), true, 'personal tab ignored by the cap');
  assert.equal([...b.tabs.keys()].filter(id => id !== 99).length, 2, 'no extra Grok tab opened');
  done.add('A');
  for (let i = 0; i < 8; i++) {
    await b.tick();
    await flush();
    if (Number.isInteger(b.local.state.pendingReviewJobs.C?.states.grok.tabId)) break;
  }
  assert.equal(b.closedTabs.includes(10), true, 'completed Grok tab closed');
  assert.equal(Number.isInteger(b.local.state.pendingReviewJobs.C.states.grok.tabId), true, 'queued C opened after A released a slot');
  assert.equal(b.local.state.pendingReviewJobs.D.states.grok.tabId, undefined, 'D still queued at cap 2');
  assert.equal(b.tabs.has(99), true, 'personal Grok tab never closed');
});

test('grokTabLimit defaults to 3 and honors maxGrokTabs (1–8)', () => {
  const b = background();
  assert.equal(b.context.grokTabLimit(), 3);
  assert.equal(b.context.grokTabLimit(2), 2);
  assert.equal(b.context.grokTabLimit(99), 8);
  assert.equal(b.context.grokTabLimit(0), 3);
});
