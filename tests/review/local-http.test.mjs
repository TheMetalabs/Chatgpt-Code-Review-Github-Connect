import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { flush } from './helpers.mjs';
async function transport() { return (await import('../../src/lib/local-chat-request.server.ts')).requestLocalChat; }
async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const payload = { model: 'local-model', temperature: 0, messages: [{ role: 'user', content: 'review' }] };
test('local generation tolerates a simulated day before headers and a day during the body', async t => {
  const requestLocalChat = await transport();
  let respond, body, incoming;
  const arrived = new Promise(resolve => { respond = resolve; });
  const base = await listen(t, (req, res) => { incoming = req; body = res; req.resume(); respond(); });
  let done = false;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = requestLocalChat(base, 'key', payload).then(raw => { done = true; return raw; });
  await arrived;
  t.mock.timers.tick(86_400_000); await flush();
  assert.equal(done, false);
  assert.equal(incoming.url, '/v1/chat/completions');
  assert.equal(incoming.headers.authorization, 'Bearer key');
  body.writeHead(200, { 'content-type': 'application/json' });
  body.write('{"choices":[{"message":{"content":');
  t.mock.timers.tick(86_400_000); await flush();
  assert.equal(done, false);
  body.end('"review JSON"}}]}');
  assert.equal(await pending, 'review JSON');
});
test('explicit abort cancels a pending generation without automatically retrying', async t => {
  const requestLocalChat = await transport();
  let count = 0, arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  const base = await listen(t, (req) => { count++; req.resume(); arrived(); });
  const controller = new AbortController();
  const pending = requestLocalChat(base, '', payload, controller.signal);
  const rejected = assert.rejects(pending, e => e.name === 'AbortError');
  await ready; controller.abort(); await rejected; await flush();
  assert.equal(count, 1);
});
test('HTTP error, invalid JSON and broken response are explicit failures, not retries', async t => {
  const requestLocalChat = await transport();
  for (const mode of ['http', 'json', 'disconnect']) {
    let count = 0;
    const base = await listen(t, (req, res) => {
      count++; req.resume();
      if (mode === 'http') { res.writeHead(429); res.end('usage limit'); }
      else if (mode === 'json') res.end('not JSON');
      else { res.writeHead(200); res.write('{'); res.destroy(); }
    });
    await assert.rejects(requestLocalChat(base, '', payload));
    assert.equal(count, 1);
  }
});
test('request uses no implicit socket deadline and preserves endpoint path prefixes', async t => {
  const requestLocalChat = await transport();
  let captured;
  const original = http.request;
  http.request = (...args) => { captured = original(...args); return captured; };
  t.after(() => { http.request = original; });
  const base = await listen(t, (req, res) => {
    req.resume();
    assert.equal(req.url, '/v1/custom/chat/completions');
    assert.ok(!captured.socket.timeout);
    res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
  assert.equal(await requestLocalChat(base + '/custom/', '', payload), 'ok');
});
