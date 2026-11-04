// D — latest head only, no re-posting (Settings postLatestHeadOnly / findingDedupePrior, default on).
// Production module graph (app-fixture): only GitHub I/O and settings persistence are adapters.
// Synthetic PR content only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, eventually} from './app-fixture.mjs';
import {inlineFindingComment} from '../../src/lib/review-format.ts';

const BOT = 'ashlar-bot-review-loop[bot]';
const OLD_HEAD = '0123456789abcdef0123456789abcdef01234567';
const finding = {
  severity: 'P1', file: 'a.ts', line: 1, side: 'RIGHT',
  title: 'Answer constant changed without migrating stored answers',
  failure_scenario: 'A stored answer of 41 no longer matches after deploy.',
  root_cause: 'The constant is compared against persisted values.',
  evidence: 'a.ts:1 `export const answer = 42;` replaces 41',
  recommended_fix: 'Migrate stored answers.', recommended_test: 'Load a stored 41 and compare.',
};
const other = {...finding, title: 'Answer exported as a mutable binding', evidence: 'a.ts:1 `export const answer` is re-exported by name elsewhere'};
const reply = (...findings) => JSON.stringify({findings, merge_recommendation: findings.length ? 'REQUEST_CHANGES' : 'COMMENT', investigated_safe: ['a.ts: constant only']});

