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
