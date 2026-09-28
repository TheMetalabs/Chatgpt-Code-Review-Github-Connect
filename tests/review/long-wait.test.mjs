import {bridgePromptText} from "../../src/lib/chat-prompt.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import {background,content,flush,raw,source} from './helpers.mjs';
import {bridgeHarness,job,loadTs,parser} from './load-source.mjs';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('bridge result delivery RPC (complete) has no application abort deadline, including delayed body receipt',async t=>{
 const b=background(),headers=deferred(),body=deferred();let init,settled=false;
 b.context.fetch=async(_url,options)=>{init=options;await headers.promise;return {ok:true,status:200,json:()=>body.promise};};
 t.mock.timers.enable({apis:['Date','setTimeout']});
 const waiting=b.rpc('/api/bridge',{action:'complete',jobId:'A',raw}).then(out=>{settled=true;return out;});
 await flush();
 try{
  assert.equal(init.signal,undefined,'bridge RPC must not create a short AbortSignal timeout');
  t.mock.timers.tick(8*3600_000);await flush();assert.equal(settled,false);
  headers.resolve();await flush();t.mock.timers.tick(8*3600_000);await flush();assert.equal(settled,false);
 }finally{headers.resolve();body.resolve({ok:true});await waiting;}
});
test('a delayed content acknowledgement is not a model timeout',async t=>{
 const b=background();let ack; b.chrome.tabs.sendMessage=(_id,_msg,cb)=>{ack=cb;};
 t.mock.timers.enable({apis:['setTimeout','Date']});
 let failed;const call=b.context.sendToTab(10,{type:'ashlar-harvest',jobId:'A'},[]).catch(e=>{failed=e;});
 t.mock.timers.tick(8*3600_000);await flush();
 const timedOut=failed;ack({ok:false,code:'busy'});await call;
 assert.equal(timedOut,undefined,'a timer ended a pending content request');
});
test('stored completion is acknowledged before arbitrarily slow validation/GitHub publication',async()=>{
 const gate=deferred();let publishing=0,acked=false;
 const h=bridgeHarness([job({bridgeClaimedAt:Date.now(),generating:{chatgpt:true}})],{submitHarborChat:async()=>{publishing++;await gate.promise;return {ok:true};}});
 const pending=h.bridge.completeBridgeJob('job1',raw,[{provider:'chatgpt',raw}]).then(result=>{acked=true;return result;});
 await flush();const earlyAck=acked;
 assert.equal(h.state.jobs[0].storedLegs[0].raw,raw);assert.equal(h.state.jobs[0].generating.chatgpt,false);
 gate.resolve();await pending;assert.equal(earlyAck,true,'result delivery waited for publication');assert.equal(publishing,1);
});
test('background publication failure cannot invalidate receipt or produce an unhandled rejection',async()=>{
 const h=bridgeHarness([job({bridgeClaimedAt:Date.now()})],{submitHarborChat:async()=>{throw Error('fixture posting interrupted');}});
 const out=await h.bridge.completeBridgeJob('job1',raw,[{provider:'chatgpt',raw}]);
 await flush();assert.equal(out.ok,true);assert.equal(h.state.jobs[0].storedLegs[0].raw,raw);
 assert.match(h.bridge.getBridgeStatus().lastError,/fixture posting interrupted/);
});
test('no JSON observation remains pending after eight hours and never emits empty',async()=>{
 const c=content().context;let ticks=0;
 c.stopButtonVisible=()=>false;c.replyDoneVisible=()=>true;c.assistantCorpus=()=>ticks<8?['visible text not JSON yet']:[raw];
 c.sleep=async()=>{ticks++;if(ticks>20)throw Error('test guard');};
 c.Date=class extends Date{static now(){return ticks*3600_000;}};
 assert.equal(await c.waitUntilReviewOrQuota('ChatGPT'),raw);assert.ok(ticks>=8);
});
test('local health check is not failed by an implicit five-second signal',async()=>{
 let seen;
 const local=loadTs('src/lib/local-llm.server.ts',{...parser,bridgePromptText,AbortSignal:{timeout:()=>{throw Error('health request used a timeout');}},
   requestLocalJson:async(...args)=>{seen=args;return {};},requestLocalChat:async()=>raw});
 const out=await local.pingLocalLlm({localLlmBaseUrl:'http://local/v1',localLlmApiKey:'local',localLlmModel:'m'});
 assert.equal(out.ok,true);assert.equal(seen?.[4],undefined);
});
test('the sample tool-agent path must not impose a hidden generation deadline either',()=>{
 const text=source('src/lib/harness/live.ts');assert.doesNotMatch(text,/AbortSignal\.timeout\(25_000\)/);
 assert.match(text,/requestLocalJson/);
});

