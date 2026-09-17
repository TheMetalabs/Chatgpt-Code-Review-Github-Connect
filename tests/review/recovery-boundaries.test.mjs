import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {background,storage,raw,content,flush,source} from './helpers.mjs';
const req=(id='A')=>({jobId:id,providers:['chatgpt'],provider:'chatgpt',prompt:'review '+id,leaseId:'lease-'+id});
function server(queue=[req()]){return async(_path,body)=>{
 if(body?.action==='take')return {ok:true,job:queue.shift()||null};
 if(body?.action==='claim')return {ok:true,leaseId:'lease-'+body.jobId};
 return {ok:true,active:true,accepted:true};
};}

test('recovery boundary: never dispatch a prompt after tab-binding persistence failed',async()=>{
 const b=background({api:server()});
 const set=b.local.set;let fail=true;
 b.local.set=async value=>{
  if(fail&&value.pendingReviewJobs?.A?.states.chatgpt.tabId){throw Error('disk full on bound registry');}
  return set(value);
 };
 await b.tick();
 assert.equal(b.messages.filter(x=>x.type==='ashlar-run').length,0);
 assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.tabId,undefined);
 let unsafeDispatch=false;
 const send=b.chrome.tabs.sendMessage;
 b.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-run'&&!b.local.state.pendingReviewJobs.A?.states.chatgpt.tabId)unsafeDispatch=true;
  return send(id,msg,cb);
 };
 await b.tick();
 assert.equal(unsafeDispatch,false,'ashlar-run happened although the durable tab binding was still missing');
 fail=false;await b.tick();
 assert.equal(b.tabs.size,1);
 assert.equal(b.messages.filter(m=>m.type==='ashlar-run').length,1);
});

test('recovery boundary: server missing + restored bound page must recover final raw without a fresh generation',async()=>{
 const persisted=new Map([['ashlar:job','A'],['ashlar:run','run-A']]);
 const page=content('chatgpt',persisted);
 let starts=0,resumes=0;
 page.context.stopButtonVisible=()=>false;
 page.context.replyDoneVisible=()=>true;
 page.context.location={href:'https://chatgpt.com/c/A'};
 page.context.sleep=flush;
 page.context.__ashlarRunnerState.run=async(_p,_reason,resume)=>{
  if(resume)resumes++;else starts++;
  return page.context.waitUntilReviewOrQuota('ChatGPT');
 };
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),
  api:async(_p,body)=>body?.jobId?{ok:true,active:false,accepted:false,status:'missing'}:{ok:true,job:null},
  handler:(_id,msg)=>page.message(msg)});
 for(let i=0;i<5;i++){await b.tick();await flush();}
 assert.equal(starts,0);
 assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome?.raw,raw,'a completed bound DOM remains uncollected forever');
});


test('recovery control: bound idle page recovers final raw when the server job remains active',async()=>{
 const page=content('chatgpt',new Map([['ashlar:job','A'],['ashlar:run','run-A']]));
 let starts=0,resumes=0;
 page.context.stopButtonVisible=()=>false;page.context.replyDoneVisible=()=>true;
 page.context.location={href:'https://chatgpt.com/c/A'};page.context.sleep=flush;
 page.context.__ashlarRunnerState.run=async(_p,_r,resume)=>{
  if(resume)resumes++;else starts++;
  return page.context.waitUntilReviewOrQuota('ChatGPT');
 };
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),api:server([]),handler:(_id,msg)=>page.message(msg)});
 for(let i=0;i<5;i++){await b.tick();await flush();}
 assert.equal(starts,0);assert.equal(resumes,1);
 assert.equal(b.calls.find(c=>c.action==='complete')?.raw,raw);
 assert.equal(b.closedTabs.length,1);
});

test('recovery control: a cached missing-job response is preserved without posting or closing',async()=>{
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),
 api:async(_p,body)=>body?.jobId?{ok:true,active:false,accepted:false,status:'missing'}:{ok:true,job:null},handler:()=>({ok:true,raw})});
 await b.tick();
 assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome.raw,raw);
 assert.equal(b.calls.filter(c=>c.action==='complete').length,0);assert.equal(b.closedTabs.length,0);
});

