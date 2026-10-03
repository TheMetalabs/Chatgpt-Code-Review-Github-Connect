import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, eventually} from './app-fixture.mjs';
import {isZeroFindings} from '../../src/lib/review-loop.ts';
import {CLEAN_REVIEW_BODY, REVIEW_RAW_START} from '../../src/lib/review-format.ts';
import {salvageReviewJson} from '../../src/lib/extract-chat-json.ts';

const clean = JSON.stringify({
  findings: [],
  merge_recommendation: 'COMMENT',
  investigated_safe: ['a.ts: constant change only'],
});
const finding = {
  severity: 'P1',
  file: 'a.ts',
  line: 1,
  side: 'RIGHT',
  title: 'Auxiliary finding',
  failure_scenario: 'A duplicate request writes twice',
  root_cause: 'No guard',
  evidence: 'a.ts:1: no guard',
  recommended_fix: 'Check the key',
  recommended_test: 'Assert one write',
};
const grokFinding = JSON.stringify({findings: [finding], merge_recommendation: 'REQUEST_CHANGES'});
const malformedWithFindingMarker = salvageReviewJson(
  '{"merge_recommendation":"REQUEST_CHANGES","findings":[{"severity":"P1","file":"a.ts"',
);

async function posted(app, out) {
  await eventually(() => app.reviews.length === 1, `review ${out.jobId} was not posted`);
  return app.reviews[0].body;
}

test('canonical ChatGPT clean stays clean beside malformed auxiliary Grok raw', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-malformed-raw');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId, clean, [
    {provider: 'chatgpt', raw: clean},
    {provider: 'grok', raw: malformedWithFindingMarker},
  ], {force: true});
  const body = await posted(app, out);
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), true);
  assert.equal(body.includes(REVIEW_RAW_START), false, 'auxiliary malformed raw is out-of-band evidence');
  assert.deepEqual({...job.auxiliaryProviderFailures}, {grok: 'unparseable'});
  assert.deepEqual(job.rawCauses ?? {}, {});
});

test('valid auxiliary Grok findings remain visible beside a canonical ChatGPT clean', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-valid-finding');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId, clean, [
    {provider: 'chatgpt', raw: clean},
    {provider: 'grok', raw: grokFinding},
  ], {force: true});
  const body = await posted(app, out);
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(app.reviews[0].comments.some((comment) => comment.body.includes('Auxiliary finding')), true);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.equal(job.incompleteProviders?.length ?? 0, 0);
  assert.deepEqual(job.auxiliaryProviderFailures ?? {}, {});
});

test('missing canonical ChatGPT cannot be replaced by a clean auxiliary Grok reply', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-missing-canonical');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId, clean, [{provider: 'grok', raw: clean}], {force: true});
  const body = await posted(app, out);
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.match(body, /ashlar-outcome incomplete/);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.ok(job.incompleteProviders?.includes('chatgpt'));
  assert.ok(job.skippedProviders?.includes('chatgpt'));
});