const job = (app, id) => app.harbor.getHarbor().jobs.find((j) => j.id === id);
async function ready(app, out) {
  await eventually(() => job(app, out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  return job(app, out.jobId);
}
const submit = (app, id, raw) => app.harbor.submitHarborChat(id, raw, [{provider: 'chatgpt', raw}], {force: true});
const ended = (app, id) => eventually(() => ['posted', 'skipped', 'dlq', 'cancelled'].includes(job(app, id)?.status), `job ${id} did not finish`);
const push = (app, sha, deliveryId, updatedAt) => app.harbor.ingestGitHubWebhook({hmacOk: true, deliveryId, event: 'pull_request', payload: {
  action: 'synchronize', installation: {id: 1}, repository: {full_name: 'fixture/fixture'}, sender: {login: 'author'},
  pull_request: {number: 1, title: 'fixture', body: 'No request here', draft: false, head: {sha, repo: {fork: false}}, base: {sha: 'def456'}, user: {login: 'author'},
    ...(updatedAt ? {updated_at: updatedAt} : {})},
}});
const toInline = (f) => ({id: 'p1', status: 'accepted', severity: f.severity, file: f.file, line: f.line, side: 'RIGHT', title: f.title,
  failureScenario: f.failure_scenario, rootCause: f.root_cause, evidence: f.evidence, recommendedFix: f.recommended_fix, recommendedTest: f.recommended_test});
/** The bot's earlier review on `head`: one inline finding comment plus its summary body. */
const priorOn = (head, f = finding) => ({
  listReviewComments: () => [{id: 7, userLogin: BOT, userType: 'Bot', path: f.file, line: f.line, commitId: head, createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z', body: inlineFindingComment(toInline(f), {owner: 'fixture', repo: 'fixture', headSha: head})}],
  listPullReviews: () => [{userLogin: BOT, commitId: head, submittedAt: '2026-11-01T00:00:00Z',
    body: '<!-- ashlar-review-summary -->\n\n### 💡 Ashlar Review\n\n<!-- ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 p2=0 -->'}],
});

test('head moved before posting: the review is not posted and the ops comment says why (no fix loop, no clean marker)', async (t) => {
  const pull = {};
  const app = await appFixture({reviewLocal: false}, {pull});
  t.after(() => app.close());
  const out = await app.mention('stale-head');
  await ready(app, out);
  pull.headSha = 'fff9990aaaabbbb';
  await submit(app, out.jobId, reply(finding));
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, 'skipped');
  assert.match(done.skipReason, /stale head: reviewed abc123, HEAD moved to fff9990/);
  assert.equal(done.headMovedTo, 'fff9990aaaabbbb');
  assert.equal(app.reviews.length, 0, 'a review of a moved head is never posted');
  await eventually(() => app.ops.some((b) => b.includes(out.jobId) && b.includes('Reviewed abc123, but HEAD moved to fff9990 — review not posted (request /review again).')),
    'ops comment explains the stale-head skip');
  assert.ok(app.githubCalls.timeline.lastIndexOf('head') > app.githubCalls.timeline.indexOf('snapshot'), 'the head is checked at post time');
});

test('postLatestHeadOnly off: the review still posts on a moved head and only notes the move (previous behaviour)', async (t) => {
  const pull = {};
  const app = await appFixture({reviewLocal: false, postLatestHeadOnly: false}, {pull});
  t.after(() => app.close());
  const out = await app.mention('stale-head-off');
  await ready(app, out);
  pull.headSha = 'fff9990aaaabbbb';
  await submit(app, out.jobId, reply(finding));
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, 'posted');
  assert.equal(app.reviews.length, 1);
  await eventually(() => app.ops.some((b) => b.includes(out.jobId) && /Reviewed abc123 \(HEAD moved to fff9990\)/.test(b)), 'post-hoc HEAD note');
});

test('unchanged head: the pre-post check passes and the review posts', async (t) => {
  const app = await appFixture({reviewLocal: false});
  t.after(() => app.close());
  const out = await app.mention('same-head-post');
  await ready(app, out);
  await submit(app, out.jobId, reply(finding));
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, 'posted');
  assert.equal(app.reviews.length, 1);
  assert.equal(app.reviews[0].headSha, 'abc123');
});

test('a push cancels the live review of the old head without starting a new LLM review', async (t) => {
  const pull = {};
  const app = await appFixture({reviewLocal: true}, {pull});
  t.after(() => app.close());
  const out = await app.mention('push-supersede');
  await ready(app, out);
  await eventually(() => app.localRequests.length === 1, 'the old head\'s local leg is running');
  const before = {jobs: app.harbor.getHarbor().jobs.length, snapshots: app.githubCalls.snapshot};
  const same = push(app, 'abc123', 'push-same-head');
  assert.equal(same.queued, false);
  assert.equal(job(app, out.jobId).status, 'awaiting_chat', 'a synchronize at the reviewed head cancels nothing');
  pull.headSha = 'fff9990aaaabbbb'; // the live PR head IS the pushed sha
  const res = push(app, 'fff9990aaaabbbb', 'push-new-head');
  assert.equal(res.queued, false, 'a push never queues a review');
  assert.deepEqual([...res.superseding], [out.jobId]);
  await eventually(() => job(app, out.jobId).status === 'cancelled', 'superseded once the live head is confirmed');
  const cancelled = job(app, out.jobId);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.skipReason, /superseded: HEAD moved to fff9990 \(push\)/);
  assert.equal(app.harbor.getHarbor().jobs.length, before.jobs, 'no new job');
  assert.equal(app.githubCalls.snapshot, before.snapshots, 'no new snapshot');
  assert.equal(app.bridge.takeNextBridgeJob('fixture-client'), null, 'nothing for the chat reviewers');
  await eventually(() => app.ops.some((b) => b.includes(out.jobId) && /Cancelled: superseded: HEAD moved to fff9990/.test(b)), 'ops comment marks the job terminal');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.localRequests.length, 1, 'no new local LLM request for the pushed head');
  await eventually(() => app.localResponses[0].req.destroyed || app.localResponses[0].destroyed, 'the old head\'s local leg was aborted');
});

test('postLatestHeadOnly off: a push leaves the old-head review running', async (t) => {
  const app = await appFixture({reviewLocal: false, postLatestHeadOnly: false});
  t.after(() => app.close());
  const out = await app.mention('push-off');
  await ready(app, out);
  const res = push(app, 'fff9990aaaabbbb', 'push-off-new-head');
  assert.equal(res.superseding, undefined);
  assert.equal(job(app, out.jobId).status, 'awaiting_chat');
});

