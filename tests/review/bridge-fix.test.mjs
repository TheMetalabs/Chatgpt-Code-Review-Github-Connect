// bridge.server with the production fix registry: review-loop fix items ride the same per-id
// bridge handlers as review jobs, but never touch harbor jobs or review validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness, job as makeJob, json} from './load-source.mjs';

const FIX = {owner: 'fixture', repo: 'fixture', pr: 9, provider: 'chatgpt', prompt: 'FIX PROMPT (inlines file contents)'};
const quiet = promise => { promise.catch(() => {}); return promise; };
const withParallel = (h, parallelPrs) => { h.state.settings = {...h.state.settings, fixAgent: {...h.state.settings.fixAgent, parallelPrs}}; };

test('a queued fix is offered only to fixProtocol workers; review take is unchanged', async () => {
  const h = bridgeHarness([makeJob({id: 'A', pr: 1, createdAt: Date.now() + 60_000})]);
  const pending = h.bridge.requestBridgeFix(FIX);
  // An older worker (no opt-in) keeps today's behavior: the review job, no kind field.
  const review = h.bridge.takeNextBridgeJob('chrome-1');
  assert.equal(review.jobId, 'A');assert.equal('kind' in review, false);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-2', ['A']), null, 'no fix without the opt-in');
  const offer = h.bridge.takeNextBridgeJob('chrome-2', ['A'], {fixes: true});
  assert.equal(offer.kind, 'fix');assert.match(offer.jobId, /^fix-/);
  assert.deepEqual(offer.providers, ['chatgpt']);assert.deepEqual(offer.resumeProviders, []);
  assert.equal(offer.prompt, FIX.prompt);assert.equal(offer.title, 'fix fixture/fixture#9');
  assert.deepEqual({...offer.reasoning}, {chatgpt: h.state.settings.chatgptReasoning, grok: h.state.settings.grokReasoning});
  assert.equal(h.bridge.completeBridgeFix(offer.jobId, '', [{provider: 'chatgpt', raw: 'ANSWER', originalText: 'ANSWER'}], offer.leaseId).ok, true);
  assert.equal(await pending, 'ANSWER');
  // The review job was never touched by the fix.
  assert.deepEqual(h.state.jobs.map(j => [j.id, j.status, j.storedLegs.length]), [['A', 'awaiting_chat', 0]]);
});

test('the next review goes first only if it predates the fix; one submission per profile across kinds', async () => {
  // B was requested before the fix: it is served first, and the fix waits for B's submission.
  const h = bridgeHarness([makeJob({id: 'B', pr: 2, createdAt: Date.now() - 60_000})]);
  const pending = quiet(h.bridge.requestBridgeFix(FIX));
  const b = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});assert.equal(b.jobId, 'B');
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', ['B'], {fixes: true}), null, 'B is still being submitted');
  h.bridge.refreshBridgeClaim('B', {chatgpt: true}, undefined, b.leaseId);
  const fix = h.bridge.takeNextBridgeJob('chrome-1', ['B'], {fixes: true});assert.equal(fix.kind, 'fix');
  // A review requested after the fix never overtakes it, and a fix being submitted holds this
  // profile's next review too (even for a take without the opt-in) until its generation starts.
  h.state.jobs = [makeJob({id: 'A', pr: 1, createdAt: Date.now() + 60_000}), ...h.state.jobs];
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', ['B', fix.jobId], {fixes: true}), null);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', ['B', fix.jobId]), null);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-2', ['B', fix.jobId]).jobId, 'A', 'another profile is never blocked');
  h.bridge.refreshBridgeClaim(fix.jobId, {chatgpt: true}, undefined, fix.leaseId);
  assert.equal(h.bridge.completeBridgeFix(fix.jobId, 'ANSWER', undefined, fix.leaseId).ok, true);
  assert.equal(await pending, 'ANSWER');
});

test('a fix never jumps ahead of an older review, even when a newer review is the candidate', async () => {
  // harbor lists jobs newest first: R_new is the review candidate, R_old the oldest waiting review
  const h = bridgeHarness([makeJob({id: 'R_new', pr: 3, createdAt: Date.now() + 60_000}), makeJob({id: 'R_old', pr: 1, createdAt: Date.now() - 60_000})]);
  const pending = quiet(h.bridge.requestBridgeFix(FIX));
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true}).jobId, 'R_old', 'the older review blocking the fix is dispatched, not the newer candidate');
  const fix = h.bridge.takeNextBridgeJob('chrome-2', ['R_old'], {fixes: true});
  assert.equal(fix.kind, 'fix', 'with every older review taken, the fix goes before newer ones');
  void pending;
});

