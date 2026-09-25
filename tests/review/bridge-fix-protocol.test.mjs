// Every fix operation requires the worker's fixProtocol:1 opt-in, at ONE entry (the /api/bridge
// route's fixOperationRefused gate), over the real bridge server and fix registry. One row per
// bridge operation, each run without and with the opt-in; review operations are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {bridgeHarness, job as makeJob, loadTs, source} from './load-source.mjs';

const FIX = {owner: 'fixture', repo: 'fixture', pr: 9, provider: 'chatgpt', prompt: 'FIX PROMPT'};
const progress = runId => ({chatgpt: {runId, events: [{source: 'page', sequence: 1, stage: 'generating', at: 1}]}});

/** The production route over a real bridge server: `post(body, {fixProtocol})` / `get(query)`. */
function server(jobs = [], {bridgePromptText = text => text} = {}) {
  const h = bridgeHarness(jobs);
  const c = vm.createContext({Response, URL, createFileRoute: () => config => config, bridgePromptText,
    ...h.bridge, bridgeTokenOk: token => token === 'valid-token', bridgeHeartbeat() {}, getBridgePublic: () => ({})});
  vm.runInContext(stripTypeScriptTypes(source('src/routes/api/bridge.ts').replace(/^import[\s\S]*?;\n/gm, '').replace('export const Route', 'globalThis.Route')), c);
  const call = async (method, url, body) => {
    const response = await c.Route.server.handlers[method]({request: new Request(url, {method, headers: {'content-type': 'application/json', 'x-ashlar-bridge-token': 'valid-token'}, ...(body ? {body: JSON.stringify(body)} : {})})});
    return {status: response.status, body: await response.json()};
  };
  return {h, post: body => call('POST', 'http://bridge/api/bridge', body), get: query => call('GET', `http://bridge/api/bridge?${query}`)};
}
/** A fix item an opted-in worker took and started (run-A pinned by its progress). */
async function takenFix(jobs) {
  const s = server(jobs);
  s.pending = s.h.bridge.requestBridgeFix(FIX);s.pending.catch(() => {});
  const offer = (await s.post({action: 'take', clientId: 'chrome-1', fixProtocol: 1})).body.job;
  assert.equal(offer?.kind, 'fix');
  assert.equal((await s.post({action: 'progress', jobId: offer.jobId, leaseId: offer.leaseId, progress: progress('run-A'), fixProtocol: 1})).status, 200);
  s.offer = offer;
  return s;
}
const refused = out => out.status === 409 && out.body.code === 'fix_protocol_required';

/** One row per operation: `run(s, fixProtocol)` performs it for the taken fix; `opted(out)` is the
 * opted-in outcome. */
const ROWS = [
  {op: 'claim', run: (s, fixProtocol) => s.post({action: 'claim', jobId: s.offer.jobId, clientId: 'chrome-1', fixProtocol}),
    opted: (out, s) => out.status === 200 && out.body.leaseId === s.offer.leaseId},
  {op: 'ping', run: (s, fixProtocol) => s.post({action: 'ping', jobId: s.offer.jobId, leaseId: s.offer.leaseId, generating: {chatgpt: true}, fixProtocol}),
    opted: out => out.status === 200 && out.body.accepted === true && out.body.status === 'awaiting_chat'},
  {op: 'prompt (GET)', run: (s, fixProtocol) => s.get(`jobId=${s.offer.jobId}&attachmentProtocol=2${fixProtocol ? '&fixProtocol=1' : ''}`),
    opted: out => out.status === 200 && out.body.prompt === FIX.prompt},
  {op: 'progress', run: (s, fixProtocol) => s.post({action: 'progress', jobId: s.offer.jobId, leaseId: s.offer.leaseId, progress: progress('run-A'), fixProtocol}),
    opted: out => out.status === 200 && out.body.ok === true},
  {op: 'release', run: (s, fixProtocol) => s.post({action: 'release', jobId: s.offer.jobId, leaseId: s.offer.leaseId, fixProtocol}),
    opted: out => out.status === 200},
  {op: 'failure', run: (s, fixProtocol) => s.post({action: 'failure', jobId: s.offer.jobId, leaseId: s.offer.leaseId, provider: 'chatgpt', error: 'error: boom', fixProtocol}),
    opted: out => out.status === 200 && out.body.ok === true},
  {op: 'complete', run: (s, fixProtocol) => s.post({action: 'complete', jobId: s.offer.jobId, leaseId: s.offer.leaseId, raw: 'ANSWER', results: [{provider: 'chatgpt', raw: 'ANSWER', originalText: 'ANSWER'}], fixProtocol}),
    opted: out => out.status === 200 && out.body.ok === true},
  {op: 'observe (review lane)', run: (s, fixProtocol) => s.post({action: 'observe', jobId: s.offer.jobId, leaseId: s.offer.leaseId, provider: 'chatgpt', runId: 'run-A', text: 'x', fixProtocol}),
    opted: out => !refused(out)},
  {op: 'capture (review lane)', run: (s, fixProtocol) => s.post({action: 'capture', jobId: s.offer.jobId, leaseId: s.offer.leaseId, provider: 'chatgpt', runId: 'run-A', fixProtocol}),
    opted: out => !refused(out)},
  {op: 'repair (review lane)', run: (s, fixProtocol) => s.post({action: 'repair', jobId: s.offer.jobId, leaseId: s.offer.leaseId, provider: 'chatgpt', runId: 'run-A', fixProtocol}),
    opted: out => !refused(out)},
];

