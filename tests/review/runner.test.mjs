import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { content, raw, source, flush } from './helpers.mjs';
for (const provider of ['chatgpt', 'grok']) {
  test(`${provider}: harvest never promotes streaming JSON to success`, () => {
    const c = content(provider);
    assert.notEqual(c.message({ type: 'ashlar-harvest', jobId: 'A' })?.ok, true);
  });
  test(`${provider}: immediate busy, one run, cached final result and job isolation`, async () => {
    const c = content(provider);
    let resolve, runs = 0;
    c.context.runPrompt = () => { runs++; return new Promise(r => { resolve = r; }); };
    const run = { type: 'ashlar-run', jobId: 'A', prompt: 'review' };
    assert.equal(c.message(run)?.code, 'busy');
    await flush();
    assert.equal(c.message(run)?.code, 'busy');
    assert.equal(c.message({ type: 'ashlar-harvest', jobId: 'A' })?.code, 'busy');
    assert.equal(c.message({ ...run, jobId: 'B' })?.code, 'job_mismatch');
    resolve(raw); await flush();
    assert.equal(c.message({ type: 'ashlar-harvest', jobId: 'A' })?.raw, raw);
    assert.equal(c.message(run)?.raw, raw);
    assert.equal(runs, 1);
  });
  test(`${provider}: reinjection keeps one listener and terminal quota`, async () => {
    const c = content(provider);
    c.context.runPrompt = async () => { throw Object.assign(new Error('usage limit'), { code: 'quota' }); };
    c.message({ type: 'ashlar-run', jobId: 'A', prompt: 'review' });
    await flush();
    vm.runInContext(source(`extension/content-${provider}.js`), c.context);
    assert.equal(c.listeners.length, 1);
    assert.equal(c.message({ type: 'ashlar-harvest', jobId: 'A' })?.code, 'quota');
  });
  test(`${provider}: resume observes the existing turn without filling/sending again`, async () => {
    const c = content(provider);
    c.context.waitUntilReviewOrQuota = async () => raw;
    c.context.fillComposer = () => assert.fail('resume resubmitted prompt');
    assert.equal(await c.context.runPrompt('review', 'pro', true), raw);
  });
}
test('queue, stop flicker and generation can last a simulated day before completion', async () => {
  const c = content().context;
  let polls = 0, now = 0;
  c.Date = class extends Date { static now() { return now; } };
  c.sleep = async () => { polls++; now += 60_000; if (polls > 1442) assert.fail('did not finish'); };
  c.stopButtonVisible = () => polls > 720 && polls < 1440 && polls % 3 !== 0;
  c.replyDoneVisible = () => polls >= 1440;
  assert.equal(await c.waitUntilReviewOrQuota('ChatGPT'), raw);
  assert.equal(polls, 1441);
});
test('missing JSON remains pending until explicit test cancellation, never an empty result', async () => {
  const c = content().context;
  c.stopButtonVisible = () => false; c.replyDoneVisible = () => true; c.harvestJson = () => null;
  const cancelled = new Error('test owner cancelled the pending wait'); let polls = 0;
  c.sleep = async () => { if (++polls === 20) throw cancelled; };
  await assert.rejects(c.waitUntilReviewOrQuota('ChatGPT'), e => e === cancelled);
  assert.equal(polls, 20);
});

// X2 (#85): a new ChatGPT run starts only on the new chat its tab was opened on (the worker's
// allocationUrl), with no user turn there. Elsewhere the page refuses it before binding anything
// and fences the run, so a later copy of that message binds stopped.
const OWN = 'https://chatgpt.com/c/users-own';
const withUserTurn = c => { c.context.document = {querySelector: sel => (sel.includes('"user"') ? {textContent: 'mine'} : null), querySelectorAll: () => []}; };
for (const [what, setup, cause] of [
  ['on the user\'s conversation', c => { c.context.location = {href: OWN}; }, 'navigated'],
  ['holding a user turn', withUserTurn, 'user_turn'],
]) {
  test(`chatgpt: a page ${what} refuses a new run: nothing is bound or run, and the run is fenced`, async () => {
    const persisted = new Map();
    const c = content('chatgpt', persisted);
    let runs = 0;
    c.context.runPrompt = async () => { runs++; return raw; };
    setup(c);
    const reply = c.message({ type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'chatgpt', prompt: 'review' });
    assert.deepEqual({ ok: reply?.ok, code: reply?.code, cause: reply?.cause, jobId: reply?.jobId }, { ok: false, code: 'taken_over', cause, jobId: '' });
    await flush();
    assert.equal(runs, 0, 'nothing is typed or sent');
    assert.equal(persisted.get('ashlar:job'), undefined, 'nothing is bound');
    assert.equal(persisted.get('ashlar:stopped:A:run-A'), 'true', 'the run is fenced');
    assert.equal(c.message({ type: 'ashlar-harvest', jobId: 'A', runId: 'run-A', provider: 'chatgpt' })?.code, 'idle');
  });
}
test('chatgpt: a run accepted on its new chat ends taken_over once the tab moves before its Send; a cleared fence (Send clicked) does not', async () => {
  const c = content('chatgpt');
  let resume;
  c.context.runPrompt = async () => { await new Promise(r => { resume = r; }); c.context.throwIfStopped(); return raw; };
  assert.equal(c.message({ type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'chatgpt', prompt: 'review' })?.code, 'busy');
  await flush();
  c.context.location = { href: OWN };
  resume(); await flush();
  assert.equal(c.message({ type: 'ashlar-harvest', jobId: 'A', runId: 'run-A', provider: 'chatgpt' })?.code, 'taken_over');
  // After the click (composer.js clickSend clears freshPage), the provider's own move is not a take-over.
  const d = content('chatgpt');
  d.context.runPrompt = async () => { await new Promise(r => { resume = r; }); d.context.__ashlarRunnerState.freshPage = undefined; d.context.location = { href: OWN }; d.context.throwIfStopped(); return raw; };
  d.message({ type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'chatgpt', prompt: 'review' });
  await flush(); resume(); await flush();
  assert.equal(d.message({ type: 'ashlar-harvest', jobId: 'A', runId: 'run-A', provider: 'chatgpt' })?.raw, raw);
});
for (const [what, provider, href, msg] of [
  ['a ChatGPT new chat without its query', 'chatgpt', 'https://chatgpt.com/', {}],
  ['a Grok page (its fresh-page check is deferred)', 'grok', 'https://grok.com/c/x', {}],
]) {
  test(`control: ${what} accepts a new run`, async () => {
    const c = content(provider);
    let runs = 0;
    c.context.runPrompt = async () => { runs++; return raw; };
    c.context.location = { href };
    assert.equal(c.message({ type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider, prompt: 'review', ...msg })?.code, 'busy');
    await flush();
    assert.equal(runs, 1);
  });
}
test('control: a page already bound to the run is not asked again for its fresh page (a retried start is deduplicated)', async () => {
  const c = content('chatgpt');
  let runs = 0;
  c.context.runPrompt = () => { runs++; return new Promise(() => {}); };
  const run = { type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'chatgpt', prompt: 'review' };
  assert.equal(c.message(run)?.code, 'busy');
  await flush();
  c.context.__ashlarRunnerState.freshPage = undefined; // its Send was clicked
  c.context.location = { href: OWN };
  assert.equal(c.message(run)?.code, 'busy');
  await flush();
  assert.equal(runs, 1);
});