test('recovery boundary: a running lane must not erase the admission capacity error in monitoring',async()=>{
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({api:server([req('B')]),local:storage({origin:'http://bridge',token:'token',maxReviewTabs:1,pendingReviewJobs:{A:a}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]])});
 await b.tick();
 assert.equal(b.calls.filter(c=>c.action==='take').length,0);
 assert.equal(b.local.state.bridgeWorkerStatus.phase,'reviewing');
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'tab_capacity');
});

test('recovery control: parallel A and B stay bound, only the acknowledged B tab is closed',async()=>{
 const b=background({api:server([req('A'),req('B')])});
 await b.tick();await b.tick();
 const jobs=b.local.state.pendingReviewJobs;
 assert.ok(jobs.A?.states.chatgpt.started);assert.ok(jobs.B?.states.chatgpt.started);
 assert.notEqual(jobs.A.states.chatgpt.tabId,jobs.B.states.chatgpt.tabId);
 const old=b.chrome.tabs.sendMessage;
 b.chrome.tabs.sendMessage=(id,msg,cb)=>msg.jobId==='B'?cb({...msg,ok:true,raw,canClose:true,url:b.tabs.get(id).url}):old(id,msg,cb);
 await b.tick();
 assert.equal(b.calls.filter(c=>c.action==='complete').length,1);
 assert.equal(b.calls.find(c=>c.action==='complete').jobId,'B');
 assert.equal(b.tabs.has(jobs.A.states.chatgpt.tabId),true);
 assert.equal(b.tabs.has(jobs.B.states.chatgpt.tabId),false);
});

test('recovery boundary: failed run identity persistence must not poison legacy-tab recovery after restart',async()=>{
 const persisted=new Map([['ashlar:job','A']]);
 const page=content('chatgpt',persisted);
 page.context.__ashlarRunnerState.running=true; // An original in-flight legacy request.
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,tabId:10}}};
 const local=storage({origin:'http://bridge',token:'token','ashlar:client':'profile',pendingReviewJobs:{A:a}});
 const tabs=new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]);
 const b=background({local,tabs,api:server([]),handler:(_id,msg)=>page.message(msg)});
 b.context.crypto.randomUUID=()=> 'before-restart-run';
 const set=local.set;let reject=true;
 local.set=async value=>{
  if(reject&&value.pendingReviewJobs?.A?.states.chatgpt.runId)throw Error('temporary registry storage failure');
  return set(value);
 };
 await b.tick();await b.tick();
 assert.equal(local.state.pendingReviewJobs.A.states.chatgpt.runId,undefined);
 assert.equal(persisted.get('ashlar:run'),undefined,'an unsaved run ID escaped to the page');
 reject=false;
 const r=background({local,session:b.session,tabs,api:server([]),handler:(_id,msg)=>page.message(msg)});
 r.context.crypto.randomUUID=()=> 'after-restart-run';
 page.context.__ashlarRunnerState.running=false;
 page.context.__ashlarRunnerState.result={ok:true,raw};
 for(let i=0;i<3;i++)await r.tick();
 const result=r.calls.find(c=>c.action==='complete');
 assert.equal(result?.raw,raw,'a failed registry write assigned a transient run ID to the original page, permanently splitting its identity from the restarted worker');
});

test('recovery control: an arbitrarily old busy generation is neither failed nor closed',async()=>{
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({api:server([]),local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]])});
 const now=Date.now();
 // VM Date advances while the same generation stays busy. No wall-clock waiting.
 for(const days of [0,1,365,3650]){
  b.context.__auditNow=now+days*24*3600_000;
  (await import('node:vm')).runInContext('Date.now = () => globalThis.__auditNow',b.context);
  await b.tick();
 }
 assert.equal(b.closedTabs.length,0);
 assert.equal(b.calls.some(c=>c.action==='failure'||c.action==='complete'),false);
 assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome,undefined);
});

