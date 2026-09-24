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

test('createPullReview reports inlineDropped when GitHub refused an inline anchor', async () => {
  const { api, sent } = githubWith([
    [422, JSON.stringify({ message: 'Unprocessable Entity', errors: ['pull_request_review_thread.line must be part of the diff'] })],
    [200, JSON.stringify({ id: 9 })],
  ]);
  assert.deepEqual({ ...(await api.createPullReview('t', review(inline))) }, { id: 9, inlineDropped: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].comments.length, 0, 'the fallback posts no inline comment at all');
});

test('createPullReview: inlineDropped is false when every inline comment was accepted (or there were none)', async () => {
  const ok = githubWith([[200, JSON.stringify({ id: 7 })]]);
  assert.deepEqual({ ...(await ok.api.createPullReview('t', review(inline))) }, { id: 7, inlineDropped: false });
  const none = githubWith([[200, JSON.stringify({ id: 8 })]]);
  assert.deepEqual({ ...(await none.api.createPullReview('t', review([]))) }, { id: 8, inlineDropped: false });
});

test('listReviewThreadRoots keys each root by its line (original_line once outdated) and drops replies', async () => {
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
    { id: 4, path: 'a.ts', body: 'no line' },
  ]);
});
