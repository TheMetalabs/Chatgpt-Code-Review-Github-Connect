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

test('a logged-out ChatGPT page pauses new chatgpt legs ~10 min: the next leg fails fast with no tab, and with every provider paused nothing is taken (#455)',async()=>{
 const offers=[{jobId:'A',provider:'chatgpt',providers:['chatgpt'],prompt:'p'},{jobId:'B',provider:'chatgpt',providers:['chatgpt'],prompt:'p'}];
 const api=async(_p,body)=>body?.action==='take'?{ok:true,job:offers.shift()??null}:{ok:true,prompt:'p'};
 const b=background({api,handler:(_id,msg)=>msg.type==='ashlar-run'?{ok:false,code:'busy'}:
  {ok:false,code:'logged_out',error:'ChatGPT is logged out in this Chrome profile; log in and retry (nothing was typed or sent)'}});
 for(let i=0;i<4 && !b.calls.some(c=>c.action==='failure'&&c.jobId==='A');i++){await b.tick();await flush();}
 const failA=b.calls.find(c=>c.action==='failure'&&c.jobId==='A');
 assert.ok(failA,'the logged_out outcome is delivered');
 assert.match(failA.error,/^logged_out: ChatGPT is logged out in this Chrome profile; log in and retry/);
 const until=b.local.state.loginPause?.chatgpt;
 assert.ok(until>Date.now()+9*60_000 && until<=Date.now()+10*60_000,`chatgpt paused ~10 min: ${until}`);
 const tabsBefore=b.effects.filter(e=>e.effect==='create').length;
 for(let i=0;i<4 && !b.calls.some(c=>c.action==='failure'&&c.jobId==='B');i++){await b.tick();await flush();}
 const failB=b.calls.find(c=>c.action==='failure'&&c.jobId==='B');
 assert.ok(failB,'the next chatgpt leg fails at once while paused');
 assert.match(failB.error,/^logged_out: /);
 assert.equal(b.effects.filter(e=>e.effect==='create').length,tabsBefore,'no tab is opened for a paused provider');
 // ChatGPT paused: nothing is taken (ChatGPT pacing), and the phase stays logged_out so the coordinator's watch asks for a login.
 await b.tick();await flush();
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'logged_out','one provider paused shows logged_out');
 // Grok also unavailable: admission takes nothing and says why.
 await b.local.set({quota:{grok:Date.now()+60*60_000}});
 const takes=b.calls.filter(c=>c.action==='take').length;
 await b.tick();await flush();
 assert.equal(b.calls.filter(c=>c.action==='take').length,takes,'no new job is taken while every provider is paused');
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'logged_out');
 // Past the pause, admission re-checks.
 await b.local.set({loginPause:{chatgpt:Date.now()-1}});
 await b.tick();await flush();
 assert.equal(b.calls.filter(c=>c.action==='take').length,takes+1,'admission resumes after the pause');
});

// Live 2026-09-27: bursts of ~8 reviews + ~6 fixes in 3 min were each followed by ChatGPT ending the
// session (cf_clearance reissued, session cookie deleted), and every later job failed logged_out.
// ChatGPT admission is paced: at most 2 in flight (review and fix together), 45 s between admissions,
// and after a logout nothing is taken until the pause ends, then one probe job at a time.
const offer=(id,kind)=>({jobId:id,provider:'chatgpt',providers:['chatgpt'],prompt:'p',...(kind?{kind}:{})});
const PACED={maxInFlight:2,gapMs:45_000};
async function ticks(b,n=4){for(let i=0;i<n;i++){await b.tick();await flush();}}
const taken=b=>b.calls.filter(c=>c.action==='take').length;

test('ChatGPT pacing: at most 2 jobs in flight, review and fix together; the next waits in the server queue',async()=>{
 const offers=[offer('A'),offer('fix-B','fix'),offer('C')];
 const api=async(_p,body)=>body?.action==='take'?{ok:true,job:offers.shift()??null}:{ok:true,prompt:'p'};
 const b=background({local:storage({origin:'http://bridge',token:'token',chatgptPacing:{maxInFlight:2,gapMs:0}}),api,handler:()=>({ok:false,code:'busy'})});
 await ticks(b,6);
 assert.deepEqual(Object.keys(b.local.state.pendingReviewJobs).sort(),['A','fix-B'],'two in flight, C not taken');
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'chatgpt_in_flight');
 assert.equal(offers.length,1,'C stays queued at the server');
});

