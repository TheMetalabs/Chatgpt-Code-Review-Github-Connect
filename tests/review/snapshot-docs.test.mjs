import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TLSSocket } from 'node:tls';
import { loadTs } from './load-source.mjs';
import { buildChatParts } from '../../src/lib/chat-prompt.ts';
import { gateLiveSubmission } from '../../src/lib/poster.ts';
import { DEFAULT_SETTINGS } from '../../src/lib/types.ts';

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

function fakeGithub(contents = CONTENTS, compare = COMPARE) {
  const paths = [];
  const reply = (path) => {
    if (path.startsWith(`/repos/o/r/compare/${BASE}...${HEAD}`)) return [200, compare];
    if (path === '/repos/o/r/pulls/7') return [200, { title: 't', body: 'PR body', head: { sha: HEAD, repo: { fork: false } }, base: { sha: BASE } }];
    const m = /^\/repos\/o\/r\/contents\/(.+)\?ref=([a-z0-9]+)$/.exec(path);
    const text = m && contents[m[2]]?.[decodeURIComponent(m[1])];
    if (text != null) return [200, { type: 'file', encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64') }];
    return [404, { message: 'Not Found' }];
  };
  const api = loadTs('src/lib/github.server.ts', {
    ...loadTs('src/lib/github-transport.ts', { TLSSocket }),
    ...loadTs('src/lib/github-snapshot.ts'),
    ...loadTs('src/lib/import-resolve.ts'),
    ...loadTs('src/lib/review-budget.ts'),
    ...loadTs('src/lib/review-diff.ts'),
    ...loadTs('src/lib/gitattributes.ts'),
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

// The diff a live snapshot carries is compact `--- path` + patch blocks (no `diff --git` / `+++`). The
// finding gate must read it: a P1 whose quote sits on a changed line stays P1 and requests changes.
test('the live snapshot diff (compact blocks) grounds a P1 on a changed line through the gate', async () => {
  const { api } = fakeGithub();
  const sample = await api.fetchPullSnapshot('token', target);
  for (const f of COMPARE.files) assert.ok(sample.diff.split('\n\n--- ').some((b) => b.replace(/^--- /, '') === `${f.filename}\n${f.patch}`), f.filename);
  assert.doesNotMatch(sample.diff, /^(?:diff --git|\+\+\+ )/m);
  const finding = {
    severity: 'P1', file: 'svc/routes.ts', line: 2, side: 'RIGHT', title: 'route() returns the retired version code',
    failure_scenario: 'Clients pinned to version 1 receive 2 and reject every response.', root_cause: 'route now returns 2 unconditionally.',
    evidence: 'svc/routes.ts:2 `return 2;`', recommended_fix: 'Keep returning 1 for pinned clients.', recommended_test: 'A pinned client gets 1.',
  };
  const gate = gateLiveSubmission({ merge_recommendation: 'REQUEST_CHANGES', findings: [finding], investigated_safe: [] }, sample, DEFAULT_SETTINGS);
  assert.ok(gate.ok, gate.reason);
  assert.deepEqual(gate.findings.map((f) => [f.file, f.severity]), [['svc/routes.ts', 'P1']]);
  assert.equal(gate.mergeRecommendation, 'REQUEST_CHANGES');
});

// Live WalkieBoard #523: a vendored upstream drop, marked linguist-vendored by the repository. With the
// setting on it never reaches the review; a finding on it never posts.
test('linguist-vendored paths (.gitattributes) are left out of the snapshot, and a finding on one never posts', async () => {
  const vendored = { filename: 'Packages/Kit/Sources/Audio.swift', status: 'added', patch: '@@ -0,0 +1,2 @@\n+func f() {\n+}' };
  const compare = { files: [...COMPARE.files, vendored, { filename: '.gitattributes', status: 'modified', patch: '@@ -1 +1,2 @@\n * text=auto\n+Packages/Kit/** linguist-vendored' }] };
  const contents = {
    [BASE]: { ...CONTENTS[BASE], '.gitattributes': '* text=auto\n' },
    [HEAD]: { ...CONTENTS[HEAD], '.gitattributes': '* text=auto\nPackages/Kit/** linguist-vendored\n', 'Packages/Kit/Sources/Audio.swift': 'func f() {\n}' },
  };
  const { api, paths } = fakeGithub(contents, compare);
  const sample = await api.fetchPullSnapshot('token', target, { skipVendored: true });
  assert.ok(!sample.changedPaths.includes(vendored.filename), 'not a changed path of the review');
  assert.ok(sample.changedPaths.includes('.gitattributes'), 'the .gitattributes change itself is reviewed');
  assert.ok(!sample.files.some((f) => f.path === vendored.filename), 'its content is not fetched');
  assert.ok(!paths.some((p) => p.startsWith('/repos/o/r/contents/Packages/')), 'no request for it at all');
  assert.doesNotMatch(sample.diff, /Audio\.swift/);
  assert.deepEqual(JSON.parse(JSON.stringify(sample.vendoredPaths)), [{ path: vendored.filename, kind: 'vendored' }]);
  const finding = {
    severity: 'P1', file: vendored.filename, line: 1, side: 'RIGHT', title: 'f() does nothing',
    failure_scenario: 'Calling f has no effect.', root_cause: 'Empty body.', evidence: 'Packages/Kit/Sources/Audio.swift:1 `func f() {`',
    recommended_fix: 'Implement f.', recommended_test: 'Call f.',
  };
  const gate = gateLiveSubmission({ merge_recommendation: 'REQUEST_CHANGES', findings: [finding], investigated_safe: ['svc/routes.ts ok'] }, sample, DEFAULT_SETTINGS);
  assert.ok(gate.ok);
  assert.equal(gate.findings.length, 0, 'a finding on a vendored path is never posted');

  // Setting off: the same PR reviews the vendored file like any other.
  const off = await fakeGithub(contents, compare).api.fetchPullSnapshot('token', target, { skipVendored: false });
  assert.ok(off.changedPaths.includes(vendored.filename));
  assert.equal(off.vendoredPaths, undefined);
});

// Codex #179: a vendored rule the PR removes no longer applies (head attributes only, never base's).
test('a linguist-vendored rule the PR removes from .gitattributes no longer leaves its paths out', async () => {
  const lib = { filename: 'lib/core.c', status: 'modified', patch: '@@ -1 +1 @@\n-int a;\n+int b;' };
  const compare = { files: [lib, { filename: '.gitattributes', status: 'modified', patch: '@@ -1 +1 @@\n-lib/** linguist-vendored\n+* text=auto' }] };
  const contents = {
    [BASE]: { ...CONTENTS[BASE], '.gitattributes': 'lib/** linguist-vendored\n' },
    [HEAD]: { ...CONTENTS[HEAD], '.gitattributes': '* text=auto\n', 'lib/core.c': 'int b;' },
  };
  const sample = await fakeGithub(contents, compare).api.fetchPullSnapshot('token', target, { skipVendored: true });
  assert.ok(sample.changedPaths.includes('lib/core.c'), 'the now-maintained file is reviewed');
  assert.equal(sample.vendoredPaths, undefined);
});
