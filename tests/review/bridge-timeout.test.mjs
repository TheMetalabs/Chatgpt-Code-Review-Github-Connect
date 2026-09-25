// A bridge request the bridge never answers (a hung take, a stalled proxy) must not hold its lane
// forever: api() bounds every request (apiTimeoutMs), so admission, delivery and heartbeats retry on
// a later tick instead of waiting on one fetch that never settles.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {background} from './helpers.mjs';

function hangingBridge(b, hang) {
  const seen = [];
  b.context.api = b.rpc; // the real api(): its fetch is the fixture below
  b.context.fetch = (_url, init) => {
    const body = JSON.parse(init?.body || '{}');
    seen.push(body.action);
    // As fetch does: an aborted signal rejects at once, and an abort rejects a pending request.
    // (A request with no signal can never end.)
    const signal = init?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (hang(body, seen)) return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    return Promise.resolve({ok: true, status: 200, json: async () => ({ok: true, job: null, active: false, accepted: false})});
  };
  return seen;
}
const settled = (promise, ms) => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setTimeout(() => resolve(false), ms))]);

test('api: a request the bridge never answers fails as a transport error after apiTimeoutMs', async () => {
  const b = background();
  hangingBridge(b, () => true);
  b.context.apiTimeoutMs = () => 50;
  const call = b.rpc('/api/bridge', {action: 'take'});
  assert.equal(await settled(call, 2000), true, 'the request ends');
  await assert.rejects(call, error => error.transport === true && /Bridge take/.test(error.message));
});

test('admission: a hung take does not hold the admission lane; the next tick takes again', async () => {
  const b = background();
  const seen = hangingBridge(b, (body, all) => body.action === 'take' && all.filter(a => a === 'take').length === 1);
  b.context.apiTimeoutMs = () => 50;
  assert.equal(await settled(b.tick(), 2000), true, 'the tick with the hung take ends');
  await b.tick();
  assert.equal(seen.filter(a => a === 'take').length, 2, 'admission asks again');
});

test('api: a caller\'s own signal still cancels a request before the timeout', async () => {
  const b = background();
  hangingBridge(b, () => true);
  const controller = new AbortController();
  const call = b.rpc('/api/bridge', {action: 'ping'}, undefined, controller.signal);
  controller.abort();
  await assert.rejects(call, error => error.transport === true);
});
