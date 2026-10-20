// Live 2026-10-20 (Mac Studio, screen locked, no human input): 5 of 5 Grok review legs ended
// tab_preserved cause=edited ("the user took over the tab") while every ChatGPT leg closed. A review's
// "edited" verdict was decided by DOM text alone: the rendered sent turn is not EXACTLY Ashlar's prompt
// (json.js tabOwnership -> reviewTurnExact). Grok re-renders a sent prompt (Markdown) once the answer
// completes, so Ashlar's own turn read as the user's edit; 1.1.72 then released the tab from the ledger
// as the user's (USER_HELD_CAUSES), so the sweep never closed it and tabs accumulated again.
// An edit now needs positive evidence the page itself can see: trusted user input (isTrusted), which
// neither Ashlar's synthetic events nor Grok's rendering produce. Without it the tab stays Ashlar's.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {background, content, storage, raw, flush} from './helpers.mjs';

const MIN = 60_000;
const CONV = 'https://grok.com/c/abc';
const LEDGER = 'ashlar:tabLedger';
const LOG = 'ashlar:tabLog';
const entry = (tabId, extra = {}) => ({tabId, jobId: `old-${tabId}`, runId: `run-${tabId}`, createdAt: Date.now() - 60 * MIN, ...extra});
const events = b => (b.local.state[LOG]?.events || []).map(e => e.event);
const settled = async b => { await b.context.writeInOrder(async () => {}); await flush(); };
async function ticks(b, n = 2) { for (let i = 0; i < n; i++) { await b.tick(); await flush(); } await settled(b); }

// ---- the page: the sent turn renders differently from the prompt; nothing else is on the page ----
// A trusted keystroke into the composer / an editable area (what a user editing or following up produces).
const editable = {closest: () => ({getAttribute: () => '', textContent: ''})};
const typing = (extra = {}) => ({isTrusted: true, type: 'keydown', key: 'a', target: editable, ...extra});
function page(provider, {persisted, rendered = 'Review PR #1\n\n\u2022 item one\n\u2022 item two', conversation = provider === 'grok' ? CONV : 'https://chatgpt.com/c/abc'} = {}) {
  const c = content(provider, persisted);
  c.context.stopButtonVisible = () => false;
  c.context.runPrompt = () => new Promise(() => {});
  c.message({type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider, prompt: 'review'}); // starts on the fresh new chat
  const record = {phase: 'sent', expected: 'Review PR #1 - item one - item two', messageId: 'user-A', baseline: 0, submittedUsers: 1, conversation};
  c.context.location = {href: conversation}; // then the provider moves it to its conversation
  c.context.savedSubmission = () => record;
  const turn = {};
  c.context.userTurnEls = () => [turn];
  c.context.turnMessageId = () => 'user-A';
  c.context.messagePromptText = () => rendered;
  c.context.composerDraftText = () => '';
  c.context.composerStagedFiles = () => [];
  c.context.regeneratedAfterCompletion = () => false;
  return c;
}
const canClose = c => c.message({type: 'ashlar-can-close', jobId: 'A', runId: 'run-A', provider: c.context.__ashlarRunnerState.provider,
  allocationUrl: c.context.__ashlarRunnerState.provider === 'grok' ? 'https://grok.com/' : 'https://chatgpt.com/?temporary-chat=true', secured: true});

test('Grok re-rendering Ashlar\'s own sent prompt, with no user input, is not an edit: the tab is Ashlar\'s to close', async () => {
  const c = page('grok');
  await flush();
  const reply = await canClose(c);
  assert.equal(reply.ownership, 'owned', JSON.stringify(reply));
  assert.equal(reply.canClose, true);
  assert.equal(reply.userInput, false);
  assert.equal(reply.renderDiffers, true, 'the difference is reported for diagnosis');
  assert.equal(c.context.__ashlarRunnerState.tabRepurposed, undefined, 'and never marks the tab repurposed for good');
});

test('the same Grok page with TRUSTED user input after the send is a real takeover: edited, preserved', async () => {
  const c = page('grok');
  await flush();
  assert.equal(c.context.noteUserInput(typing()), true);
  const reply = await canClose(c);
  assert.equal(reply.ownership, 'takenOver', JSON.stringify(reply));
  assert.equal(reply.cause, 'edited');
  assert.equal(reply.userInput, true);
  assert.equal(c.context.__ashlarRunnerState.tabRepurposed, true);
});