for (const row of ROWS) {
  test(`fix protocol gate: ${row.op} is refused without fixProtocol:1 and never touches the item; served with it`, async () => {
    const s = await takenFix([]);
    const out = await row.run(s, undefined);
    assert.ok(refused(out), `${row.op} without the opt-in: ${JSON.stringify(out)}`);
    // the item is exactly as the opted-in worker left it: still claimed under its lease, unsettled
    assert.equal(s.h.bridge.bridgeJobState(s.offer.jobId).status, 'awaiting_chat');
    assert.equal(s.h.bridge.refreshBridgeClaim(s.offer.jobId, {chatgpt: true}, undefined, s.offer.leaseId), true, 'its lease is still live');
    const served = await row.run(s, 1);
    assert.ok(row.opted(served, s), `${row.op} with the opt-in: ${JSON.stringify(served)}`);
  });
}

test('fix protocol gate: take offers a fix only with fixProtocol:1', async () => {
  const s = server([]);
  s.h.bridge.requestBridgeFix(FIX).catch(() => {});
  assert.equal((await s.post({action: 'take', clientId: 'chrome-1'})).body.job, null);
  assert.equal((await s.post({action: 'take', clientId: 'chrome-1', fixProtocol: 1})).body.job?.kind, 'fix');
});

test('fix protocol gate: recover skips fix bindings without fixProtocol:1 (a review binding still recovers); resumes with it', async () => {
  // a review this profile already runs (live claim): not offered by take, recoverable by its binding
  const review = makeJob({id: 'job-R', createdAt: Date.now() - 60_000, bridgeClientId: 'chrome-1', bridgeClaimedAt: Date.now(), bridgeLeaseId: 'lease-R', attemptedProviders: ['chatgpt'],
    providerProgress: {chatgpt: {runId: 'run-R', stage: 'generating', observedAt: 1, receivedAt: 1}}});
  const s = await takenFix([review]);
  const fixBinding = {jobId: s.offer.jobId, provider: 'chatgpt', runId: 'run-A'};
  const reviewBinding = {jobId: 'job-R', provider: 'chatgpt', runId: 'run-R'};
  assert.equal((await s.post({action: 'recover', clientId: 'chrome-1', bindings: [fixBinding]})).body.job, null, 'an old worker never receives a fix via recovery');
  const mixed = (await s.post({action: 'recover', clientId: 'chrome-1', bindings: [fixBinding, reviewBinding]})).body.job;
  assert.equal(mixed?.jobId, 'job-R', 'review recovery is unchanged');assert.equal('kind' in mixed, false);
  const resumed = (await s.post({action: 'recover', clientId: 'chrome-1', bindings: [fixBinding], fixProtocol: 1})).body.job;
  assert.equal(resumed?.jobId, s.offer.jobId);assert.equal(resumed.kind, 'fix');
  assert.deepEqual(resumed.bindings, [fixBinding]);
});

test('fix protocol gate: review operations are unchanged without fixProtocol:1', async () => {
  const s = server([makeJob({id: 'job-A', createdAt: Date.now()})]);
  const offer = (await s.post({action: 'take', clientId: 'chrome-1'})).body.job;
  assert.equal(offer?.jobId, 'job-A');
  assert.equal((await s.post({action: 'claim', jobId: 'job-A', clientId: 'chrome-1'})).body.leaseId, offer.leaseId);
  const ping = await s.post({action: 'ping', jobId: 'job-A', leaseId: offer.leaseId, generating: {chatgpt: true}});
  assert.equal(ping.status, 200);assert.equal(ping.body.accepted, true);
  assert.equal((await s.get('jobId=job-A&attachmentProtocol=2')).body.prompt, 'Review fixture');
  assert.equal((await s.post({action: 'progress', jobId: 'job-A', leaseId: offer.leaseId, progress: progress('run-R')})).status, 200);
  assert.equal((await s.post({action: 'release', jobId: 'job-A', leaseId: offer.leaseId})).status, 200);
});

