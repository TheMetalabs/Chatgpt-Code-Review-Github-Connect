import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { source } from './helpers.mjs';
function route() {
  const failures = [];
  const c = vm.createContext({ Response, URL,
    createFileRoute: () => config => config,
    bridgeTokenOk: token => token === 'valid-token', bridgeHeartbeat() {},
    failBridgeProvider: (...args) => { failures.push(args); return true; },
  });
  const s = source('src/routes/api/bridge.ts').replace(/^import[\s\S]*?;\n/gm, '').replace('export const Route', 'globalThis.Route');
  vm.runInContext(stripTypeScriptTypes(s), c);
  return { failures, post: (body, token) => c.Route.server.handlers.POST({ request: new Request('http://bridge/api/bridge', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ashlar-bridge-token': token }, body: JSON.stringify(body),
  }) }) };
}
for (const [token, provider, expected] of [['bad-token', 'chatgpt', 401], ['valid-token', 'local', 400], ['valid-token', 'chatgpt', 200]]) {
  test(`failure endpoint: token/provider validation returns ${expected}`, async () => {
    const r = route();
    const response = await r.post({ action: 'failure', jobId: 'A', provider, error: 'quota' }, token);
    assert.equal(response.status, expected);
    assert.equal(r.failures.length, expected === 200 ? 1 : 0);
  });
}

// The complete branch must decide fix vs review BEFORE any review validation runs.
function routeWith(mocks) {
  const calls = [];
  const spy = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  const c = vm.createContext({ Response, URL,
    createFileRoute: () => config => config,
    bridgeTokenOk: token => token === 'valid-token', bridgeHeartbeat() {}, getBridgePublic: () => ({}), bridgePromptText: text => text,
    isBridgeFixId: id => typeof id === 'string' && id.startsWith('fix-'),
    completeBridgeFix: spy('completeBridgeFix', mocks.completeBridgeFix ?? { ok: true }),
    bridgeFormatErrors: spy('bridgeFormatErrors', mocks.bridgeFormatErrors ?? []),
    completeBridgeJob: spy('completeBridgeJob', mocks.completeBridgeJob ?? { ok: true }),
    takeNextBridgeJob: spy('takeNextBridgeJob', null),
  });
  const s = source('src/routes/api/bridge.ts').replace(/^import[\s\S]*?;\n/gm, '').replace('export const Route', 'globalThis.Route');
  vm.runInContext(stripTypeScriptTypes(s), c);
  const post = body => c.Route.server.handlers.POST({ request: new Request('http://bridge/api/bridge', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ashlar-bridge-token': 'valid-token' }, body: JSON.stringify(body),
  }) });
  return { calls, post, names: () => calls.map(call => call[0]) };
}
const completeBody = (jobId, text) => ({ action: 'complete', repairProtocol: 1, captureProtocol: 1, jobId, leaseId: 'L', raw: text,
  results: [{ provider: 'chatgpt', raw: text, originalText: text }] });

test('complete: a fix answer bypasses review validation and resolves as plain text', async () => {
  const r = routeWith({});
  const response = await r.post(completeBody('fix-A', 'Plain prose, not review JSON {"summary":"s","files":[]}'));
  assert.equal(response.status, 200);
  assert.deepEqual(r.names(), ['completeBridgeFix']);
  const [, jobId, raw, legs, leaseId] = r.calls[0];
  assert.equal(jobId, 'fix-A');assert.equal(leaseId, 'L');assert.match(raw, /^Plain prose/);
  assert.equal(legs[0].originalText, raw);
});

for (const [code, status] of [['lease_conflict', 409], ['invalid', 400]]) {
  test(`complete: a rejected fix answer (${code}) maps to ${status} without touching review paths`, async () => {
    const r = routeWith({ completeBridgeFix: { ok: false, code, error: 'no' } });
    const response = await r.post(completeBody('fix-A', 'text'));
    assert.equal(response.status, status);
    assert.deepEqual(r.names(), ['completeBridgeFix']);
  });
}

test('complete: a review answer still gets the 422 format gate, then review completion', async () => {
  const gated = routeWith({ bridgeFormatErrors: ['findings[0].severity: required'] });
  const refused = await gated.post(completeBody('job-A', '{"findings":[{}]}'));
  assert.equal(refused.status, 422);assert.equal((await refused.json()).code, 'json_repair_required');
  assert.deepEqual(gated.names(), ['bridgeFormatErrors']);
  const r = routeWith({});
  assert.equal((await r.post(completeBody('job-A', '{"findings":[]}'))).status, 200);
  assert.deepEqual(r.names(), ['bridgeFormatErrors', 'completeBridgeJob']);
});

test('take: only a worker that sends fixProtocol:1 opts into fix items', async () => {
  const r = routeWith({});
  await r.post({ action: 'take', clientId: 'c', fixProtocol: 1, excludeJobIds: ['x', 7] });
  await r.post({ action: 'take', clientId: 'c' });
  assert.deepEqual(r.calls.map(call => JSON.stringify(call.slice(1))), [
    JSON.stringify(['c', ['x'], { fixes: true }]),
    JSON.stringify(['c', [], { fixes: false }]),
  ]);
});