test('synthetic events (Ashlar\'s own clicks and key presses, a page script) are never user evidence', async () => {
  const c = page('grok');
  await flush();
  const listeners = {};
  c.context.document = {addEventListener: (type, fn) => { listeners[type] = fn; }};
  c.context.installUserInputWitness();
  for (const type of ['keydown', 'pointerdown', 'mousedown', 'touchstart', 'paste', 'drop']) assert.equal(typeof listeners[type], 'function', type);
  for (const type of Object.keys(listeners)) listeners[type]({isTrusted: false, type, key: 'a', target: editable}); // dispatchEvent(new PointerEvent(...)), el.click()
  assert.equal(c.context.userInputSeen(), false);
  assert.equal((await canClose(c)).ownership, 'owned');
  listeners.keydown(typing()); // the user's own key in the composer
  assert.equal(c.context.userInputSeen(), true);
  assert.equal((await canClose(c)).ownership, 'takenOver');
});

test('only input that can change the conversation counts: bare pointer events, modifier keys and keys outside an editor do not', async () => {
  const c = page('grok');
  await flush();
  const body = {closest: () => null}; // nothing editable, no control under the pointer
  const control = label => ({closest: sel => (sel.startsWith('button') ? {getAttribute: name => (name === 'aria-label' ? label : ''), textContent: ''} : null)});
  for (const event of [
    {isTrusted: true, type: 'pointerdown', target: body}, {isTrusted: true, type: 'mousedown', target: body}, {isTrusted: true, type: 'touchstart', target: body},
    {isTrusted: true, type: 'keydown', key: 'a', target: body}, {isTrusted: true, type: 'keydown', key: 'Shift', target: editable},
    {isTrusted: true, type: 'pointerdown', target: control('Copy response')}, {isTrusted: true, type: 'pointerdown', target: control('Like')},
  ]) assert.equal(c.context.noteUserInput(event), false, JSON.stringify([event.type, event.key]));
  assert.equal(c.context.userInputSeen(), false);
  assert.equal((await canClose(c)).ownership, 'owned');
  assert.equal(c.context.noteUserInput({isTrusted: true, type: 'pointerdown', target: control('Regenerate response')}), true, 'a regenerate control');
  assert.equal(c.context.noteUserInput({isTrusted: true, type: 'pointerdown', target: control('Edit message')}), true, 'an edit control');
  assert.equal(c.context.noteUserInput({isTrusted: true, type: 'paste', target: editable}), true, 'a paste into an editor');
});

test('input is scoped to the run and to after its send was confirmed', async () => {
  const c = page('grok');
  await flush();
  const record = c.context.savedSubmission();
  const sentAt = Date.now();
  record.sentAt = sentAt;
  assert.equal(c.context.noteUserInput(typing(), sentAt - 5_000), true, 'recorded, but it was before Ashlar finished writing');
  assert.equal(c.context.userInputSeen(), false, 'input before the send is not a takeover of the sent conversation');
  assert.equal((await canClose(c)).ownership, 'owned');
  c.context.noteUserInput(typing(), sentAt + 5_000);
  assert.equal(c.context.userInputSeen(), true, 'after the send it is');
  // Another run in the same tab never inherits it (the evidence is keyed by job and run).
  const persisted = new Map();
  const first = page('grok', {persisted});
  await flush();
  first.context.noteUserInput(typing());
  assert.deepEqual([...persisted.keys()].filter(key => key.startsWith('ashlar:userinput')), ['ashlar:userinput:A:run-A']);
  assert.equal(first.context.userInputAfterSend({jobId: 'A', runId: 'run-A'}), true);
  assert.equal(first.context.userInputAfterSend({jobId: 'B', runId: 'run-B'}), false, 'run B has none of run A\'s input');
  assert.equal(first.context.userInputAfterSend({jobId: 'A', runId: 'run-other'}), false, 'nor does another run of the same job');
  // Nothing is recorded while no run is bound to the page.
  assert.equal(content('grok').context.noteUserInput(typing()), false);
});

test('the evidence survives a page reload (sessionStorage), so a real edit is not forgotten', async () => {
  const persisted = new Map();
  const first = page('grok', {persisted});
  await flush();
  first.context.noteUserInput(typing());
  const second = page('grok', {persisted}); // the reloaded document binds the same run again
  await flush();
  assert.equal(second.context.userInputSeen(), true);
  assert.equal(page('grok').context.userInputSeen(), false, 'a tab with no input has none');
});

test('ChatGPT path unchanged: the same rendered difference is still an edit by DOM alone', async () => {
  const c = page('chatgpt');
  await flush();
  const reply = await canClose(c);
  assert.equal(reply.ownership, 'takenOver', JSON.stringify(reply));
  assert.equal(reply.cause, 'edited');
});

// ---- the worker ----
const OK_API = async () => ({ok: true, active: true, accepted: true, status: 'awaiting_chat'});
function doneGrok(tabId = 10) {
  return {jobId: 'A', origin: 'http://bridge', leaseId: 'l', prompt: 'review', providers: ['grok'],
    states: {grok: {tabId, started: true, runId: 'A-run', outcome: {ok: true, raw, originalText: raw}}}};
}
const takenOver = (cause, userInput) => (_id, msg) => {
  if (msg.type === 'ashlar-can-close') return {ok: true, canClose: false, ownership: 'takenOver', cause, ...(userInput === undefined ? {} : {userInput}), renderDiffers: userInput === false, url: CONV};
  if (msg.type === 'ashlar-fix-cancel') return {ok: true, released: true};
  return {ok: false, code: 'busy'};
};
function rig({handler, tabs, jobs = {}, ledger}) {
  return background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: jobs, ...(ledger ? {[LEDGER]: ledger} : {})}), tabs, handler, api: OK_API});
}

