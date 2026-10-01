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
test('HTTP 429 preserves Retry-After seconds for the model router', async t => {
  const requestLocalChat = await transport();
  const base = await listen(t, (req, res) => { req.resume(); res.writeHead(429, { 'retry-after': '37' }); res.end('usage limit'); });
  await assert.rejects(requestLocalChat(base, '', payload), e => e.status === 429 && e.retryAfterMs === 37_000);
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

// --- streaming transport ------------------------------------------------------------------------
async function transportJson() { return (await import('../../src/lib/local-chat-request.server.ts')).requestLocalJson; }
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  for (const e of events) res.write(typeof e === 'string' ? `${e}\n\n` : `data: ${JSON.stringify(e)}\n\n`);
  res.end();
}
const chunk = (delta, extra = {}) => ({ id: 'c1', object: 'chat.completion.chunk', created: 7, model: 'local-model', choices: [{ index: 0, delta, ...extra }] });
const keepalive = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'keepalive', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };

test('streaming chat: server heartbeats are queued activity, tokens are output, and the reply matches the non-stream shape', async t => {
  const requestLocalChat = await transport();
  let sent;
  const base = await listen(t, (req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      sent = JSON.parse(body);
      sse(res, [
        keepalive, keepalive,
        chunk({ role: 'assistant' }),
        chunk({ reasoning_content: 'thinking…' }),
        chunk({ content: '\n\n{"ok' }), chunk({ content: '":true}' }),
        chunk({}, { finish_reason: 'stop' }),
        { id: 'c1', object: 'chat.completion.chunk', created: 7, model: 'local-model', choices: [], usage: { prompt_tokens: 54, completion_tokens: 9 } },
        'data: [DONE]',
      ]);
    });
  });
  const seen = [];
  const raw = await requestLocalChat(base, 'key', payload, undefined, { onActivity: a => seen.push(a.kind) });
  assert.equal(raw, '\n\n{"ok":true}', 'reasoning is not part of the content');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  // Headers + two heartbeats + role-only chunk = alive but nothing for us yet; then output.
  assert.equal(seen[0], 'sent', 'HTTP dispatch is reported before any server bytes');
  assert.deepEqual(seen.slice(1, 5), ['keepalive', 'keepalive', 'keepalive', 'keepalive']);
  assert.equal(seen[5], 'output');
  assert.ok(seen.slice(5, 8).every(k => k === 'output'));
});

test('streaming chat: tool_call deltas are reassembled by index and usage survives', async t => {
  const requestLocalJson = await transportJson();
  const base = await listen(t, (req, res) => {
    req.resume(); req.on('end', () => sse(res, [
      keepalive,
      chunk({ role: 'assistant' }),
      chunk({ content: '\n\n' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path": "src/' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'a.ts"}' } }] }),
      chunk({}, { finish_reason: 'tool_calls' }),
      { id: 'c1', object: 'chat.completion.chunk', created: 7, model: 'local-model', choices: [], usage: { prompt_tokens: 321 } },
      'data: [DONE]',
    ]));
  });
  const res = await requestLocalJson(base, 'key', 'chat/completions', payload);
  const choice = res.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, '\n\n');
  assert.deepEqual(choice.message.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path": "src/a.ts"}' } }]);
  assert.equal(res.usage.prompt_tokens, 321);
  assert.equal(res.model, 'local-model', 'the keepalive pseudo-model never overwrites the real one');
});

test('streaming chat: a truncated reply and a stream cut before completion are explicit failures', async t => {
  const requestLocalChat = await transport();
  const truncated = await listen(t, (req, res) => { req.resume(); req.on('end', () => sse(res, [chunk({ content: 'partial' }), chunk({}, { finish_reason: 'length' }), 'data: [DONE]'])); });
  await assert.rejects(requestLocalChat(truncated, '', payload), /ended with length/);
  const cut = await listen(t, (req, res) => { req.resume(); req.on('end', () => sse(res, [chunk({ content: 'partial' })])); });
  await assert.rejects(requestLocalChat(cut, '', payload), /ended before completion/);
});

test('streaming chat: [DONE] with no finish_reason is incomplete, not a resolved partial reply', async t => {
  const requestLocalChat = await transport();
  // A truncating proxy appends [DONE] but no chunk ever carried finish_reason; resolving here would
  // hand a partial reply to the caller as if it were complete.
  const base = await listen(t, (req, res) => { req.resume(); req.on('end', () => sse(res, [chunk({ content: 'partial answer' }), 'data: [DONE]'])); });
  await assert.rejects(requestLocalChat(base, '', payload), /ended before completion/);
});

test('buffered chat (stream off, or server ignores stream) reports output only after the completed body', async t => {
  const requestLocalChat = await transport();
  const reply = '{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}';
  // Non-stream request: headers are keepalive; `output` is the completed body so the queued-without-
  // output watchdog is not cleared before any tokens exist.
  const nonStream = await listen(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply); });
  const seenOff = [];
  assert.equal(await requestLocalChat(nonStream, '', payload, undefined, { stream: false, onActivity: a => seenOff.push(a.kind) }), 'ok');
  assert.equal(seenOff[0], 'sent');
  assert.ok(seenOff.includes('keepalive'), 'headers are keepalive, not output');
  assert.equal(seenOff.at(-1), 'output', 'output is reported after the completed body');
  // Streaming requested but the server answered plain JSON: same buffered path, same signal.
  const ignoresStream = await listen(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply); });
  const seenOn = [];
  assert.equal(await requestLocalChat(ignoresStream, '', payload, undefined, { onActivity: a => seenOn.push(a.kind) }), 'ok');
  assert.ok(seenOn.includes('keepalive'));
  assert.equal(seenOn.at(-1), 'output', 'a JSON reply to a stream request reports output after the body');
});