test('a stream of newer reviews cannot starve a fix blocked by an older review', async () => {
  // R_old, then the fix, then R_new; newer reviews keep arriving at the front of harbor.jobs.
  const t = Date.now();
  const h = bridgeHarness([makeJob({id: 'R_new', pr: 3, createdAt: t + 60_000}), makeJob({id: 'R_old', pr: 1, createdAt: t - 60_000})]);
  const pending = quiet(h.bridge.requestBridgeFix(FIX));
  const taken = [];
  for (let i = 0; i < 3; i++) {
    h.state.jobs = [makeJob({id: `R_post${i}`, pr: 10 + i, createdAt: t + 120_000 + i}), ...h.state.jobs];
    const offer = h.bridge.takeNextBridgeJob('chrome-1', taken, {fixes: true});
    assert.ok(offer, `take ${i} offers work`);
    taken.push(offer.jobId);
    h.bridge.refreshBridgeClaim(offer.jobId, {chatgpt: true}, undefined, offer.leaseId);
  }
  assert.equal(taken[0], 'R_old', 'the oldest review is taken first, not the newest candidate');
  assert.match(taken[1], /^fix-/, 'then the fix, before any review requested after it');
  assert.equal(taken[2], 'R_post2', 'post-fix reviews follow (newest first)');
  void pending;
});

test('a fix whose take response was lost is replayed to the same profile, not held behind its submit window', async () => {
  const h = bridgeHarness([]);
  const pending = quiet(h.bridge.requestBridgeFix(FIX));
  const lost = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  assert.equal(lost.kind, 'fix');
  const replay = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true}); // the worker never stored it
  assert.equal(replay.jobId, lost.jobId);assert.equal(replay.leaseId, lost.leaseId);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-2', [], {fixes: true}), null, 'another profile never gets it');
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', [lost.jobId], {fixes: true}), null, 'a known fix is being submitted: held');
  void pending;
});

test('recover resumes a running fix through its tab binding; take never re-submits it', async () => {
  const h = bridgeHarness([]);
  const pending = quiet(h.bridge.requestBridgeFix(FIX));
  const offer = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  const progress = {chatgpt: {runId: 'run-A', events: [{source: 'page', sequence: 1, stage: 'generating', at: Date.now()}]}};
  assert.equal(h.bridge.recordBridgeProgress(offer.jobId, offer.leaseId, progress), true);
  const binding = {jobId: offer.jobId, provider: 'chatgpt', runId: 'run-A'};
  // the worker lost its local job while the tab (fix-A/run-A) survives
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true}), null, 'no second tab or prompt for a running fix');
  assert.equal(h.bridge.recoverBridgeJob('chrome-2', [binding]), null, 'another profile cannot resume it');
  assert.equal(h.bridge.recoverBridgeJob('chrome-1', [{...binding, runId: 'run-B'}]), null, 'only the run the server saw');
  const resumed = h.bridge.recoverBridgeJob('chrome-1', [binding]);
  assert.equal(resumed.kind, 'fix');assert.equal(resumed.jobId, offer.jobId);
  assert.deepEqual(resumed.resumeProviders, ['chatgpt']);assert.deepEqual(resumed.bindings, [binding]);
  assert.equal(h.bridge.completeBridgeFix(offer.jobId, 'ANSWER', undefined, resumed.leaseId).ok, true);
  assert.equal(await pending, 'ANSWER');
  assert.equal(h.snapshots.length, 0, 'no harbor job was patched');
});

test('a review of unknown age keeps its precedence over a queued fix', async () => {
  const review = makeJob({id: 'R', pr: 4});delete review.createdAt;
  const h = bridgeHarness([review]);
  const pending = quiet(h.bridge.requestBridgeFix(FIX));
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true}).jobId, 'R');
  assert.equal(h.bridge.takeNextBridgeJob('chrome-2', ['R'], {fixes: true}).kind, 'fix', 'then the fix');
  void pending;
});

test('a fix requested before the next review is served first', async () => {
  const h = bridgeHarness([makeJob({id: 'A', pr: 1, createdAt: Date.now() + 60_000})]);
  const pending = quiet(h.bridge.requestBridgeFix(FIX));
  const fix = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  assert.equal(fix.kind, 'fix');
  h.bridge.refreshBridgeClaim(fix.jobId, {chatgpt: true}, undefined, fix.leaseId);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', [fix.jobId], {fixes: true}).jobId, 'A');
  void pending;
});