test('a Grok leg preserved as edited with NO user input stays in the ledger and the sweep closes it after the grace', async () => {
  const tabs = new Map([[10, {id: 10, url: CONV, status: 'complete'}], [99, {id: 99, url: 'https://grok.com/c/personal', status: 'complete'}]]);
  const b = rig({jobs: {A: doneGrok()}, tabs, handler: takenOver('edited', false), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
  await ticks(b);
  assert.deepEqual(b.closedTabs, [], 'the verdict keeps the tab');
  const kept = b.local.state[LEDGER][10];
  assert.equal(kept?.cause, 'edited', 'still Ashlar\'s: not released as the user\'s');
  assert.equal(Number.isFinite(kept.endedAt), true);
  assert.equal(events(b).includes('turn_render_differs'), true, JSON.stringify(events(b)));
  assert.equal((await b.context.sweepGrokTabs()).closed, 0, 'inside the grace');
  b.local.state[LEDGER][10].endedAt = Date.now() - 6 * MIN;
  const swept = await b.context.sweepGrokTabs();
  assert.equal(swept.closed, 1, JSON.stringify(swept));
  assert.deepEqual(b.closedTabs, [10]);
  assert.equal(b.tabs.has(99), true, 'a tab the ledger does not name stays');
  assert.deepEqual(b.local.state[LEDGER], {});
});

test('a Grok leg preserved as edited WITH user input, or by an older page that reports none, is released as the user\'s', async () => {
  for (const userInput of [true, undefined]) {
    const tabs = new Map([[10, {id: 10, url: CONV, status: 'complete'}]]);
    const b = rig({jobs: {A: doneGrok()}, tabs, handler: takenOver('edited', userInput), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
    await ticks(b);
    assert.deepEqual(b.local.state[LEDGER], {}, `userInput=${userInput}`);
    assert.deepEqual(b.closedTabs, []);
  }
});

test('a regenerate inferred without user input is kept in the ledger too; a draft or follow-up never is', async () => {
  const cases = {regenerated: {false: true}, draft: {false: false}, user_turn: {false: false}};
  for (const [cause, expectKept] of Object.entries(cases)) {
    const tabs = new Map([[10, {id: 10, url: CONV, status: 'complete'}]]);
    const b = rig({jobs: {A: doneGrok()}, tabs, handler: takenOver(cause, false), ledger: {10: entry(10, {jobId: 'A', runId: 'A-run'})}});
    await ticks(b);
    assert.equal(b.local.state[LEDGER][10] !== undefined, expectKept.false, cause);
  }
});

test('the sweep closes an ended tab whose page says edited without input, and releases one that says edited with input', async () => {
  const ended = {endedAt: Date.now() - 30 * MIN, how: 'preserved', cause: 'edited'};
  const tabs = new Map([[1, {id: 1, url: CONV, status: 'complete'}], [2, {id: 2, url: CONV + '2', status: 'complete'}], [3, {id: 3, url: CONV + '3', status: 'complete', active: true}]]);
  const b = rig({tabs, ledger: {1: entry(1, ended), 2: entry(2, ended), 3: entry(3, ended)},
    handler: (id, msg) => msg.type === 'ashlar-can-close'
      ? {ok: true, ownership: 'takenOver', cause: 'edited', userInput: id === 2} : {ok: false, code: 'busy'}});
  await b.context.sweepGrokTabs();
  assert.deepEqual(b.closedTabs, [1]);
  assert.equal(b.tabs.has(2), true, 'real user input: released');
  assert.equal(b.local.state[LEDGER][2], undefined);
  assert.equal(b.tabs.has(3), true, 'the active tab is never closed');
  assert.notEqual(b.local.state[LEDGER][3], undefined, 'and stays owned');
});

test('ChatGPT path unchanged in the worker: an edited ChatGPT leg is preserved and never enters the ledger', async () => {
  const tabs = new Map([[10, {id: 10, url: 'https://chatgpt.com/c/abc?temporary-chat=true', status: 'complete'}]]);
  const job = doneGrok();
  job.providers = ['chatgpt'];
  job.states = {chatgpt: job.states.grok};
  const b = rig({jobs: {A: job}, tabs, handler: takenOver('edited', false)});
  await ticks(b);
  assert.deepEqual(b.closedTabs, []);
  assert.deepEqual(b.local.state[LEDGER] || {}, {});
});
