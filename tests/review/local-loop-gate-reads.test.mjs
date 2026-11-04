// The finding gate and the local multi-turn leg. Production Harbor + Local HTTP (appFixture); GitHub
// and model replies are controlled. Synthetic PR content only.
// - The gate verifies the leg's quotes against the files its loop read at the reviewed head (file_read
//   beyond the snapshot), not only against the snapshot: a quote copied from an unchanged helper the
//   loop read is real head code.
// - A grouped run with a failed group whose other groups report only what the gate drops or notes is a
//   partial run: it never posts as a clean (converged) review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, eventually} from './app-fixture.mjs';
import {isZeroFindings} from '../../src/lib/review-loop.ts';

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

test('findingGate=rules: a grouped local run with a failed group and only a noted remark elsewhere is not a clean review', async (t) => {
  const files = [
    {path: 'a.ts', content: 'export const answer = 42;\n', language: 'ts'},
    {path: 'b.ts', content: 'export const greeting = "Hello";\n', language: 'ts'},
  ];
  const diff = '--- a.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n\n--- b.ts\n@@ -1 +1 @@\n-export const greeting = "Hi";\n+export const greeting = "Hello";';
  const app = await appFixture({reviewChatgpt: false, localReviewMode: 'multiturn', localJsonRepairEnabled: false, findingGate: 'rules'},
    {snapshot: {changedPaths: ['a.ts', 'b.ts'], files, diff}});
  t.after(() => app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM = 'false';
  app.env.ASHLAR_LOCAL_REVIEW_MAX_FILES_PER_GROUP = '1';
  const out = await app.mention('local-loop-partial-notes');
  await eventually(() => app.localRequests.length === 1, 'first group request');
  const group = (i) => /Review only: ([^\s.]+\.ts)\./.exec(app.localRequests[i].messages.map((m) => m.content).join('\n'))?.[1];
  const first = group(0);
  assert.ok(first, 'the first group names its file');
  // The first group reports only an i18n remark (the gate routes it to notes)…
  const remark = {
    severity: 'P2', file: first, line: 1, side: 'RIGHT', title: 'Hard-coded English text in the exported constant',
    failure_scenario: 'Korean users read English.', root_cause: 'The value is not localized.', evidence: `${first}:1 \`export const\``,
    recommended_fix: 'Move it to the i18n catalog.', recommended_test: 'Render in Korean.',
  };
  app.localResponses[0].end(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({findings: [remark], merge_recommendation: 'COMMENT', investigated_safe: []})}}], usage: {prompt_tokens: 10}}));
  // …and the second group's request fails.
  await eventually(() => app.localRequests.length === 2, 'second group request');
  assert.notEqual(group(1), first);
  app.localResponses[1].writeHead(400, {'Content-Type': 'application/json'});
  app.localResponses[1].end(JSON.stringify({error: {message: 'context length exceeded'}}));
  await eventually(() => ['posted', 'skipped', 'dlq'].includes(job(app, out.jobId)?.status), 'job did not finish');
  const done = job(app, out.jobId);
  const body = app.reviews.map((r) => r.body).join('\n');
  assert.ok(!isZeroFindings(body, {authoredByBot: true}), `a partial run never reads as CONVERGED (${done.status}: ${done.skipReason ?? ''})`);
  assert.doesNotMatch(body, /ashlar-findings total=0 inline=0 body=0 p0=0 p1=0 p2=0 -->/, 'no clean findings marker');
  assert.doesNotMatch(body.toLowerCase(), /didn't find any major issues/, 'no clean sentinel');
  // It posts as evidence: the leg's reply verbatim (raw=1) beside the noted remark.
  assert.equal(done.status, 'posted');
  assert.match(body, /<!-- ashlar-findings total=0 inline=0 body=1 raw=1 /);
  assert.match(body, /Notes \(not findings\)[\s\S]*Hard-coded English text/);
});
