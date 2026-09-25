import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { source } from './helpers.mjs';
function route() {
  const failures = [], calls = [];
  const c = vm.createContext({ Response, URL,
    createFileRoute: () => config => config,
    bridgeTokenOk: token => token === 'valid-token', bridgeHeartbeat() {},
    noteBridgeRequest: body => { calls.push(['note', body.action, body.leaseId]); },
    failBridgeProvider: (...args) => { calls.push(['failure']); failures.push(args); return true; },
  });
  const s = source('src/routes/api/bridge.ts').replace(/^import[\s\S]*?;\n/gm, '').replace('export const Route', 'globalThis.Route');
  vm.runInContext(stripTypeScriptTypes(s), c);
  return { failures, calls, post: (body, token) => c.Route.server.handlers.POST({ request: new Request('http://bridge/api/bridge', {
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

test('owner liveness is recorded from every authenticated request before its action runs, never from an unauthenticated one', async () => {
  const r = route();
  assert.equal((await r.post({ action: 'failure', jobId: 'A', leaseId: 'L', provider: 'chatgpt', error: 'quota' }, 'valid-token')).status, 200);
  assert.deepEqual(r.calls, [['note', 'failure', 'L'], ['failure']], 'noted first, then the action');
  assert.equal((await r.post({ action: 'failure', jobId: 'A', leaseId: 'L', provider: 'chatgpt', error: 'quota' }, 'bad-token')).status, 401);
  assert.equal(r.calls.length, 2, 'a request without the bridge token speaks for no one');
});