test('recovery boundary: a cached outbox is not sent until its failed save is retried',async()=>{
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),
  tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),api:server([]),handler:()=>({ok:true,raw})});
 const set=b.local.set;let reject=true;
 b.local.set=async value=>{
  if(reject&&value.pendingReviewJobs?.A?.states.chatgpt.outcome)throw Error('outbox storage unavailable');
  return set(value);
 };
 await b.tick();await b.tick();
 assert.equal(b.calls.some(c=>c.action==='complete'),false,'an unsaved in-memory outcome was delivered');
 assert.equal(b.closedTabs.length,0);
 reject=false;await b.tick();
 assert.equal(b.calls.filter(c=>c.action==='complete').length,1);
 assert.equal(b.calls.find(c=>c.action==='complete').raw,raw);
 assert.equal(b.closedTabs.length,1);
});

for(const provider of ['chatgpt','grok']) {
 test(`recovery boundary: missing ${provider} observer resumes without prompt or legacy adoption`,async()=>{
  const persisted=new Map([['ashlar:job','A'],['ashlar:run','run-A']]);
  const page=content(provider,persisted);
  page.context.stopButtonVisible=()=>false;page.context.replyDoneVisible=()=>true;page.context.sleep=flush;
  page.context.fillComposer=()=>{throw Error('observer must never fill a composer');};
  const url=provider==='grok'?'https://grok.com/c/A':'https://chatgpt.com/c/A';
  page.context.location={href:url};
  const a={...req(),providers:[provider],provider,origin:'http://bridge',states:{[provider]:{started:true,runId:'run-A',tabId:10,adoptLegacy:true}}};
  let missing=true;
  const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),
   tabs:new Map([[10,{id:10,url,status:'complete'}]]),
   api:async(_p,body)=>body?.action==='take'?{ok:true,job:null}:missing?{ok:true,active:false,accepted:false,status:'missing'}:{ok:true,active:true,accepted:true},
   handler:(_id,msg)=>page.message(msg)});
  for(let i=0;i<5;i++){await b.tick();await flush();}
  assert.equal(b.local.state.pendingReviewJobs.A.states[provider].outcome?.raw,raw);
  const resumed=b.messages.filter(m=>m.type==='ashlar-run');
  assert.equal(resumed.length,1);assert.equal(resumed[0].resume,true);
  assert.equal(resumed[0].prompt,undefined);assert.equal(resumed[0].adoptLegacy,undefined);
  assert.equal(resumed[0].jobId,'A');assert.equal(resumed[0].runId,'run-A');assert.equal(resumed[0].provider,provider);
  assert.equal(b.calls.some(c=>c.action==='complete'||c.action==='failure'),false);
  assert.equal(b.closedTabs.length,0);
  missing=false;await b.tick();
  assert.equal(b.calls.filter(c=>c.action==='complete').length,1);
  assert.equal(b.calls.find(c=>c.action==='complete').results[0].provider,provider);
  assert.equal(b.closedTabs.length,1);
 });
}

for(const [label,entries,provider] of [
 ['unbound',[],'chatgpt'],
 ['another job',[['ashlar:job','B'],['ashlar:run','run-A']],'chatgpt'],
 ['another run',[['ashlar:job','A'],['ashlar:run','run-B']],'chatgpt'],
 ['another provider',[['ashlar:job','A'],['ashlar:run','run-A']],'grok'],
]) {
 test(`recovery boundary: missing observer cannot adopt ${label}`,async()=>{
  const persisted=new Map(entries),page=content(provider,persisted);
  page.context.__ashlarRunnerState.run=()=>{throw Error('untrusted observer was started');};
  const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10,adoptLegacy:true}}};
  const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),
   tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),
   api:async(_p,body)=>body?.jobId?{ok:true,active:false,accepted:false,status:'missing'}:{ok:true,job:null},handler:(_id,msg)=>page.message(msg)});
  await b.tick();await b.tick();
  assert.equal(b.messages.some(m=>m.type==='ashlar-run'),false);
  assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome,undefined);
  assert.deepEqual([...persisted],entries);assert.equal(b.closedTabs.length,0);
 });
}