test('a network abort remains a recoverable bridge error, not an empty/model timeout',async()=>{
 const b=background();b.context.fetch=async()=>{throw new DOMException('signal timed out','TimeoutError');};
 await assert.rejects(b.rpc('/api/bridge',{action:'complete',jobId:'A',raw}),e=>
   e.transport===true && /Bridge complete \(A\) transport interrupted/.test(e.message) && /not cancelled/.test(e.message));
 assert.equal(b.calls.some(c=>c.action==='failure'),false);
});
test('busy observation preserves non-JSON text under the matching PR/run and is not delivered as final',async()=>{
 const b=background({handler:()=>({ok:false,code:'busy',observation:{state:'waiting_for_json',text:'final-looking text not JSON yet',totalChars:31}}),
  api:async(_p,body)=>body.action==='take'?{ok:true,job:{jobId:'A',providers:['chatgpt'],prompt:'review'}}:{ok:true,active:true,accepted:true}});
 await b.tick();const slot=b.local.state.pendingReviewJobs.A.states.chatgpt;
 assert.equal(slot.observation.text,'final-looking text not JSON yet');assert.equal(slot.outcome,undefined);
 assert.equal(b.calls.some(c=>c.action==='complete'||c.action==='failure'),false);
 assert.equal(b.local.state.bridgeWorkerStatus.waitingForJson,1);
 assert.ok(!JSON.stringify(b.local.state.bridgeWorkerStatus).includes('final-looking text'));
});
test('Local review call waits for actual completion rather than an elapsed timeout signal',async()=>{
 const gate=deferred();let passedSignal;
 const local=loadTs('src/lib/local-llm.server.ts',{...parser,bridgePromptText,
  requestLocalChat:async(...args)=>{passedSignal=args[3];return gate.promise;}});
 let done=false;const pending=local.runLocalLlm('review',{localLlmBaseUrl:'http://local/v1',localLlmApiKey:'key',localLlmModel:'model'}).then(result=>{done=true;return result;});
 await flush();assert.equal(done,false);assert.equal(passedSignal,undefined);
 gate.resolve(raw);assert.equal((await pending).raw,raw);
});
test('delayed tool-agent response uses the same native transport with explicit cancellation only',async()=>{
 const gate=deferred();let args;
 const stub=()=>({validator(){return this;},handler(){return {};}});
 const agent=loadTs('src/lib/harness/live.ts',{
  createServerFn:stub,createLiveLimiter:()=>({}),liveAdmit:()=>({ok:true}),liveRelease:()=>{},
  closestAgents:()=>[],CODE_REVIEW_MD:'policy',ROOT_AGENTS_MD:'root',PAYMENT_AGENTS_MD:'payment',
  requestLocalJson:async(...input)=>{args=input;return gate.promise;},process:{env:{XAI_API_KEY:'fixture'}},
  gateLiveSubmission:()=>({ok:true,findings:[],mergeRecommendation:'COMMENT',highestRisk:'',investigatedSafe:[],assumptions:[],dropped:[]}),
 });
 const controller=new AbortController();let done=false;
 const waiting=agent.runLiveOnSnapshot({files:[],sample:{owner:'o',repo:'r',pr:1,changedPaths:[]},settings:{},diff:'',signal:controller.signal}).then(out=>{done=true;return out;});
 await flush();assert.equal(done,false);assert.equal(args[4],controller.signal);
 gate.resolve({choices:[{message:{tool_calls:[{id:'a',function:{name:'submit_findings',arguments:'{"findings":[]}'}}]}}]});
 assert.equal((await waiting).ok,true);
});
test('interrupted response body is retryable transport, not a 400 parse/model failure',async()=>{
 const b=background();b.context.fetch=async()=>({ok:true,status:200,json:async()=>{throw new DOMException('signal timed out','TimeoutError');}});
 await assert.rejects(b.rpc('/api/bridge',{action:'complete',jobId:'A',raw}),e=>e.transport===true && e.status!==400);
});
