import test from 'node:test';
import assert from 'node:assert/strict';
import {background, storage} from './helpers.mjs';

const job = () => ({jobId: 'job-1', kind: undefined, states: {chatgpt: {runId: 'run-1', tabId: 7, started: true, workerEvents: [{stage: 'run_dispatched'}]}}});
const tabs = () => new Map([[7, {id: 7, url: 'https://chatgpt.com/c/secret-conversation?temporary-chat=true', status: 'complete'}]]);

test('the binding probe stores match flags and a URL shape, never the conversation id or prompt (1.1.27 diagnostics)', async () => {
  const local = storage({origin: 'http://bridge', token: 'token'});
  const bg = background({local, tabs: tabs(), handler: () => ({ok: true, jobId: '', runId: '', released: false, ownershipProtocol: 1, url: 'https://chatgpt.com/c/secret-conversation'})});
  const j = job();
  await bg.context.recordBindingProbe(j, 'chatgpt', {ok: false, code: 'idle', jobId: '', prompt: 'SECRET PROMPT'});
  const [rec] = (await local.get(['bindingProbes'])).bindingProbes;
  assert.equal(rec.reply.code, 'idle');
  assert.equal(rec.reply.jobMatch, false);
  assert.equal(rec.page.hasJob, false);
  assert.equal(rec.page.url, 'chatgpt.com/c/*');
  assert.equal(rec.tab.url, 'chatgpt.com/c/*?temporary-chat');
  assert.deepEqual(rec.steps, ['run_dispatched']);
  assert.doesNotMatch(JSON.stringify(rec), /secret|SECRET/);
  // Throttled: a second mismatch within a minute adds nothing.
  await bg.context.recordBindingProbe(j, 'chatgpt', {ok: false, code: 'idle'});
  assert.equal((await local.get(['bindingProbes'])).bindingProbes.length, 1);
});

test('the binding probe is off with bindingProbe:false', async () => {
  const local = storage({origin: 'http://bridge', token: 'token', bindingProbe: false});
  const bg = background({local, tabs: tabs(), handler: () => ({ok: true})});
  await bg.context.recordBindingProbe(job(), 'chatgpt', {ok: false, code: 'idle'});
  assert.equal((await local.get(['bindingProbes'])).bindingProbes, undefined);
});
