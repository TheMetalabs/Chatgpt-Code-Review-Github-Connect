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

test('bridge-salvaged schema-rejected auxiliary Grok stays blocking evidence', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-schema-rejected-raw');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob('auxiliary-schema-rejected-client');
  assert.equal(take?.jobId, out.jobId, 'bridge claims the review');
  const rejected = JSON.stringify({
    findings: 'GROK-RAW P1 a.ts:1 duplicate write',
    merge_recommendation: 'REQUEST_CHANGES',
  });
  const result = await app.bridge.completeBridgeJob(
    out.jobId,
    clean,
    [{provider: 'chatgpt', raw: clean}, {provider: 'grok', raw: rejected}],
    take.leaseId,
  );
  assert.equal(result.ok, true);
  const body = await posted(app, out);
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(body.includes(REVIEW_RAW_START), true, 'schema-rejected auxiliary reply remains evidence');
  assert.match(body, /GROK-RAW P1 a\.ts:1 duplicate write/);
  assert.deepEqual({...job.rawCauses}, {grok: 'not-a-verdict'});
  assert.deepEqual(job.auxiliaryProviderFailures ?? {}, {});
  assert.equal(job.localVerifyStartedAt, undefined);
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

test('logged-out canonical ChatGPT can be replaced by a clean structured Grok reply', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-missing-canonical');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob('matrix-client');
  assert.equal(take?.jobId, out.jobId, 'the bridge claims the job');
  assert.equal(app.bridge.failBridgeProvider(out.jobId, 'chatgpt', 'logged_out: ChatGPT is logged out', take.leaseId), true);
  await app.harbor.submitHarborChat(out.jobId, clean, [{provider: 'grok', raw: clean}], {force: true});
  const body = await posted(app, out);
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), true);
  assert.equal(job.incompleteProviders?.length ?? 0, 0);
  assert.equal(job.skippedProviders?.length ?? 0, 0);
  assert.equal(job.canonicalProvider, 'grok');
});

test('a worker-skipped canonical ChatGPT can be replaced by a clean structured Grok reply', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-missing-canonical');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob('matrix-client');
  assert.equal(take?.jobId, out.jobId, 'the bridge claims the job');
  assert.equal(app.bridge.failBridgeProvider(out.jobId, 'chatgpt', 'quota: usage limit reached', take.leaseId), true);
  await app.harbor.submitHarborChat(out.jobId, clean, [{provider: 'grok', raw: clean}], {force: true});
  const body = await posted(app, out);
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(job.canonicalProvider, 'grok');
  assert.equal(job.skippedProviders?.length ?? 0, 0);
});

test('a missing canonical ChatGPT payload without a worker skip stays incomplete', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-missing-canonical');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId, clean, [{provider: 'grok', raw: clean}], {force: true});
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(job.status, 'posted');
  assert.match(app.reviews[0].body, /ashlar-outcome incomplete/);
  assert.ok(
    job.incompleteProviders?.includes('chatgpt') || job.skippedProviders?.includes('chatgpt'),
    'ChatGPT stays blocking when it sent no payload and has no skip/logged_out record',
  );
  assert.equal(job.canonicalProvider, 'chatgpt');
});

test('logged-out ChatGPT does not make malformed Grok evidence clean', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-malformed-raw');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob('matrix-client');
  assert.equal(take?.jobId, out.jobId, 'the bridge claims the job');
  assert.equal(app.bridge.failBridgeProvider(out.jobId, 'chatgpt', 'logged_out: ChatGPT is logged out', take.leaseId), true);
  await app.harbor.submitHarborChat(out.jobId, clean, [{provider: 'grok', raw: malformedWithFindingMarker}], {force: true});
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(job.status, 'skipped');
  assert.match(job.skipReason, /no valid review JSON|grok/i);
  assert.equal(app.reviews.length, 0);
});

test('a ChatGPT transport failure stays incomplete in race mode', async (t) => {
  const app = await appFixture({reviewLocal: false, reviewGrok: true});
  t.after(() => app.close());
  const out = await app.mention('auxiliary-missing-canonical');
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob('matrix-client');
  assert.equal(take?.jobId, out.jobId, 'the bridge claims the job');
  assert.equal(app.bridge.failBridgeProvider(out.jobId, 'chatgpt', 'disconnected: worker unavailable', take.leaseId), true);
  await app.harbor.submitHarborChat(out.jobId, clean, [{provider: 'grok', raw: clean}], {force: true});
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.equal(job.status, 'posted');
  assert.match(app.reviews[0].body, /ashlar-outcome incomplete/);
  assert.ok(job.incompleteProviders?.includes('chatgpt'));
});

