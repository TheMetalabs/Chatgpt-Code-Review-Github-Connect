import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TLSSocket } from 'node:tls';
import { loadTs } from './load-source.mjs';

// The real createPullReview -> gh -> HTTPS decoder; only DNS and the network stream are fakes.
// `replies` answers each POST in turn: [status, body].
function githubWith(replies) {
  const sent = [];
  const api = loadTs('src/lib/github.server.ts', {
    ...loadTs('src/lib/github-transport.ts', { TLSSocket }),
    ...loadTs('src/lib/review-diff.ts'),
    dnsLookup: async () => ({ address: '127.0.0.1', family: 4 }),
    https: { request(_options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      let body = '';
      request.write = (chunk) => { body += chunk; };
      request.end = () => queueMicrotask(() => {
        sent.push(JSON.parse(body));
        const [status, text] = replies[Math.min(sent.length - 1, replies.length - 1)];
        const response = new EventEmitter(); response.statusCode = status;
        callback(response);
        response.emit('data', Buffer.from(text));
        response.emit('end');
      });
      return request;
    } },
  });
  return { api, sent };
}

const review = (comments) => ({ owner: 'o', repo: 'r', pr: 1, headSha: 'a'.repeat(40), event: 'COMMENT', body: 'b', comments });
const inline = [{ file: 'src/a.ts', line: 3, side: 'RIGHT', body: 'x' }];
const idAndDrop = ({ id, inlineDropped }) => ({ id, inlineDropped });

test('createPullReview reports inlineDropped when GitHub refused an inline anchor', async () => {
  const { api, sent } = githubWith([
    [422, JSON.stringify({ message: 'Unprocessable Entity', errors: ['pull_request_review_thread.line must be part of the diff'] })],
    [200, JSON.stringify({ id: 9 })],
  ]);
  assert.deepEqual(idAndDrop(await api.createPullReview('t', review(inline))), { id: 9, inlineDropped: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].comments.length, 0, 'the fallback posts no inline comment at all');
});

test('createPullReview never re-sends after a 5xx, even when its text reads like an anchor error', async () => {
  const { api, sent } = githubWith([
    [502, JSON.stringify({ message: 'Bad Gateway: could not comment' })],
    [200, JSON.stringify({ id: 9 })],
  ]);
  await assert.rejects(api.createPullReview('t', review(inline)), (e) => e.name === 'GithubWriteError' && e.status === 502 && e.outcome === 'unknown');
  assert.equal(sent.length, 1, 'the review may have been created: no second POST');
});

test('createPullReview: inlineDropped is false when every inline comment was accepted (or there were none)', async () => {
  const ok = githubWith([[200, JSON.stringify({ id: 7 })]]);
  assert.deepEqual(idAndDrop(await ok.api.createPullReview('t', review(inline))), { id: 7, inlineDropped: false });
  const none = githubWith([[200, JSON.stringify({ id: 8 })]]);
  assert.deepEqual(idAndDrop(await none.api.createPullReview('t', review([]))), { id: 8, inlineDropped: false });
});

test('listReviewThreadRoots keys each root by the line it was posted on (original_line) and drops replies', async () => {
  const api = loadTs('src/lib/github.server.ts', {
    ...loadTs('src/lib/github-transport.ts', { TLSSocket }),
    ...loadTs('src/lib/review-diff.ts'),
    dnsLookup: async () => ({ address: '127.0.0.1', family: 4 }),
    https: { request(_options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = 200;
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify([
          { id: 1, path: 'a.ts', line: 3, original_line: 3, body: 'A' },
          { id: 2, path: 'a.ts', line: null, original_line: 9, body: 'B' },
          { id: 5, path: 'a.ts', line: 10, original_line: 9, body: 'C' },
          { id: 3, path: 'a.ts', line: 3, body: 'reply', in_reply_to_id: 1 },
          { id: 4, path: 'a.ts', body: 'no line' },
        ])));
        response.emit('end');
      });
      return request;
    } },
  });
  const roots = await api.listReviewThreadRoots('t', 'o', 'r', 1, 55);
  assert.deepEqual([...roots].map((r) => ({ ...r })), [
    { id: 1, path: 'a.ts', line: 3, body: 'A' },
    { id: 2, path: 'a.ts', line: 9, body: 'B' },
    { id: 5, path: 'a.ts', line: 9, body: 'C' },
    { id: 4, path: 'a.ts', body: 'no line' },
  ]);
});

// A reply POST is retryable only when GitHub cannot have created it.
function replyApi(transport, dns = { dnsLookup: async () => ({ address: '127.0.0.1', family: 4 }) }) {
  return loadTs('src/lib/github.server.ts', {
    ...loadTs('src/lib/github-transport.ts', { TLSSocket }),
    ...loadTs('src/lib/review-diff.ts'),
    ...dns,
    https: { request(_options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.write = () => {};
      request.destroy = (e) => request.emit('error', e);
      request.end = () => queueMicrotask(() => transport(request, callback));
      return request;
    } },
  });
}
const replied = async (api) => api.replyToReviewComment('t', 'o', 'r', 1, 7, 'Fixed').then(() => 'ok', (e) => ({ retryable: e.retryable }));