// Ashlar 4099509094: only take / recover hand out a fix delivery (their offer carries the deliveryId
// the worker journals before it opens a tab). A direct claim of a queued item is refused (409
// take_required) and mints nothing; the next take hands out the new delivery.
test('route: a direct claim of a released, unpinned fix is refused (409 take_required); the next take hands out D2', async () => {
  const s = server();
  s.pending = s.h.bridge.requestBridgeFix(FIX);s.pending.catch(() => {});
  const d1 = (await s.post({action: 'take', clientId: 'chrome-1', fixProtocol: 1})).body.job;
  assert.equal(d1?.offerKind, 'fresh');
  assert.equal((await s.post({action: 'release', jobId: d1.jobId, leaseId: d1.leaseId, fixProtocol: 1})).status, 200);
  const claim = await s.post({action: 'claim', jobId: d1.jobId, clientId: 'chrome-1', fixProtocol: 1});
  assert.equal(claim.status, 409);
  assert.equal(claim.body.code, 'take_required');assert.equal(claim.body.leaseId, undefined, 'no lease, no delivery');
  const d2 = (await s.post({action: 'take', clientId: 'chrome-1', fixProtocol: 1})).body.job;
  assert.equal(d2?.jobId, d1.jobId);assert.equal(d2.offerKind, 'fresh');
  assert.ok(d2.deliveryId && d2.deliveryId !== d1.deliveryId, 'the new delivery reaches the worker in the take offer');
  // a claim now only renews the lease that take handed out
  assert.deepEqual((await s.post({action: 'claim', jobId: d2.jobId, clientId: 'chrome-1', fixProtocol: 1})).body, {ok: true, leaseId: d2.leaseId});
});

// Ashlar 4099509090: a fix prompt is delivered verbatim, byte-exact, through take, recover and the
// prompt GET, in either attachment protocol: an inlined file holding a V2 sentinel line and a
// complete legacy <<<ATTACH:…>>> block is file content, never rejected or converted. A review prompt
// keeps its protocol conversion (attachment-boundaries.test.mjs).
test('route: a fix prompt with envelope-looking file content is served byte-exact (take, recover, GET; protocol 1 and 2)', async () => {
  const {bridgePromptText} = loadTs('src/lib/chat-prompt.ts');
  const prompt = '  Fix F1. src/a.ts:\n<<<ASHLAR_ATTACHMENTS_V2>>>\n<<<ATTACH:inlined.txt>>>\nconst a = 1;\n<<<END_ATTACH>>>\n\n';
  for (const attachmentProtocol of [1, 2]) {
    const s = server([], {bridgePromptText});
    s.h.bridge.requestBridgeFix({...FIX, prompt}).catch(() => {});
    const taken = await s.post({action: 'take', clientId: 'chrome-1', fixProtocol: 1, attachmentProtocol});
    assert.equal(taken.status, 200);assert.equal(taken.body.job?.prompt, prompt, `take, protocol ${attachmentProtocol}`);
    const offer = taken.body.job;
    const got = await s.get(`jobId=${encodeURIComponent(offer.jobId)}&fixProtocol=1${attachmentProtocol === 2 ? '&attachmentProtocol=2' : ''}`);
    assert.equal(got.status, 200);assert.equal(got.body.prompt, prompt, `GET, protocol ${attachmentProtocol}`);
    await s.post({action: 'progress', jobId: offer.jobId, leaseId: offer.leaseId, progress: progress('run-A'), fixProtocol: 1});
    const recovered = await s.post({action: 'recover', clientId: 'chrome-1', bindings: [{jobId: offer.jobId, provider: 'chatgpt', runId: 'run-A'}], fixProtocol: 1, attachmentProtocol});
    assert.equal(recovered.body.job?.prompt, prompt, `recover, protocol ${attachmentProtocol}`);
  }
  // control: a review prompt with a real V2 envelope is still converted for an old worker
  const review = bridgePromptText('Review\n\n<<<ASHLAR_ATTACHMENTS_V2>>>\n[{"name":"diff.patch","body":"x"}]\n<<<END_ASHLAR_ATTACHMENTS_V2>>>', 1);
  assert.match(review, /<<<ATTACH:diff\.patch>>>/);
});
