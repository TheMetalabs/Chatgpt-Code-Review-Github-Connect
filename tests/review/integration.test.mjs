import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness,job,json} from './load-source.mjs';
import {background,storage,content,flush} from './helpers.mjs';

test('integrated worker sends its lease for progress, success and failure',async()=>{
 const {bridge,state}=bridgeHarness([job({id:'A',reviewProviders:['chatgpt','grok']})]);
 const calls=[];let done=false;
 const api=async(path,body)=>{
  calls.push(body);
  if(!body)return {ok:true,...bridge.promptForJob('A')};
  if(body.action==='take')return {ok:true,job:bridge.takeNextBridgeJob(body.clientId)};
  if(body.action==='claim')return bridge.claimBridgeJob(body.jobId,body.clientId);
  if(body.action==='ping')return {ok:true,active:true,accepted:body.jobId?bridge.refreshBridgeClaim(body.jobId,body.generating,body.providerErrors,body.leaseId):true};
  if(body.action==='complete')return bridge.completeBridgeJob(body.jobId,body.raw,body.results,body.leaseId);
  if(body.action==='failure')return {ok:bridge.failBridgeProvider(body.jobId,body.provider,body.error,body.leaseId)};
  throw Error('unexpected action');
 };
 const b=background({api,handler:id=>!done?{ok:false,code:'busy'}:id===101?{ok:true,raw:json}:{ok:false,code:'quota',error:'limit'}});
 await b.tick();done=true;await b.tick();
 assert.ok(state.jobs[0].storedLegs.some(l=>l.provider==='chatgpt'),'raw was lost due to incompatible lease protocol');
 assert.equal(state.jobs[0].providerErrors.grok.code,'quota');
 assert.equal(state.jobs[0].generating.grok,false);
 assert.ok(calls.find(c=>c?.action==='take').clientId);
 assert.ok(calls.filter(c=>c?.jobId).every(c=>c.action==='claim'||c.leaseId));
});

test('stale owners cannot submit provider failure or reset another lease',()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:Date.now(),bridgeClientId:'owner',bridgeLeaseId:'lease',generating:{chatgpt:true}})]);
 assert.equal(bridge.failBridgeProvider('job1','chatgpt','quota: limit','wrong'),false);
 assert.equal(state.jobs[0].generating.chatgpt,true);
 assert.equal(state.jobs[0].providerErrors,undefined);
});

test('missing tab without an explicit close event stays pending for reconnection',async()=>{
 let take=true;
 const b=background({api:async(_p,body)=>body?.action==='take'?{ok:true,job:take?(take=false,{jobId:'A',provider:'chatgpt',providers:['chatgpt'],prompt:'p'}):null}:{ok:true,prompt:'p'}});
 await b.tick();b.tabs.clear();await b.tick();
 assert.ok(b.local.state.pendingReviewJobs.A);
 assert.equal(b.calls.some(c=>c.action==='failure'),false);
 assert.ok(b.calls.some(c=>c.providerErrors?.chatgpt?.code==='disconnected'));
});

test('runner restores tab binding after page context loss without sending again',async()=>{
 const persisted=new Map();const first=content('chatgpt',persisted);
 first.context.runPrompt=async()=>new Promise(()=>{});
 first.message({type:'ashlar-run',jobId:'A',prompt:'review'});await flush();
 const second=content('chatgpt',persisted);let resumed;
 second.context.runPrompt=async(_p,_r,resume)=>{resumed=resume;return new Promise(()=>{});};
 second.message({type:'ashlar-run',jobId:'A',prompt:'review'});await flush();
 assert.equal(resumed,true);
 assert.equal(second.message({type:'ashlar-harvest',jobId:'A'}).jobId,'A');
});

test('an unknown unbound tab cannot be adopted by an ordinary resume',()=>{
 const c=content();
 assert.equal(c.message({type:'ashlar-run',jobId:'A',resume:true}).code,'disconnected');
});

test('normalizing a result does not break duplicate-delivery acknowledgement',async()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:Date.now(),bridgeLeaseId:'lease'})]);
 const wrapped='Here is the review:\n'+json;
 assert.equal((await bridge.completeBridgeJob('job1',wrapped,[{provider:'chatgpt',raw:wrapped}],'lease')).ok,true);
 state.jobs[0].status='posted';
 assert.equal((await bridge.completeBridgeJob('job1',wrapped,[{provider:'chatgpt',raw:wrapped}],'lease')).ok,true);
});
