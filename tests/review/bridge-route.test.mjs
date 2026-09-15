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
    failBridgeProvider: (...args) => failures.push(args),
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