test('replyToReviewComment: a request that never left is retryable; a 5xx or a lost response is not', async () => {
  // connect refused before any socket: nothing reached GitHub
  assert.deepEqual(await replied(replyApi((req) => req.emit('error', new Error('connect ECONNREFUSED')))), { retryable: true });
  // connected, then the response was lost: GitHub may have created the reply
  const lost = (req) => { const socket = new EventEmitter(); socket.connecting = false; req.emit('socket', socket); req.emit('error', new Error('GitHub API timeout')); };
  assert.deepEqual(await replied(replyApi(lost)), { retryable: false });
  const status = (code) => (_req, callback) => { const res = new EventEmitter(); res.statusCode = code; callback(res); res.emit('data', Buffer.from('{}')); res.emit('end'); };
  assert.deepEqual(await replied(replyApi(status(502))), { retryable: false });
  assert.deepEqual(await replied(replyApi(status(429))), { retryable: true });
  assert.equal(await replied(replyApi(status(201))), 'ok');
  // every resolver fails before a request exists: nothing reached GitHub
  const noDns = {
    dnsLookup: async () => { throw new Error('getaddrinfo EAI_AGAIN'); },
    Resolver: class { setServers() {} resolve4() { return Promise.reject(new Error('public DNS down')); } },
  };
  assert.deepEqual(await replied(replyApi((req) => req.emit('error', new Error('DoH unreachable')), noDns)), { retryable: true });
});

// The write contract (#79 step 1): a created row comes back as GitHub reported it; a failure throws
// GithubWriteError with the HTTP status (0 = no response) and whether GitHub may have applied it.
const respond = (code, body) => (_req, callback) => { const res = new EventEmitter(); res.statusCode = code; callback(res); res.emit('data', Buffer.from(JSON.stringify(body))); res.emit('end'); };
const truncated = (code) => (_req, callback) => { const res = new EventEmitter(); res.statusCode = code; callback(res); res.emit('data', Buffer.from('{"id":4')); res.emit('end'); };
const refused = (req) => req.emit('error', new Error('connect ECONNREFUSED'));
const lostAfterSend = (req) => { const socket = new EventEmitter(); socket.connecting = false; req.emit('socket', socket); req.emit('error', new Error('GitHub API timeout')); };
const writes = {
  createIssueComment: (api) => api.createIssueComment('t', { owner: 'o', repo: 'r', pr: 1, body: 'b' }),
  createPullReview: (api) => api.createPullReview('t', review([])),
};
// the message keeps its existing prefix, so logs and message matchers are unchanged
const failure = (write, transport) => write(replyApi(transport)).then(
  () => 'ok',
  (e) => ({ name: e.name, status: e.status, outcome: e.outcome, prefix: /^GitHub (issue comment|Reviews API) \d+: /.test(e.message) }),
);

test('createIssueComment returns the server row (id, user.login, created_at, body)', async () => {
  const row = { id: 41, user: { login: 'ashlar-bot[bot]' }, created_at: '2026-09-24T13:00:00Z', body: 'b', html_url: 'x' };
  const got = await writes.createIssueComment(replyApi(respond(201, row)));
  assert.deepEqual({ ...got }, { id: 41, userLogin: 'ashlar-bot[bot]', createdAt: '2026-09-24T13:00:00Z', body: 'b' });
});

test('createPullReview returns the server row (id, user.login, submitted_at, commit_id)', async () => {
  const row = { id: 42, user: { login: 'ashlar-bot[bot]' }, submitted_at: '2026-09-24T13:01:00Z', commit_id: 'c'.repeat(40), state: 'COMMENTED' };
  const got = await writes.createPullReview(replyApi(respond(200, row)));
  assert.deepEqual({ ...got }, { id: 42, inlineDropped: false, userLogin: 'ashlar-bot[bot]', submittedAt: '2026-09-24T13:01:00Z', commitId: 'c'.repeat(40) });
});

for (const [name, write] of Object.entries(writes)) {
  test(`${name}: a 4xx or a request that never left is rejected; a 5xx or a lost response is unknown`, async () => {
    const e = (status, outcome) => ({ name: 'GithubWriteError', status, outcome, prefix: true });
    assert.deepEqual(await failure(write, respond(422, { message: 'Unprocessable Entity' })), e(422, 'rejected'));
    assert.deepEqual(await failure(write, respond(403, { message: 'Resource not accessible by integration' })), e(403, 'rejected'));
    assert.deepEqual(await failure(write, respond(502, { message: 'Bad Gateway' })), e(502, 'unknown'));
    assert.deepEqual(await failure(write, refused), e(0, 'rejected'));
    assert.deepEqual(await failure(write, lostAfterSend), e(0, 'unknown'));
    // accepted, but the body is cut or not JSON: no usable response, and it may have landed
    assert.deepEqual(await failure(write, truncated(201)), e(0, 'unknown'));
    await assert.rejects(write(replyApi(truncated(201))), (err) => err.cause?.name === 'SyntaxError', 'the parse error is kept as the cause');
  });
}