test('ChatGPT pacing: a new job is admitted at least 45 s after the previous one',async()=>{
 const offers=[offer('A'),offer('B')];
 const api=async(_p,body)=>body?.action==='take'?{ok:true,job:offers.shift()??null}:{ok:true,prompt:'p'};
 const b=background({local:storage({origin:'http://bridge',token:'token',chatgptPacing:PACED}),api,handler:()=>({ok:false,code:'busy'})});
 await ticks(b);
 assert.deepEqual(Object.keys(b.local.state.pendingReviewJobs),['A']);
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'chatgpt_spacing');
 await b.local.set({chatgptAdmittedAt:Date.now()-46_000});
 await ticks(b,2);
 assert.deepEqual(Object.keys(b.local.state.pendingReviewJobs).sort(),['A','B'],'admitted once 45 s passed');
});

test('ChatGPT pacing: after a logout nothing is taken until the pause ends, then one probe at a time until one succeeds',async()=>{
 const offers=[offer('A'),offer('B'),offer('C'),offer('D')];
 const api=async(_p,body)=>body?.action==='take'?{ok:true,job:offers.shift()??null}:{ok:true,prompt:'p'};
 let mode='logged_out';
 const b=background({local:storage({origin:'http://bridge',token:'token',chatgptPacing:{maxInFlight:2,gapMs:0}}),api,
  handler:(_id,msg)=>msg.type==='ashlar-run'?{ok:false,code:'busy'}:mode==='logged_out'
   ?{ok:false,code:'logged_out',error:'ChatGPT is logged out in this Chrome profile; log in and retry (nothing was typed or sent)'}
   :mode==='ok'?{ok:true,raw:json}:{ok:false,code:'busy'}});
 for(let i=0;i<6 && !b.calls.some(c=>c.action==='failure'&&c.jobId==='A');i++){await b.tick();await flush();}
 assert.ok(b.local.state.loginPause?.chatgpt>Date.now(),'paused');
 assert.ok(Number.isFinite(b.local.state.loginProbe?.chatgpt),'probe mode records the logout time');
 const failedBefore=b.calls.filter(c=>c.action==='failure').length, takesBefore=taken(b);
 await ticks(b);
 assert.equal(taken(b),takesBefore,'nothing is taken while paused');
 assert.equal(b.calls.filter(c=>c.action==='failure').length,failedBefore,'no queued job fails one after another');
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'logged_out');
 // The pause ends: one probe job at a time.
 mode='busy';await b.local.set({loginPause:{chatgpt:Date.now()-1}});
 await ticks(b);
 const inFlight=()=>Object.values(b.local.state.pendingReviewJobs).filter(j=>!j.states.chatgpt.outcome).map(j=>j.jobId);
 assert.equal(inFlight().length,1,`one probe: ${inFlight()}`);
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'login_probe');
 // The probe answers: the login is back, probe mode ends and the queue drains at the normal pace.
 mode='ok';await ticks(b,8);
 assert.equal(b.local.state.loginProbe?.chatgpt,undefined,'probe mode ends on an answer');
 // A and B were both in flight when the logout showed: only they fail; the probe (C) and D answer.
 assert.deepEqual(b.calls.filter(c=>['complete','failure'].includes(c.action)).map(c=>[c.action,c.jobId]),
  [['failure','A'],['failure','B'],['complete','C'],['complete','D']]);
});

test('ChatGPT pacing (#128 review): a leg waiting on the server JSON repair holds no slot; an answer sent before the logout does not end probe mode',async()=>{
 const archived={sourceCapture:{archiveDurable:true,text:'x',totalChars:1,sourceHash:'h',responseId:'r',id:'c'},repairAttempt:{id:'ra',status:'running'},runId:'r1',started:true};
 const waiting=id=>({jobId:id,origin:'http://bridge',providers:['chatgpt'],states:{chatgpt:{...archived}}});
 const offers=[offer('C')];
 const api=async(_p,body)=>body?.action==='take'?{ok:true,job:offers.shift()??null}:{ok:true,prompt:'p',active:true,accepted:true,status:'awaiting_chat'};
 const b=background({local:storage({origin:'http://bridge',token:'token',chatgptPacing:{maxInFlight:2,gapMs:0},pendingReviewJobs:{A:waiting('A'),B:waiting('B')}}),api,handler:()=>({ok:false,code:'busy'})});
 await ticks(b,3);
 assert.ok(b.local.state.pendingReviewJobs.C,`C admitted beside two legs in repair: ${b.local.state.bridgeWorkerStatus?.admissionPhase}`);
 // Probe mode set at a logout; an answer from a job admitted before it keeps probe mode.
 const at=Date.now();
 await b.local.set({loginProbe:{chatgpt:at}});
 await b.context.clearLoginProbe('chatgpt',{admittedAt:at-60_000});
 assert.equal(b.local.state.loginProbe.chatgpt,at,'a pre-logout answer proves nothing');
 await b.context.clearLoginProbe('chatgpt',{admittedAt:at+1});
 assert.equal(b.local.state.loginProbe.chatgpt,undefined,'a post-logout answer ends probe mode');
});

