// The finding gate verifies the local multi-turn leg's quotes against the files its loop read at the
// reviewed head (file_read beyond the snapshot), not only against the snapshot: a quote copied from an
// unchanged helper the loop read is real head code. Production Harbor + Local HTTP (appFixture); GitHub
// and model replies are controlled. Synthetic PR content only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, eventually} from './app-fixture.mjs';

const HELPER = 'export function toCents(amount: number) {\n  return Math.round(amount * 1000);\n}\n';
const finding = {
  severity: 'P2', file: 'a.ts', line: 1, side: 'RIGHT',
  title: 'Answer is converted with a cents helper that multiplies by 1000',
  failure_scenario: 'An answer of 42 is stored as 42000 cents instead of 4200.',
  root_cause: 'toCents scales by 1000, not 100.',
  evidence: 'lib/money.ts:2 `return Math.round(amount * 1000);`',
  recommended_fix: 'Scale by 100.', recommended_test: 'toCents(1) === 100.',
};
const reply = JSON.stringify({findings: [finding], merge_recommendation: 'COMMENT', investigated_safe: ['a.ts: constant change']});
const toolTurn = (res) => res.end(JSON.stringify({choices: [{finish_reason: 'tool_calls', message: {content: '', tool_calls: [
  {id: 'read-1', type: 'function', function: {name: 'file_read', arguments: JSON.stringify({file_path: 'lib/money.ts'})}}]}}], usage: {prompt_tokens: 10}}));
const final = (res) => res.end(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: reply}}], usage: {prompt_tokens: 10}}));
const job = (app, id) => app.harbor.getHarbor().jobs.find((j) => j.id === id);

test('findingGate=rules: a local finding quoting a file its loop read at head posts (the quote verifies)', async (t) => {
  let reads = 0;
  const app = await appFixture({reviewChatgpt: false, localReviewMode: 'multiturn', localJsonRepairEnabled: false, findingGate: 'rules'},
    {getFile: () => { reads += 1; return HELPER; }});
  t.after(() => app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM = 'false';
  const out = await app.mention('local-loop-gate-reads');
  await eventually(() => app.localRequests.length === 1, 'first local request');
  toolTurn(app.localResponses[0]);
  await eventually(() => app.localRequests.length === 2, 'second local request (after file_read)');
  assert.equal(reads, 1, 'the loop read the helper at head');
  final(app.localResponses[1]);
  await eventually(() => ['posted', 'skipped', 'dlq'].includes(job(app, out.jobId)?.status), 'job did not finish');
  assert.equal(job(app, out.jobId).status, 'posted');
  assert.equal(app.reviews.length, 1);
  const r = app.reviews[0];
  assert.match(r.body + r.comments.map((c) => c.body).join('\n'), /cents helper that multiplies by 1000/, 'the finding posts');
  assert.match(r.body, /<!-- ashlar-findings total=1 /);
});
