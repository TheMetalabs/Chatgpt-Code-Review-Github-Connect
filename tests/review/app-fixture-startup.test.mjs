import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('missing VM module support fails before the fixture binds a server', () => {
  const script = `
    import {appFixture} from ${JSON.stringify(new URL('./app-fixture.mjs', import.meta.url).href)};
    try { await appFixture(); process.exitCode = 2; }
    catch (error) { console.error(error.message); }
  `;
  const result = spawnSync(process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {encoding: 'utf8', timeout: 5000, env: {...process.env, NODE_OPTIONS: ''}},
  );
  assert.equal(result.error, undefined, 'startup rejection must exit without a leaked HTTP server');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /appFixture requires --experimental-vm-modules/);
});