async function submitGrokAfterChatgptFail(app, error) {
  const out = await app.mention('auxiliary-missing-canonical');
  const job = () => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  await eventually(() => job()?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob('matrix-client');
  assert.equal(take?.jobId, out.jobId, 'the bridge claims the job');
  assert.equal(app.bridge.failBridgeProvider(out.jobId, 'chatgpt', error, take.leaseId), true);
  await app.harbor.submitHarborChat(out.jobId, clean, [{provider: 'grok', raw: clean}], {force: true});
  return {out, job};
}

test('a valid Grok clean can recover a ChatGPT transport failure only through local verification', async (t) => {
  const app = await appFixture({reviewLocal: true, reviewGrok: true, localReviewRole: 'verify-clean'});
  t.after(() => app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM = 'false';
  const {out, job} = await submitGrokAfterChatgptFail(app, 'disconnected: worker unavailable');
  await eventually(() => app.localRequests.length === 1, 'Cloud Verify did not start');
  assert.equal(app.reviews.length, 0, 'no review until local verification finishes');
  assert.notEqual(job().canonicalProvider, 'grok', 'canonical stays ChatGPT until local confirms');
  assert.ok(job().providerErrors?.chatgpt, 'ChatGPT remains a recorded blocking failure');
  app.localResponses[0].end(JSON.stringify({choices: [{message: {content: clean}}]}));
  await posted(app, out);
  assert.equal(job().canonicalProvider, 'grok');
  assert.equal(job().incompleteProviders?.length ?? 0, 0);
  assert.equal(job().skippedProviders?.length ?? 0, 0);
  assert.equal(job().localVerified, true);
});

function assertBlockedTransportFallback(job, body, {incompleteBody}) {
  assert.ok(['posted', 'skipped'].includes(job.status), `job status ${job.status}`);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.ok(
    job.incompleteProviders?.includes('chatgpt'),
    `ChatGPT must be stamped incomplete after verify-clean local settles; incomplete=${JSON.stringify(job.incompleteProviders)} skipped=${JSON.stringify(job.skippedProviders)} canonical=${job.canonicalProvider}`,
  );
  assert.ok(
    job.incompleteProviders?.includes('chatgpt') || job.skippedProviders?.includes('chatgpt'),
    'ChatGPT stays blocking when local does not confirm a clean fallback',
  );
  assert.notEqual(job.canonicalProvider, 'grok', 'do not promote Grok after a non-clean or failed local result');
  if (incompleteBody) assert.match(body, /ashlar-outcome incomplete/);
}

test('a verify-clean transport fallback does not promote Grok when local returns a finding', async (t) => {
  const app = await appFixture({reviewLocal: true, reviewGrok: true, localReviewRole: 'verify-clean'});
  t.after(() => app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM = 'false';
  const {out, job} = await submitGrokAfterChatgptFail(app, 'disconnected: worker unavailable');
  await eventually(() => app.localRequests.length === 1, 'Cloud Verify did not start');
  assert.equal(app.reviews.length, 0);
  app.localResponses[0].end(JSON.stringify({choices: [{message: {content: grokFinding}}]}));
  const body = await posted(app, out);
  assertBlockedTransportFallback(job(), body, {incompleteBody: false});
  assert.equal(app.reviews[0].comments.some((comment) => comment.body.includes('Auxiliary finding')), true);
});

test('a verify-clean transport fallback does not promote Grok when local errors', async (t) => {
  const app = await appFixture({reviewLocal: true, reviewGrok: true, localReviewRole: 'verify-clean'});
  t.after(() => app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM = 'false';
  const {job} = await submitGrokAfterChatgptFail(app, 'disconnected: worker unavailable');
  await eventually(() => app.localRequests.length === 1, 'Cloud Verify did not start');
  assert.equal(app.reviews.length, 0);
  app.localResponses[0].writeHead(500, {'content-type': 'application/json'});
  app.localResponses[0].end('{"error":"model crashed"}');
  await eventually(() => ['posted', 'skipped'].includes(job()?.status), 'job never finished after local error');
  assertBlockedTransportFallback(job(), app.reviews[0]?.body, {incompleteBody: true});
});
