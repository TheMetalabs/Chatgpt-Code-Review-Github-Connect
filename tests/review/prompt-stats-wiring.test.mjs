// The ops comment's "Prompt:" line through the production module graph (appFixture): the sections the
// 2026-11 precision work added to the review input — the PR description, the call sites of a changed
// export and the docs the PR changes — are counted as the prompt carried them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, eventually} from './app-fixture.mjs';

const snapshot = {
  body: '## Summary\nRaise the answer to 42.\n\n## Design\nThe checksum table is regenerated in a follow-up PR.',
  changedPaths: ['a.ts', 'b.ts', 'docs/answer.md'],
  files: [
    {path: 'a.ts', content: 'export function answer() {\n  return 42;\n}\n', language: 'ts'},
    {path: 'b.ts', content: 'import { answer } from "./a";\nexport const doubled = answer() * 2;\n', language: 'ts'},
    {path: 'docs/answer.md', content: '# Answer\n\nThe answer is 42.\n', language: 'md'},
  ],
  diff: [
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n export function answer() {\n-  return 41;\n+  return 42;\n }',
    'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n import { answer } from "./a";\n-export const doubled = answer() + answer();\n+export const doubled = answer() * 2;',
    'diff --git a/docs/answer.md b/docs/answer.md\n--- a/docs/answer.md\n+++ b/docs/answer.md\n@@ -1,3 +1,3 @@\n # Answer\n \n-The answer is 41.\n+The answer is 42.',
  ].join('\n'),
};

test('the ops Prompt line counts the PR description, call-site and changed-docs sections', async (t) => {
  const app = await appFixture({reviewLocal: false}, {snapshot});
  t.after(() => app.close());
  const out = await app.mention('prompt-stats');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  const stats = job.promptStats;
  assert.equal(stats.descriptionChars, snapshot.body.length, JSON.stringify(stats));
  assert.ok(stats.callSitesChars > 0, JSON.stringify(stats));
  assert.ok(stats.changedDocsChars > 0, JSON.stringify(stats));
  const reply = JSON.stringify({merge_recommendation: 'APPROVE', findings: [], investigated_safe: ['a.ts: returns 42', 'b.ts: doubles it'], coverage: []});
  await app.harbor.submitHarborChat(out.jobId, reply, [{provider: 'chatgpt', raw: reply}], {force: true});
  await eventually(() => app.ops.some((o) => /Reviewed abc123/.test(o)), 'ops comment was not updated');
  const line = app.ops.at(-1).split('\n').find((l) => l.includes('Prompt: diff')) ?? '';
  assert.match(line, new RegExp(`context \\d+ chars \\(call sites ${stats.callSitesChars}, changed docs ${stats.changedDocsChars}\\), policy \\d+ chars, PR description ${snapshot.body.length} chars`), app.ops.at(-1));
});