test('the ChatGPT submission log records each admission (kind, temporary chat) and each logout',async()=>{
 const offers=[offer('A'),offer('fix-B','fix')];
 const api=async(_p,body)=>body?.action==='take'?{ok:true,job:offers.shift()??null}:{ok:true,prompt:'p'};
 const b=background({local:storage({origin:'http://bridge',token:'token',chatgptPacing:{maxInFlight:2,gapMs:0}}),api,handler:()=>({ok:false,code:'busy'})});
 await ticks(b,4);
 const log=b.local.state.chatgptSubmitLog;
 assert.deepEqual(log.map(e=>[e.event,e.kind,e.temporary]),[['submit','review',true],['submit','fix',true]]);
 await b.context.markLoggedOut('chatgpt');
 assert.equal(b.local.state.chatgptSubmitLog.at(-1).event,'logged_out');
 await b.context.recordWorkerStatus(b.local.state.pendingReviewJobs,'http://bridge');
 assert.equal(b.local.state.bridgeWorkerStatus.chatgptLog.sinceLogout.review,0,'counted from the logout');
});

// Live aicc #539/#602 (2026-10-01/02): legs sat in send_waiting 57-70+ min holding a ChatGPT slot; Chrome
// had frozen their background tabs and the poll skipped them as frozen. The worker ends a leg whose tab is
// still frozen 17 min after dispatch with no send seen (the page's own send deadline is 15 min).
for(const [name,{ago,sent,frozen=true}] of [['frozen 18 min after dispatch: ended',{ago:18}],['frozen 12 min after dispatch: still waits',{ago:12}],
 ['not frozen 18 min after dispatch: the page answers for itself',{ago:18,frozen:false}],['frozen 18 min, but it sent: not a pre-send stall',{ago:18,sent:true}]]){
 test(`presend watchdog: ${name}`,async()=>{
  const at=Date.now()-ago*60_000;
  const pageEvents=[{source:'page',sequence:1,at:at+1000,stage:'prompt_prepared'},{source:'page',sequence:2,at:at+2000,stage:'send_waiting'},
   ...(sent?[{source:'page',sequence:3,at:at+3000,stage:'send_attempted'}]:[])];
  const job={jobId:'A',origin:'http://bridge',leaseId:'l',providers:['chatgpt'],states:{chatgpt:{tabId:10,started:true,runId:'run-A',runDispatchedAt:at,pageEvents}}};
  const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}),
   tabs:new Map([[10,{id:10,url:'https://chatgpt.com/?temporary-chat=true',status:'complete',active:false,frozen}]]),
   api:async()=>({ok:true,active:true,accepted:true,status:'awaiting_chat'}),handler:()=>({ok:false,code:'busy'})});
  await ticks(b,2);
  const failed=b.calls.find(c=>c.action==='failure'&&c.jobId==='A');
  if(ago>=17&&!sent&&frozen)assert.match(failed?.error||'',/^presend_stalled: the tab was frozen in "send_waiting" for 18 min after dispatch, before its send; nothing was sent/);
  else assert.equal(failed,undefined,JSON.stringify(failed));
 });
}

test('the run message carries the send deadline, 15 min after the first dispatch',async()=>{
 const offers=[offer('A')];const runs=[];
 const api=async(_p,body)=>body?.action==='take'?{ok:true,job:offers.shift()??null}:{ok:true,prompt:'p'};
 const b=background({local:storage({origin:'http://bridge',token:'token',chatgptPacing:{maxInFlight:2,gapMs:0}}),api,
  handler:(_id,msg)=>{if(msg.type==='ashlar-run')runs.push(msg);return {ok:false,code:'busy'};}});
 await ticks(b,3);
 const dispatched=b.local.state.pendingReviewJobs.A.states.chatgpt.runDispatchedAt;
 assert.ok(Number.isFinite(dispatched));
 assert.ok(runs.length>=1);
 assert.equal(runs[0].presendDeadline,dispatched+15*60_000);
});