// A push event can arrive late, out of order, or twice (GitHub redelivers): it must never cancel the
// review of the head the PR is actually on.
test('a redelivered or out-of-order push never cancels the review of the current head', async (t) => {
  const pull = {};
  const app = await appFixture({reviewLocal: false}, {pull});
  t.after(() => app.close());
  push(app, '0ld0ld0ld0ld', 'push-old');
  const out = await app.mention('current-head');
  await ready(app, out);
  assert.equal(job(app, out.jobId).headSha, 'abc123');
  // The same delivery redelivered: a duplicate supersedes nothing (and reads no head).
  const heads = app.githubCalls.head;
  const again = push(app, '0ld0ld0ld0ld', 'push-old');
  assert.equal(again.superseding, undefined);
  // A late push of an older head (new delivery id): the live head is still abc123, so nothing is cancelled.
  const late = push(app, '0ld0ld0ld0ld', 'push-old-late');
  assert.deepEqual([...late.superseding], [out.jobId], 'a candidate until the live head is read');
  await eventually(() => app.githubCalls.head > heads, 'the live head is read before cancelling');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(job(app, out.jobId).status, 'awaiting_chat', 'the current head\'s review keeps running');
});

test('a push only supersedes jobs created before it, and a failed head read cancels nothing', async (t) => {
  const pull = {};
  const opts = {pull};
  const app = await appFixture({reviewLocal: false}, opts);
  t.after(() => app.close());
  const out = await app.mention('created-after-push');
  await ready(app, out);
  pull.headSha = 'fff9990aaaabbbb'; // the PR is on the pushed head
  // The push's updated_at predates the job: the job was requested after that push.
  const early = push(app, 'fff9990aaaabbbb', 'push-before-job', new Date(job(app, out.jobId).createdAt - 60_000).toISOString());
  assert.equal(early.superseding, undefined);
  opts.headError = new Error('head read down');
  const failing = push(app, 'fff9990aaaabbbb', 'push-head-down');
  assert.deepEqual([...failing.superseding], [out.jobId]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(job(app, out.jobId).status, 'awaiting_chat', 'fail-open: an unreadable live head cancels nothing');
});

test('same head reviewed twice: a review that only repeats the findings already posted on this head is not posted', async (t) => {
  const app = await appFixture({reviewLocal: false}, priorOn('abc123'));
  t.after(() => app.close());
  const out = await app.mention('same-head-repeat');
  await ready(app, out);
  await submit(app, out.jobId, reply({...finding, line: 1}));
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.status, 'skipped');
  assert.match(done.skipReason, /no new findings since the review on abc123/);
  assert.equal(app.reviews.length, 0);
  await eventually(() => app.ops.some((b) => b.includes(out.jobId) && b.includes('No new findings since the review on abc123 — review not posted.')), 'ops note');
});

test('same head with a new finding posts; a prior review on another head does not suppress a same-head check', async (t) => {
  const app = await appFixture({reviewLocal: false}, priorOn('abc123'));
  t.after(() => app.close());
  const out = await app.mention('same-head-new');
  await ready(app, out);
  await submit(app, out.jobId, reply(finding, other));
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, 'posted');
  assert.equal(app.reviews.length, 1);

  const moved = await appFixture({reviewLocal: false}, priorOn(OLD_HEAD));
  t.after(() => moved.close());
  const again = await moved.mention('older-head-prior');
  await ready(moved, again);
  await submit(moved, again.jobId, reply(finding));
  await ended(moved, again.jobId);
  assert.equal(job(moved, again.jobId).status, 'posted', 'the same-head rule only covers the head the bot already reviewed');
});