test('every per-id handler routes a fix id to the fix item (state, prompt, ping, progress, claim, release, failure)', async () => {
  const h = bridgeHarness([]);
  const pending = h.bridge.requestBridgeFix(FIX);
  const offer = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  const id = offer.jobId;
  assert.deepEqual(h.bridge.bridgeJobState(id), {active: true, status: 'awaiting_chat'});
  assert.deepEqual(h.bridge.promptForJob(id), {prompt: FIX.prompt});
  assert.equal(h.bridge.refreshBridgeClaim(id, {chatgpt: true}, undefined, 'wrong-lease'), false);
  assert.equal(h.bridge.refreshBridgeClaim(id, {chatgpt: true}, undefined, offer.leaseId), true);
  const progress = {chatgpt: {runId: 'run-A', events: [{source: 'page', sequence: 1, stage: 'generating', at: Date.now()}]}};
  assert.equal(h.bridge.recordBridgeProgress(id, offer.leaseId, progress), true);
  assert.equal(h.bridge.recordBridgeProgress(id, 'wrong-lease', progress), false);
  assert.equal(h.bridge.recordBridgeObservation(id, offer.leaseId, 'chatgpt', 'run-A', 'text', 4, false), false, 'no review archive for a fix');
  assert.deepEqual(h.bridge.claimBridgeJob(id, 'chrome-1'), {ok: true, leaseId: offer.leaseId});
  assert.equal(h.bridge.claimBridgeJob(id, 'chrome-2').ok, false);
  h.bridge.releaseBridgeJob(id, offer.leaseId);
  assert.equal(h.bridge.completeBridgeFix(id, 'late', undefined, offer.leaseId).code, 'lease_conflict');
  assert.equal(h.bridge.takeNextBridgeJob('chrome-2', [], {fixes: true}), null, 'a released item stays with its profile');
  const again = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  assert.equal(again.jobId, id, 'release requeued the item for its own profile');
  assert.deepEqual([...again.resumeProviders], ['chatgpt'], 'as a resume');
  assert.equal(h.bridge.failBridgeProvider(id, 'chatgpt', 'quota: usage limit', offer.leaseId), false, 'a stale lease cannot fail it');
  assert.equal(h.bridge.failBridgeProvider(id, 'chatgpt', 'quota: usage limit', again.leaseId), true);
  await assert.rejects(pending, /chatgpt fix request failed: quota: usage limit/);
  assert.deepEqual(h.bridge.bridgeJobState(id), {active: false, status: 'dlq'});
  assert.equal(h.bridge.promptForJob(id), null);
  assert.deepEqual(h.bridge.bridgeJobState('fix-forgotten-by-a-restart'), {active: false, status: 'cancelled'});
  assert.equal(h.snapshots.length, 0, 'no harbor job was patched');
});

test('completeBridgeFix resolves the full page text and never review-validates, salvages or stores it', async () => {
  let submitted = 0;
  const h = bridgeHarness([makeJob({id: 'A', bridgeClaimedAt: Date.now()})], {submitHarborChat: async () => { submitted += 1; return {ok: true}; }});
  const pending = h.bridge.requestBridgeFix(FIX);
  const offer = h.bridge.takeNextBridgeJob('chrome-1', ['A'], {fixes: true});
  const text = 'Prose first.\n{"summary":"s","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}';
  // The legs carry the page's full text as originalText; that (not raw) is the answer.
  assert.equal(h.bridge.bridgeFormatErrors(offer.jobId, text, undefined, offer.leaseId).length, 0);
  assert.deepEqual(h.bridge.completeBridgeFix(offer.jobId, 'ignored raw', [{provider: 'chatgpt', raw: 'canonical', originalText: text}], offer.leaseId), {ok: true});
  assert.equal(await pending, text);
  assert.equal(submitted, 0);assert.equal(h.snapshots.length, 0);
  assert.deepEqual(h.state.jobs[0].storedLegs, []);
  // A review completion still goes through review JSON as before.
  assert.equal((await h.bridge.completeBridgeJob('A', json, [{provider: 'chatgpt', raw: json}])).ok, true);
  assert.equal(h.state.jobs[0].storedLegs.length, 1);
});

test('fixAgent.parallelPrs from the harbor settings caps concurrent fix claims', async () => {
  const h = bridgeHarness([]);
  withParallel(h, 1);
  const first = h.bridge.requestBridgeFix({...FIX, pr: 1});
  const second = h.bridge.requestBridgeFix({...FIX, pr: 2});
  const a = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  h.bridge.refreshBridgeClaim(a.jobId, {chatgpt: true}, undefined, a.leaseId);
  assert.equal(h.bridge.takeNextBridgeJob('chrome-1', [a.jobId], {fixes: true}), null, 'the second PR waits queued');
  assert.equal(h.bridge.takeNextBridgeJob('chrome-2', [], {fixes: true}), null, 'the cap is global, not per profile');
  h.bridge.completeBridgeFix(a.jobId, 'A', undefined, a.leaseId);
  assert.equal(await first, 'A');
  const b = h.bridge.takeNextBridgeJob('chrome-1', [a.jobId], {fixes: true});
  assert.equal(b.pr, 2);
  h.bridge.completeBridgeFix(b.jobId, 'B', undefined, b.leaseId);
  assert.equal(await second, 'B');
});

test('a newer request for the PR supersedes the older one; its id then reports cancelled', async () => {
  const h = bridgeHarness([]);
  const older = h.bridge.requestBridgeFix(FIX);
  const offer = h.bridge.takeNextBridgeJob('chrome-1', [], {fixes: true});
  const newer = quiet(h.bridge.requestBridgeFix({...FIX, prompt: 'retry prompt'}));
  await assert.rejects(older, /superseded by a newer request for the same PR/);
  assert.deepEqual(h.bridge.bridgeJobState(offer.jobId), {active: false, status: 'cancelled'});
  assert.equal(h.bridge.completeBridgeFix(offer.jobId, 'late', undefined, offer.leaseId).code, 'lease_conflict');
  void newer;
});
