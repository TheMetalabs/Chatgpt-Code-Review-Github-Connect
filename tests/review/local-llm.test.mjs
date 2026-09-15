import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { extractChatJson } from '../../src/lib/extract-chat-json.ts';
import { source, raw } from './helpers.mjs';
const settings = { localLlmBaseUrl: 'http://local/v1/', localLlmApiKey: ' secret ', localLlmModel: ' model ' };
function local(responses) {
  const calls = [], clients = [];
  const context = vm.createContext({ console, extractChatJson,
    requestLocalChat: async (...args) => { calls.push(args); const next = responses.shift(); if (next instanceof Error) throw next; return next; },
    OpenAI: class { constructor(options) { clients.push(options); this.models = { list: async () => [] }; this.chat = { completions: { create: async () => { throw new Error('generation used the SDK'); } } }; } },
  });
  const code = source('src/lib/local-llm.server.ts').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(stripTypeScriptTypes(code), context);
  return { context, calls, clients };
}
test('generation bypasses SDK defaults and extracts JSON without a needless retry', async () => {
  const c = local([raw]);
  assert.equal((await c.context.runLocalLlm('review', settings)).raw, raw);
  assert.equal(c.clients.length, 0); assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0][0], 'http://local/v1'); assert.equal(c.calls[0][1], 'secret');
});
test('only completed non-JSON content gets one semantic retry', async () => {
  const c = local(['prose', raw]);
  assert.equal((await c.context.runLocalLlm('review', settings)).raw, raw);
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[1][2].messages[2].content, 'prose');
});
test('network errors do not replay model requests; health checks retain a finite timeout', async () => {
  const c = local([new Error('connection closed')]);
  assert.equal((await c.context.runLocalLlm('review', settings)).ok, false);
  assert.equal(c.calls.length, 1);
  await c.context.pingLocalLlm(settings);
  assert.equal(c.clients[0].timeout, 5000);
});