test('a loop-driven review keeps its same-head verdict (the loop needs one)', async (t) => {
  const app = await appFixture({reviewLocal: false}, priorOn('abc123'));
  t.after(() => app.close());
  const out = app.harbor.ingestGitHubWebhook({hmacOk: true, deliveryId: 'loop-start', event: 'issue_comment', payload: {action: 'created', installation: {id: 1},
    repository: {full_name: 'fixture/fixture'}, sender: {login: 'author'}, issue: {number: 1, pull_request: {}, title: 'fixture'}, comment: {id: 43, body: '/review-loop'}}});
  await ready(app, out);
  assert.equal(job(app, out.jobId).thread?.loop?.kind, 'start');
  await submit(app, out.jobId, reply(finding));
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, 'posted');
});

test('prior findings listing fails: the review still posts and the ops comment says the duplicate check was skipped', async (t) => {
  const app = await appFixture({reviewLocal: false}, {listPullReviews: () => { throw new Error('reviews listing down'); }});
  t.after(() => app.close());
  const out = await app.mention('prior-listing-fails');
  await ready(app, out);
  await submit(app, out.jobId, reply(finding));
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, 'posted');
  await eventually(() => app.ops.some((b) => b.includes(out.jobId) && /Prior findings could not be listed \(Error: reviews listing down\) — no duplicate check/.test(b)), 'fail-open note');
});

// Integration: the finding gate's prior-finding dedupe (GateContext.priorFindings from the listing above)
// and the poster's "nothing new" skip share one count, Job.priorDuplicates, stamped from the gate's stats.
test('findingGate=rules: a finding the bot already posted on an older head is dropped and nothing is re-posted', async (t) => {
  const app = await appFixture({reviewLocal: false, findingGate: 'rules'}, priorOn(OLD_HEAD));
  t.after(() => app.close());
  const out = await app.mention('gate-prior-repeat');
  await ready(app, out);
  await submit(app, out.jobId, reply(finding));
  await ended(app, out.jobId);
  const done = job(app, out.jobId);
  assert.equal(done.priorDuplicates, 1, 'the gate dropped the repeat and the count reached the job');
  assert.equal(done.gateStats?.reasons?.already_reported, 1);
  assert.equal(done.status, 'skipped');
  assert.match(done.skipReason, /no new findings since the review on 0123456/);
  assert.equal(app.reviews.length, 0, 'neither the repeat nor a clean total=0 review reaches GitHub');
});

test('findingGate=rules: a new finding next to a repeat posts alone', async (t) => {
  const app = await appFixture({reviewLocal: false, findingGate: 'rules'}, priorOn(OLD_HEAD));
  t.after(() => app.close());
  const out = await app.mention('gate-prior-plus-new');
  await ready(app, out);
  const fresh = {...finding, title: 'Checksum table still pins the old answer', evidence: 'a.ts:1 `export const answer = 42;` while the table expects 41'};
  await submit(app, out.jobId, reply(finding, fresh));
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, 'posted');
  assert.equal(app.reviews.length, 1);
  assert.match(app.reviews[0].body, /<!-- ashlar-findings total=1 /);
  assert.doesNotMatch(JSON.stringify(app.reviews[0]), /without migrating stored answers/);
});

test('findingGate=rules: a loop-driven review is not deduped against earlier heads (the loop must see an unresolved finding again)', async (t) => {
  const app = await appFixture({reviewLocal: false, findingGate: 'rules'}, priorOn(OLD_HEAD));
  t.after(() => app.close());
  const out = app.harbor.ingestGitHubWebhook({hmacOk: true, deliveryId: 'loop-start-gate', event: 'issue_comment', payload: {action: 'created', installation: {id: 1},
    repository: {full_name: 'fixture/fixture'}, sender: {login: 'author'}, issue: {number: 1, pull_request: {}, title: 'fixture'}, comment: {id: 44, body: '/review-loop'}}});
  await ready(app, out);
  await submit(app, out.jobId, reply(finding));
  await ended(app, out.jobId);
  assert.equal(job(app, out.jobId).status, 'posted');
  assert.match(app.reviews[0].body, /<!-- ashlar-findings total=1 /);
});
