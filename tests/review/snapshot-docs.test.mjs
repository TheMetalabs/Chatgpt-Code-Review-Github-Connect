import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TLSSocket } from 'node:tls';
import { loadTs } from './load-source.mjs';
import { buildChatParts } from '../../src/lib/chat-prompt.ts';

// The real fetchPullSnapshot -> gh -> HTTPS decoder; only DNS and the network stream are fakes. The
// fake GitHub answers by request path: compare, contents at a ref, and the pull itself. Synthetic repo.
const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const CONTENTS = {
  [BASE]: {
    'AGENTS.md': '# Root\n\n## Code Review Rules\n- root rule',
    'svc/CLAUDE.md': '# Svc\n\nBASE_MODULE_RULE: listeners throw so the outbox retries.',
  },
  [HEAD]: {
    'svc/CLAUDE.md': '# Svc\n\nBASE_MODULE_RULE: listeners throw so the outbox retries.\n- HEAD_ROUTE_DOC: POST /v1/email documented by this PR',
    'svc/routes.ts': 'export function route() {\n  return 2;\n}',
  },
};
const COMPARE = {
  files: [
    { filename: 'svc/CLAUDE.md', status: 'modified', patch: '@@ -1,3 +1,4 @@\n # Svc\n \n BASE_MODULE_RULE: listeners throw so the outbox retries.\n+- HEAD_ROUTE_DOC: POST /v1/email documented by this PR' },
    { filename: 'svc/routes.ts', status: 'modified', patch: '@@ -1,3 +1,3 @@\n export function route() {\n-  return 1;\n+  return 2;\n }' },
  ],
};

function fakeGithub() {
  const paths = [];
  const reply = (path) => {
    if (path.startsWith(`/repos/o/r/compare/${BASE}...${HEAD}`)) return [200, COMPARE];
    if (path === '/repos/o/r/pulls/7') return [200, { title: 't', body: 'PR body', head: { sha: HEAD, repo: { fork: false } }, base: { sha: BASE } }];
    const m = /^\/repos\/o\/r\/contents\/(.+)\?ref=([a-z0-9]+)$/.exec(path);
    const text = m && CONTENTS[m[2]]?.[decodeURIComponent(m[1])];
    if (text != null) return [200, { type: 'file', encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64') }];
    return [404, { message: 'Not Found' }];
  };
  const api = loadTs('src/lib/github.server.ts', {
    ...loadTs('src/lib/github-transport.ts', { TLSSocket }),
    ...loadTs('src/lib/github-snapshot.ts'),
    ...loadTs('src/lib/import-resolve.ts'),
    ...loadTs('src/lib/review-budget.ts'),
    ...loadTs('src/lib/types.ts'),
    dnsLookup: async () => ({ address: '127.0.0.1', family: 4 }),
    https: { request(options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.write = () => {};
      request.end = () => queueMicrotask(() => {
        paths.push(options.path);
        const [status, body] = reply(options.path);
        const response = new EventEmitter(); response.statusCode = status;
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify(body)));
        response.emit('end');
      });
      return request;
    } },
  });
  return { api, paths };
}

const target = { owner: 'o', repo: 'r', pr: 7, title: 't', headSha: HEAD, baseSha: BASE, sender: 's', isFork: false, isDraft: false };

test('a changed module CLAUDE.md is policy at base and context at head', async () => {
  const { api, paths } = fakeGithub();
  const sample = await api.fetchPullSnapshot('token', target);
  assert.ok(paths.includes(`/repos/o/r/contents/svc/CLAUDE.md?ref=${BASE}`), 'module CLAUDE.md read at base as policy');
  assert.ok(paths.includes(`/repos/o/r/contents/CLAUDE.md?ref=${BASE}`), 'root CLAUDE.md is part of the policy chain');
  assert.ok(paths.includes(`/repos/o/r/contents/svc/CLAUDE.md?ref=${HEAD}`), 'the changed doc is read at head too');
  // files: every changed path at HEAD (what the PR documents; what a fix would edit).
  assert.match(sample.files.find((f) => f.path === 'svc/CLAUDE.md').content, /HEAD_ROUTE_DOC/);
  // basePolicyFiles: the BASE text of the changed policy doc, the policy authority.
  assert.deepEqual(Array.from(sample.basePolicyFiles, (f) => f.path), ['svc/CLAUDE.md']); // vm realm → plain array
  assert.doesNotMatch(sample.basePolicyFiles[0].content, /HEAD_ROUTE_DOC/);
  assert.match(sample.basePolicyFiles[0].content, /BASE_MODULE_RULE/);
  assert.equal(sample.body, 'PR body');

  // End to end into the prompt: the reviewer sees the PR's doc edit, and the policy stays the base text.
  const { prompt, files } = buildChatParts({ sample, extra: '/review', untrustedBody: '/review' });
  const snap = files.find((f) => f.name === 'ashlar-snapshot.md').body;
  const policy = files.find((f) => f.name === 'ashlar-policy.md').body;
  assert.match(snap, /<<<CHANGED_NON_CODE_FILES>>>\n--- svc\/CLAUDE\.md \(L1-L4\)[\s\S]*HEAD_ROUTE_DOC/);
  assert.match(policy, /--- svc\/CLAUDE\.md\n[\s\S]*BASE_MODULE_RULE/);
  assert.doesNotMatch(policy, /HEAD_ROUTE_DOC/);
  assert.ok(policy.indexOf('svc/CLAUDE.md') < policy.indexOf('--- AGENTS.md'), 'nearest module doc before the root rules');
  assert.match(prompt, /<<<UNTRUSTED_PR_DESCRIPTION>>>\nPR body\n<<<END>>>/);
});
