import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseGitHubPayload } from '../../src/lib/github-payload.ts';
import { decideIngress, reviewSkipReason } from '../../src/lib/ingress.ts';
import { DEFAULT_SETTINGS } from '../../src/lib/types.ts';
import { loadTs } from './load-source.mjs';

const settings = { ...DEFAULT_SETTINGS, skipDrafts: true, skipForks: true };
const missingRepos = [
  ['null', { repo: null }],
  ['omitted', {}],
  ['missing fork flag', { repo: {} }],
  ['non-boolean fork flag', { repo: { fork: 'false' } }],
];
function payload(headPatch) {
  return {
    action: 'edited', changes: { body: { from: 'Description' } },
    repository: { full_name: 'fixture/fixture', fork: false }, sender: { login: 'author' },
    pull_request: { number: 34, body: '@ashlar-bot review', draft: true,
      head: { sha: 'abc123', ...headPatch }, base: { sha: 'def456' } },
    comment: { id: 42, body: '@ashlar-bot review' },
  };
}
for (const event of ['pull_request', 'pull_request_review_comment']) {
  for (const [name, headPatch] of missingRepos) {
    test(`${event}: ${name} head repository preserves unknown provenance with populated SHAs`, () => {
      const parsed = parseGitHubPayload(event, payload(headPatch), settings);
      assert.equal(parsed.kind, 'review');
      assert.equal(parsed.target.isFork, null);
      assert.equal(parsed.target.headSha, 'abc123');
      const opts = { sample: parsed.target, trigger: parsed.trigger, thread: parsed.thread, settings };
      // Queuing metadata resolution must not mean authorizing snapshot/model work.
      const decision = decideIngress({ ...opts, hmacOk: true, deliveryId: name, existing: [] });
      assert.equal(decision.job?.isFork, null);
      assert.match(reviewSkipReason(opts), /fork.*unknown/i);
      assert.equal(reviewSkipReason({ ...opts, settings: { ...settings, skipForks: false } }), undefined);
    });
  }
}
for (const fork of [true, false]) {
  test(`known head fork=${fork} overrides the destination repository's flag`, () => {
    const raw = payload({ repo: { fork } }); raw.repository.fork = !fork;
    const parsed = parseGitHubPayload('pull_request', raw, settings);
    assert.equal(parsed.target.isFork, fork);
  });
  test(`issue comments cannot infer head provenance from destination fork=${fork}`, () => {
    const raw = payload({}); raw.repository.fork = fork;
    raw.issue = { number: 34, pull_request: {} };
    const parsed = parseGitHubPayload('issue_comment', raw, settings);
    assert.equal(parsed.target.isFork, null);
  });
}

// Exercise the real fetchPullHead -> gh -> HTTPS response decoder, replacing
// only DNS and the network stream. No GitHub credentials or live API calls.
function githubWithResponse(body) {
  return loadTs('src/lib/github.server.ts', {
    dnsLookup: async () => ({ address: '127.0.0.1', family: 4 }),
    https: { request(options, callback) {
      assert.equal(options.path, '/repos/fixture/fixture/pulls/34');
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = 200;
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify(body)));
        response.emit('end');
      });
      return request;
    } },
  });
}
for (const [name, headPatch] of [...missingRepos, ['fork', { repo: { fork: true } }], ['trusted', { repo: { fork: false } }]]) {
  test(`fetchPullHead preserves ${name} provenance rather than coercing it to false`, async () => {
    const api = githubWithResponse(payload(headPatch).pull_request);
    const result = await api.fetchPullHead('fixture', 'fixture', 'fixture', 34);
    const expected = typeof headPatch.repo?.fork === 'boolean' ? headPatch.repo.fork : null;
    assert.equal(result.fork, expected);
  });
}