test('buffered chat: response headers without a body are keepalive, not output', async t => {
  const requestLocalChat = await transport();
  let body, arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  const base = await listen(t, (req, res) => { body = res; req.resume(); arrived(); });
  const seen = [];
  const pending = requestLocalChat(base, '', payload, undefined, { stream: false, onActivity: a => seen.push(a.kind) });
  await ready;
  body.writeHead(200, { 'content-type': 'application/json' });
  body.flushHeaders();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const tick = () => {
      if (seen.includes('keepalive')) resolve();
      else if (Date.now() > deadline) reject(new Error('headers never reported keepalive'));
      else setTimeout(tick, 10);
    };
    tick();
  });
  assert.deepEqual(seen, ['sent', 'keepalive'], 'headers must not clear the queued-without-output watchdog');
  body.end('{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}');
  assert.equal(await pending, 'ok');
  assert.equal(seen.at(-1), 'output');
});

test('buffered chat: a throwing onActivity on output is not reported as invalid JSON', async t => {
  const requestLocalChat = await transport();
  const reply = '{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}';
  const base = await listen(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(reply); });
  const boom = new Error('activity failed');
  await assert.rejects(
    requestLocalChat(base, '', payload, undefined, {
      stream: false,
      onActivity: a => { if (a.kind === 'output') throw boom; },
    }),
    e => e === boom && !/invalid JSON response/.test(String(e)),
  );
});

test('streaming chat: a server that ignores stream and answers plain JSON still works; ASHLAR_LOCAL_LLM_STREAM=false sends a non-stream request', async t => {
  const requestLocalChat = await transport();
  const plain = await listen(t, (req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"finish_reason":"stop","message":{"content":"plain"}}]}'); });
  assert.equal(await requestLocalChat(plain, '', payload), 'plain');
  let sent;
  const nonStream = await listen(t, (req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { sent = JSON.parse(b); res.end('{"choices":[{"message":{"content":"ok"}}]}'); }); });
  assert.equal(await requestLocalChat(nonStream, '', payload, undefined, { stream: false }), 'ok');
  assert.equal(sent.stream, false);
  assert.equal(sent.stream_options, undefined);
});

test('optional HTTP slot lock: a second chat request waits until the first settles; /models does not take the slot', async t => {
  const prev = process.env.ASHLAR_LOCAL_SLOT_LOCK;
  process.env.ASHLAR_LOCAL_SLOT_LOCK = 'true';
  t.after(() => {
    if (prev === undefined) delete process.env.ASHLAR_LOCAL_SLOT_LOCK;
    else process.env.ASHLAR_LOCAL_SLOT_LOCK = prev;
  });
  const requestLocalChat = await transport();
  const requestLocalJson = await transportJson();
  const arrived = [];
  const base = await listen(t, (req, res) => {
    arrived.push({ url: req.url, res });
    req.resume();
  });
  const a = new AbortController();
  const first = requestLocalChat(base, '', payload, a.signal);
  const rejected = assert.rejects(first, e => e.name === 'AbortError' || /abort/i.test(String(e)));
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const tick = () => { if (arrived.length >= 1) resolve(); else if (Date.now() > deadline) reject(new Error('first chat never arrived')); else setTimeout(tick, 10); };
    tick();
  });
  const second = requestLocalChat(base, '', payload);
  await flush();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(arrived.filter(x => x.url === '/v1/chat/completions').length, 1, 'the second chat did not pile onto the occupied slot');
  // A non-chat path never takes the slot, even while a chat request holds it.
  const models = requestLocalJson(base, '', 'models');
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const tick = () => { if (arrived.some(x => x.url === '/v1/models')) resolve(); else if (Date.now() > deadline) reject(new Error('/models was blocked by the chat slot')); else setTimeout(tick, 10); };
    tick();
  });
  arrived.find(x => x.url === '/v1/models').res.end('{"data":[]}');
  await models;
  a.abort();
  await rejected;
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const tick = () => { if (arrived.filter(x => x.url === '/v1/chat/completions').length >= 2) resolve(); else if (Date.now() > deadline) reject(new Error('second chat did not send after the first settled')); else setTimeout(tick, 10); };
    tick();
  });
  const chat = arrived.filter(x => x.url === '/v1/chat/completions');
  chat[1].res.end('{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}');
  assert.equal(await second, 'ok');
});
