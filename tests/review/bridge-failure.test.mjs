import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { source } from './helpers.mjs';
function bridge(job) {
  const context = vm.createContext({ console,
    getHarbor: () => ({ jobs: [job] }),
    patchHarborJob: (_id, fn) => Object.assign(job, fn(job)),
    loadToken: () => 'test', llmWorkAllowed: () => true,
    isChatProvider: p => p === 'chatgpt' || p === 'grok',
  });
  const code = source('src/lib/bridge.server.ts');
  const start = code.indexOf('export function failBridgeProvider');
  assert.ok(start >= 0, 'missing per-provider terminal error endpoint');
  const end = code.indexOf('\nexport ', start + 1);
  vm.runInContext(stripTypeScriptTypes(code.slice(start, end < 0 ? undefined : end).replace(/export /g, '')), context);
  return context;
}
test('failure marks only its provider and remains idempotent', () => {
  const job = { id: 'A', status: 'awaiting_chat', generating: { chatgpt: true, grok: true, local: true }, assumptions: [] };
  const b = bridge(job);
  b.failBridgeProvider('A', 'chatgpt', 'quota: usage limit');
  b.failBridgeProvider('A', 'chatgpt', 'quota: usage limit');
  assert.equal(job.generating.chatgpt, false);
  assert.equal(job.generating.grok, true); assert.equal(job.generating.local, true);
  assert.equal(job.assumptions.filter(s => s.startsWith('Skipped chatgpt')).length, 1);
});
test('late failures never mutate completed or cancelled jobs', () => {
  for (const status of ['posted', 'cancelled', 'validator']) {
    const job = { id: 'A', status, generating: { chatgpt: false }, assumptions: ['kept'] };
    const b = bridge(job), before = JSON.stringify(job);
    b.failBridgeProvider('A', 'chatgpt', 'quota');
    assert.equal(JSON.stringify(job), before);
  }
});
test('a success is stored atomically with generating=false before async validation', async () => {
  const job = { id: 'A', status: 'awaiting_chat', generating: { chatgpt: true, grok: true }, storedLegs: [] };
  const raw = '{"findings":[]}';
  const c = vm.createContext({
    meta: {}, getHarbor: () => ({ jobs: [job] }), releaseBridgeJob() {},
    patchHarborJob: (_id, fn) => Object.assign(job, fn(job)),
    submitHarborChat: async () => {
      assert.equal(job.generating.chatgpt, false);
      assert.equal(job.generating.grok, true);
      assert.equal(job.storedLegs.find(l => l.provider === 'chatgpt')?.raw, raw);
      return { ok: true };
    },
  });
  const s = source('src/lib/bridge.server.ts');
  vm.runInContext(stripTypeScriptTypes(s.slice(s.indexOf('export async function completeBridgeJob')).replace(/export /g, '')), c);
  await c.completeBridgeJob('A', raw, [{ provider: 'chatgpt', raw }]);
});
