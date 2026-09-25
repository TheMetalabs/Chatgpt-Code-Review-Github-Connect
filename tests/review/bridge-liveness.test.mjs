// Owner liveness (chatBridgeLink) comes from the authenticated bridge request itself, recorded before
// the action patches the job or writes history: a patch or history write that fails is never read as
// the owner disconnecting (which would release a verify-clean job's held local leg as the fallback
// under a chat run that is still going).
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness,job} from './load-source.mjs';

const claimed=(patch={})=>job({bridgeClaimedAt:Date.now(),bridgeLeaseId:'lease',bridgeClientId:'chrome1',attemptedProviders:['chatgpt'],...patch});
const failingPatch={patchHarborJob(){throw new Error('history store unavailable');}};
const connected=(bridge,clientId)=>bridge.chatBridgeLink({bridgeClientId:clientId}).connected;

test('a lease ping speaks for its owner before its job patch: a patch that throws is not a disconnect',()=>{
  const {bridge}=bridgeHarness([claimed()],failingPatch);
  assert.equal(connected(bridge,'chrome1'),false,'the owner has not been heard from yet');
  assert.throws(()=>bridge.refreshBridgeClaim('job1',{chatgpt:true},{},'lease'),/history store unavailable/);
  assert.equal(connected(bridge,'chrome1'),true,'the ping was heard from its owner');
});

test('only the owner\'s own lease speaks for the owner',()=>{
  const {bridge}=bridgeHarness([claimed()]);
  assert.equal(bridge.refreshBridgeClaim('job1',{chatgpt:true},{},'another-lease'),false);
  assert.equal(connected(bridge,'chrome1'),false,'a foreign lease is not the owner');
  bridge.noteBridgeRequest({jobId:'job1',leaseId:'another-lease'});
  assert.equal(connected(bridge,'chrome1'),false,'nor through the route');
  bridge.noteBridgeRequest({jobId:'job1',leaseId:'lease'});
  assert.equal(connected(bridge,'chrome1'),true,'the owner\'s lease is');
});

test('every authenticated request naming a profile or carrying its lease is heard before the action runs',()=>{
  const {bridge}=bridgeHarness([claimed(),job({id:'job2',bridgeClaimedAt:Date.now(),bridgeLeaseId:'lease2',bridgeClientId:'chrome2'})]);
  // what the route passes: the raw body, whatever the action (submit, failure, progress, observe...)
  bridge.noteBridgeRequest({action:'complete',jobId:'job2',leaseId:'lease2',raw:'{}'});
  assert.equal(connected(bridge,'chrome2'),true,'a submit under the owner\'s lease');
  bridge.noteBridgeRequest({action:'take',clientId:'chrome3'});
  assert.equal(connected(bridge,'chrome3'),true,'a request naming its profile');
  bridge.noteBridgeRequest({action:'complete',jobId:'missing',leaseId:'lease'});
  bridge.noteBridgeRequest({action:'take',clientId:42});
  assert.equal(connected(bridge,'chrome1'),false,'nothing else speaks for chrome1');
});

test('take, claim and recover are heard from their profile before any job patch',()=>{
  const {bridge}=bridgeHarness([job({id:'job1'})],failingPatch);
  assert.throws(()=>bridge.claimBridgeJob('job1','claimer'),/history store unavailable/);
  assert.equal(connected(bridge,'claimer'),true,'claim');
  assert.throws(()=>bridge.takeNextBridgeJob('taker'),/history store unavailable/);
  assert.equal(connected(bridge,'taker'),true,'take');
  // recover is heard even when what it asks for is malformed
  assert.equal(bridge.recoverBridgeJob('recoverer','not-a-binding-list'),null);
  assert.equal(connected(bridge,'recoverer'),true,'recover');
});