// job.githubError is formatGithubError(err): a transport failure's text is already in the message,
// so the kept cause must not repeat it (the loop-OFF posting path shows this on /jobs and the dlq).
// One Error realm for both modules, as in production, so formatGithubError walks the cause chain.
function oneRealmApi(transport) {
  return loadTs('src/lib/github.server.ts', {
    Error,
    ...loadTs('src/lib/github-transport.ts', { TLSSocket, Error }),
    ...loadTs('src/lib/review-diff.ts'),
    dnsLookup: async () => ({ address: '127.0.0.1', family: 4 }),
    https: { request(_options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.write = () => {};
      request.destroy = (e) => request.emit('error', e);
      request.end = () => queueMicrotask(() => transport(request, callback));
      return request;
    } },
  });
}
const refusedWithCode = (req) => req.emit('error', Object.assign(new Error('connect ECONNREFUSED 140.82.112.6:443'), { code: 'ECONNREFUSED' }));

for (const [name, write] of Object.entries(writes)) {
  test(`${name}: a transport failure's text appears once in formatGithubError`, async () => {
    for (const [transport, text] of [[refusedWithCode, 'connect ECONNREFUSED 140.82.112.6:443 · ECONNREFUSED'], [lostAfterSend, 'GitHub API timeout']]) {
      const api = oneRealmApi(transport);
      const err = await write(api).then(() => assert.fail('the write must fail'), (e) => e);
      assert.equal(err.cause?.name, 'GithubTransportError', 'the transport error stays the cause');
      const shown = api.formatGithubError(err);
      assert.equal(shown.split(text).length - 1, 1, `the transport failure is reported once: ${shown}`);
      assert.equal(shown, err.message);
    }
    // a cause the message does not quote (the malformed body's parse error) is still shown
    const api = oneRealmApi(truncated(201));
    const err = await write(api).then(() => assert.fail('the write must fail'), (e) => e);
    const shown = api.formatGithubError(err);
    assert.ok(shown.startsWith(`${err.message} · `) && shown.includes(err.cause.message), shown);
  });
}

// A 2xx whose body is no usable created row: GitHub accepted the write, so it may have landed — an
// unknown outcome under the write's own message prefix, from one POST, and the text the loop-OFF
// posting path shows as the job's githubError. Never a TypeError from reading the row: the control
// gate reads a generic error as a refusal and POSTs the write again.
const rawRespond = (code, text) => (_req, callback) => { const res = new EventEmitter(); res.statusCode = code; callback(res); res.emit('data', Buffer.from(text)); res.emit('end'); };
const createdShapes = {
  'row without an id': JSON.stringify({ user: { login: 'ashlar-bot[bot]' }, created_at: '2026-09-24T13:00:00Z', body: 'b' }),
  'row whose id is not a number': JSON.stringify({ id: '41', user: { login: 'ashlar-bot[bot]' } }),
  null: 'null',
  'primitive (number)': '41',
  'primitive (string)': '"created"',
  array: JSON.stringify([{ id: 41 }]),
  'empty body': '',
};

for (const [name, write] of Object.entries(writes)) {
  test(`${name}: a 2xx body with no usable created row is an unknown outcome from one POST, never a TypeError`, async () => {
    for (const [shape, text] of Object.entries(createdShapes)) {
      let posts = 0;
      const api = oneRealmApi((req, callback) => { posts += 1; rawRespond(201, text)(req, callback); });
      const err = await write(api).then(() => assert.fail(`${shape}: the write must fail`), (e) => e);
      assert.deepEqual({ name: err.name, status: err.status, outcome: err.outcome }, { name: 'GithubWriteError', status: 0, outcome: 'unknown' }, shape);
      assert.match(err.message, /^GitHub (issue comment|Reviews API) 0: no created row in the 201 response: /, shape);
      assert.ok(err.message.endsWith(text || '(empty body)'), `${shape}: the answer is quoted: ${err.message}`);
      assert.equal(api.formatGithubError(err), err.message, `${shape}: the job's githubError is the write's own text`);
      assert.equal(posts, 1, `${shape}: one POST`);
    }
  });
}

test('a list page that is not a JSON array fails the read: never "no rows"', async () => {
  for (const text of ['null', '{}', '"rows"', '']) {
    const api = oneRealmApi(rawRespond(200, text));
    await assert.rejects(api.listIssueComments('t', 'o', 'r', 1), (e) => /^list \/repos\/o\/r\/issues\/1\/comments failed \(200\): not a list: /.test(e.message), JSON.stringify(text));
  }
  const page = oneRealmApi(rawRespond(200, JSON.stringify([{ id: 3, user: { login: 'bob' }, body: 'x', created_at: '2026-09-24T13:00:00Z' }])));
  assert.deepEqual([...(await page.listIssueComments('t', 'o', 'r', 1))].map((r) => ({ ...r })), [{ id: 3, userLogin: 'bob', body: 'x', createdAt: '2026-09-24T13:00:00Z', updatedAt: '' }]);
});
