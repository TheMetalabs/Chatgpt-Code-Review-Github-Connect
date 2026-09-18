import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness,job as makeJob} from './load-source.mjs';

test('failure marks only its provider and remains idempotent', () => {
 const {bridge,state}=bridgeHarness([makeJob({id:'A',bridgeClaimedAt:Date.now(),reviewProviders:['chatgpt','grok','local'],generating:{chatgpt:true,grok:true,local:true}})]);
 bridge.failBridgeProvider('A','chatgpt','quota: usage limit');
 bridge.failBridgeProvider('A','chatgpt','quota: usage limit');
 const job=state.jobs[0];
 assert.equal(job.generating.chatgpt,false);
 assert.equal(job.generating.grok,true);assert.equal(job.generating.local,true);
 assert.equal(job.assumptions.filter(s=>s.startsWith('Skipped chatgpt')).length,1);
});
test('late failures never mutate completed or cancelled jobs', () => {
 for(const status of ['posted','cancelled','validator']){
  const {bridge,state}=bridgeHarness([makeJob({id:'A',status,generating:{chatgpt:false},assumptions:['kept']})]);
  const before=JSON.stringify(state.jobs[0]);
  bridge.failBridgeProvider('A','chatgpt','quota');
  assert.equal(JSON.stringify(state.jobs[0]),before);
 }
});
test('a success is stored atomically with generating=false before async validation',async()=>{
 const raw='{"findings":[]}';let validated=false;
 const h=bridgeHarness([makeJob({id:'A',bridgeClaimedAt:Date.now(),reviewProviders:['chatgpt','grok'],generating:{chatgpt:true,grok:true}})],{
  submitHarborChat:async()=>{
   const job=h.state.jobs[0];
   assert.equal(job.generating.chatgpt,false);assert.equal(job.generating.grok,true);
   assert.equal(job.storedLegs.find(l=>l.provider==='chatgpt')?.raw,raw);
   validated=true;return {ok:true};
  },
 });
 await h.bridge.completeBridgeJob('A',raw,[{provider:'chatgpt',raw}]);
 assert.equal(validated,true);
});