test('recovery boundary: a missing busy observer has no generation deadline',async()=>{
 const page=content('chatgpt',new Map([['ashlar:job','A'],['ashlar:run','run-A']]));
 page.context.sleep=()=>new Promise(()=>{});
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:a}}),
  tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),
  api:async(_p,body)=>body?.jobId?{ok:true,active:false,accepted:false,status:'missing'}:{ok:true,job:null},handler:(_id,msg)=>page.message(msg)});
 for(const days of [0,365,3650]) {
  b.context.__testNow=days*86400000;vm.runInContext('Date.now=()=>__testNow',b.context);
  await b.tick();await flush();
 }
 assert.equal(b.messages.filter(m=>m.type==='ashlar-run').length,1);
 assert.ok(b.messages.filter(m=>m.type==='ashlar-run').every(m=>m.resume===true));
 assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome,undefined);
 assert.equal(b.closedTabs.length,0);
});

test('diagnostics: execution updates retain admission reasons and a later poll clears them',async()=>{
 const a={...req(),origin:'http://bridge',states:{chatgpt:{started:true,runId:'run-A',tabId:10}}};
 const b=background({api:server([]),local:storage({origin:'http://bridge',token:'token',maxReviewTabs:1,pendingReviewJobs:{A:a}}),
  tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]])});
 await b.tick();const jobs=await b.context.workerJobs('http://bridge');
 await b.context.recordWorkerStatus(jobs,'http://bridge');
 assert.equal(b.local.state.bridgeWorkerStatus.phase,'reviewing');
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'tab_capacity');
 await b.local.set({maxReviewTabs:2});await b.tick();
 assert.equal(b.local.state.bridgeWorkerStatus.phase,'reviewing');
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'idle');
 assert.ok(Number.isFinite(b.local.state.bridgeWorkerStatus.admissionCheckedAt));
});

test('diagnostics: quota and transport failures survive later execution reports',async()=>{
 const b=background();const jobs={};
 for(const phase of ['provider_quota','disconnected']) {
  await b.context.recordWorkerStatus(jobs,'http://bridge',phase);
  await b.context.recordWorkerStatus(jobs,'http://bridge');
  assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,phase);
  assert.equal(b.local.state.bridgeWorkerStatus.phase,'idle');
 }
 await b.context.recordWorkerStatus(jobs,'http://other');
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'not_checked','another origin inherited the old admission status');
});

test('diagnostics: concurrent status writes are ordered rather than reverting the admission result',async()=>{
 const b=background(),set=b.local.set;let active=0,peak=0;
 b.local.set=async values=>{
  if(!values.bridgeWorkerStatus)return set(values);
  peak=Math.max(peak,++active);await flush();await set(values);active--;
 };
 await Promise.all([
  b.context.recordWorkerStatus({},'http://bridge','tab_capacity'),
  b.context.recordWorkerStatus({},'http://bridge'),
  b.context.recordWorkerStatus({},'http://bridge','admitted'),
 ]);
 assert.equal(peak,1);
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'admitted');
});

test('diagnostics: popup shows the running job and admission blocker together',async()=>{
 const elements=new Map();
 const document={getElementById:id=>{
  if(!elements.has(id))elements.set(id,{textContent:'',addEventListener(){}});
  return elements.get(id);
 }};
 const local=storage({origin:'http://bridge',enabled:true,bridgeWorkerStatus:{origin:'http://bridge',phase:'reviewing',
  admissionPhase:'tab_capacity',activeJobs:1,recoveringJobs:0,pendingCleanup:0,savedReplies:0,checkedAt:1,admissionCheckedAt:1}});
 const context=vm.createContext({document,console,chrome:{storage:{local,onChanged:{addListener(){}}},runtime:{getManifest:()=>({version:'test'})}}});
 vm.runInContext(source('extension/popup.js'),context);
 await vm.runInContext('refreshDiagnostics()',context);
 assert.match(elements.get('worker').textContent,/Current review in progress/);
 assert.match(elements.get('worker').textContent,/review-tab capacity reached/);
 // Old persisted reports remain readable during an upgrade.
 await local.set({bridgeWorkerStatus:{origin:'http://bridge',phase:'tab_capacity',activeJobs:0,recoveringJobs:0,pendingCleanup:0,savedReplies:0}});
 await vm.runInContext('refreshDiagnostics()',context);
 assert.match(elements.get('worker').textContent,/review-tab capacity reached/);
});
