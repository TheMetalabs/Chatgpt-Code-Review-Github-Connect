import {bridgePromptText} from "../../src/lib/chat-prompt.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { extractChatJson } from '../../src/lib/extract-chat-json.ts';
import { source, raw } from './helpers.mjs';
const settings = { localLlmBaseUrl: 'http://local/v1/', localLlmApiKey: ' secret ', localLlmModel: ' model ' };
function local(responses) {
  const calls = [], clients = [], probes = [];
  const context = vm.createContext({ console, extractChatJson, bridgePromptText,
    AbortSignal: {timeout: ms => ({timeout: ms})},
    requestLocalJson: async (...args) => {probes.push(args);return {};},
    requestLocalChat: async (...args) => { calls.push(args); const next = responses.shift(); if (next instanceof Error) throw next; return next; },
    OpenAI: class { constructor(options) { clients.push(options); this.models = { list: async () => [] }; this.chat = { completions: { create: async () => { throw new Error('generation used the SDK'); } } }; } },
  });
  const code = source('src/lib/local-llm.server.ts').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(stripTypeScriptTypes(code), context);
  return { context, calls, clients, probes };
}
test('generation bypasses SDK defaults and extracts JSON without a needless retry', async () => {
  const c = local([raw]);
  assert.equal((await c.context.runLocalLlm('review', settings)).raw, raw);
  assert.equal(c.clients.length, 0); assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0][0], 'http://local/v1'); assert.equal(c.calls[0][1], 'secret');
});
test('generation sends a completion budget and non-greedy sampling', async () => {
  // Regression: an unset max_tokens lets the server default the budget to ~8K, which a reasoning
  // model spends entirely on thinking (finish_reason=length) before it emits any JSON. Greedy
  // decoding (temperature 0) sends thinking models into verbatim repetition loops.
  const c = local([raw]);
  await c.context.runLocalLlm('review', settings);
  const body = c.calls[0][2];
  assert.ok(body.max_tokens >= 8192, `max_tokens must clear thinking+JSON, got ${body.max_tokens}`);
  assert.ok(body.temperature > 0, 'temperature must be non-greedy to avoid repetition loops');
});
test('only completed non-JSON content gets one semantic retry', async () => {
  const c = local(['prose', raw]);
  assert.equal((await c.context.runLocalLlm('review', settings)).raw, raw);
  assert.equal(c.calls.length, 2);
  // The retry does NOT echo the prior reply back (that could overflow the context window); it is the
  // original prompt plus a JSON-only nudge, never larger than the first call.
  const retryMsgs = c.calls[1][2].messages;
  assert.equal(retryMsgs.every((m) => m.content !== 'prose'), true, 'prior non-JSON reply is not echoed into the retry');
  assert.match(retryMsgs[retryMsgs.length - 1].content, /ONLY the JSON object/);
});
test('network errors do not replay model requests; health checks also have no automatic deadline', async () => {
  const c = local([new Error('connection closed')]);
  assert.equal((await c.context.runLocalLlm('review', settings)).ok, false);
  assert.equal(c.calls.length, 1);
  await c.context.pingLocalLlm(settings);
  assert.equal(c.probes[0][2], "models");
  assert.equal(c.probes[0][4], undefined);
});

test('Local API receives readable source rather than the browser V2 transport envelope',async()=>{
 const c=local([raw]);
 const prompt='Review\n\n<<<ASHLAR_ATTACHMENTS_V2>>>\n'+JSON.stringify([{name:'source.ts',body:'const x = "literal";\nnext();'}])+'\n<<<END_ASHLAR_ATTACHMENTS_V2>>>';
 assert.equal((await c.context.runLocalLlm(prompt,settings)).ok,true);
 assert.equal(c.calls.length,1);
 const contents=c.calls[0][2].messages.map(m=>m.content).join('\n');
 assert.match(contents,/const x = "literal";\nnext\(\);/);
 assert.doesNotMatch(contents,/ASHLAR_ATTACHMENTS_V2/);
});
