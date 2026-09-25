import test from 'node:test';
import assert from 'node:assert/strict';
import {background, source, storage} from './helpers.mjs';

test('WORKER_BUILD equals the manifest version (bump both together)', () => {
  const build = source('extension/background.js').match(/const WORKER_BUILD = "([^"]+)"/)?.[1];
  assert.equal(build, JSON.parse(source('extension/manifest.json')).version);
});

test('a stale service worker (newer files on disk) takes nothing and says so (#93)', async () => {
  const local = storage({origin: 'http://bridge', token: 'token', enabled: true});
  const bg = background({local});
  const build = source('extension/background.js').match(/const WORKER_BUILD = "([^"]+)"/)[1];
  bg.chrome.runtime.getManifest = () => ({version: '9.9.9'});
  await bg.tick();
  assert.equal(bg.calls.filter(c => c.action === 'take').length, 0, 'no take from a stale worker');
  assert.match((await local.get(['lastError'])).lastError || '', new RegExp(`stale service worker: running build ${build.replace(/\./g, '\\.')}`));
  // The same worker whose files match takes as usual.
  bg.chrome.runtime.getManifest = () => ({version: build});
  await bg.tick();
  assert.ok(bg.calls.some(c => c.action === 'take'), 'a current worker takes');
});
