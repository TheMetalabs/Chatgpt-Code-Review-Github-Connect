// Live 1.1.62 (aicc jobs 629, 648, 649, 657, 662, 663): a Grok leg sat in waiting_for_response 40-73 min.
// The page's own wait (35 min) cannot run in a frozen tab, the poll skipped frozen tabs, and the page
// credits poll gaps back to its wait; the worker had no bound for a leg that had sent.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {background,storage,flush} from './helpers.mjs';

async function ticks(b,n=2){for(let i=0;i<n;i++){await b.tick();await flush();}}
const MIN=60_000;
const GROK='https://grok.com/';
function grokLeg(sentAgo,{provider='grok',extra={}}={}){
 const at=Date.now()-sentAgo*MIN;
 const pageEvents=[{source:'page',sequence:1,at:at-2000,stage:'send_waiting'},{source:'page',sequence:2,at,stage:'send_attempted'},
  {source:'page',sequence:3,at:at+1000,stage:'waiting_for_response'}];
 return {jobId:'A',origin:'http://bridge',leaseId:'l',providers:[provider],states:{[provider]:{tabId:10,started:true,runId:'run-A',runDispatchedAt:at-5000,pageEvents,...extra}}};
}
const rig=(job,{frozen=false,handler=()=>({ok:false,code:'busy'}),provider='grok'}={})=>background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}),
 tabs:new Map([[10,{id:10,url:provider==='grok'?GROK:'https://chatgpt.com/?temporary-chat=true',status:'complete',active:false,frozen}]]),
 api:async()=>({ok:true,active:true,accepted:true,status:'awaiting_chat'}),handler});
const failure=b=>b.calls.find(c=>c.action==='failure'&&c.jobId==='A');

test('a Grok leg with no answer 31 min after its send ends as response_timeout, whatever the tab does',async()=>{
 for(const frozen of [false,true]){
  const b=rig(grokLeg(31),{frozen});
  await ticks(b);
  assert.match(failure(b)?.error||'',/^response_timeout: no answer was collected 31 min after the prompt was sent \(grok cap 30 min\)/,`frozen=${frozen}`);
 }
});
test('a Grok leg 25 min after its send keeps waiting',async()=>{
 const b=rig(grokLeg(25));
 await ticks(b);
 assert.equal(failure(b),undefined);
});
test('a ChatGPT leg is not capped by the Grok bound',async()=>{
 const b=rig(grokLeg(45,{provider:'chatgpt'}),{provider:'chatgpt'});
 await ticks(b);
 assert.equal(failure(b),undefined,JSON.stringify(failure(b)));
});
test('a frozen sent tab is polled once every 3 min, which wakes its page; an unsent one is not',async()=>{
 const b=rig(grokLeg(10),{frozen:true});
 await ticks(b);
 assert.equal(b.messages.filter(m=>m.type==='ashlar-harvest').length,1,'the first tick pokes the frozen tab');
 await ticks(b);
 assert.equal(b.messages.filter(m=>m.type==='ashlar-harvest').length,1,'the next tick within 3 min does not');
 const unsent=grokLeg(10);unsent.states.grok.pageEvents=[{source:'page',sequence:1,at:Date.now()-MIN,stage:'send_waiting'}];
 const c=rig(unsent,{frozen:true});
 await ticks(c);
 assert.deepEqual(c.messages.filter(m=>m.type==='ashlar-harvest'),[],'a leg that has not sent is left to the pre-send watchdog');
});
test('a frozen tab that does not answer its poke is not reported as a lost binding',async()=>{
 const b=rig(grokLeg(10),{frozen:true,handler:()=>{throw new Error('no receiver');}});
 await ticks(b);
 assert.equal(b.local.state.pendingReviewJobs.A.states.grok.connectionError,undefined);
 assert.equal(b.local.state.pendingReviewJobs.A.states.grok.workerEvents?.some(e=>e.stage==='disconnected')??false,false);
});
test('legs the server ended are abandoned inside the tab queue, and only if still open',async()=>{
 const job=grokLeg(10);
 const b=rig(job,{handler:()=>({ok:false,code:'busy'})});
 b.context.api=async(_p,body)=>body?.action==='ping'?{ok:true,active:true,accepted:true,status:'awaiting_chat',endedProviders:['grok']}:{ok:true};
 await ticks(b);
 const state=b.local.state.pendingReviewJobs.A?.states.grok;
 assert.ok(state?.abandoned===true&&state.abandonedAs==='ended',JSON.stringify(state));
 assert.equal(b.queue.overlapped,false);
});

// Review of #159: the cap asks the page once before ending the leg, and does not count unwatched time.
test('at the cap the page is asked once; an answer or verdict it gives goes to the ordinary harvest',async()=>{
 for(const frozen of [false,true]){
  const b=rig(grokLeg(31),{frozen,handler:()=>({ok:false,code:'logged_out',error:'logged out'})});
  await ticks(b);
  assert.ok(b.messages.some(m=>m.type==='ashlar-harvest'),`frozen=${frozen}: the page was asked`);
  assert.doesNotMatch(failure(b)?.error||'',/response_timeout/,`frozen=${frozen}`);
 }
});
test('a page that is still busy at the cap does not save the leg',async()=>{
 const b=rig(grokLeg(31));
 await ticks(b);
 assert.ok(b.messages.some(m=>m.type==='ashlar-harvest'));
 assert.match(failure(b)?.error||'',/^response_timeout/);
});
test('time the worker was away is not counted against the cap',async()=>{
 const away=rig(grokLeg(31,{extra:{lastPollAt:Date.now()-20*MIN}}));
 await ticks(away);
 assert.equal(failure(away),undefined,'a 20 min poll gap credits 16 min back: 15 min watched');
 const credited=rig(grokLeg(40,{extra:{postsendSlackMs:15*MIN}}));
 await ticks(credited);
 assert.equal(failure(credited),undefined,'credit carried over from earlier gaps');
 const watched=rig(grokLeg(31,{extra:{lastPollAt:Date.now()-3*MIN}}));
 await ticks(watched);
 assert.match(failure(watched)?.error||'',/^response_timeout/,'ordinary poll cadence is not a gap');
});

test('a frozen Grok page result persisted after response_collected is ingested without a page reply', async () => {
 const raw = JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['fixture']});
 const key = 'ashlar:result:A:grok:run-A';
 const b = background({
  local: storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:grokLeg(10)}}),
  session: storage({[key]: {jobId:'A',provider:'grok',runId:'run-A',raw,responseText:'original'}}),
  tabs: new Map([[10,{id:10,url:GROK,status:'complete',active:false,frozen:true}]]),
  handler: () => { throw new Error('frozen page cannot answer'); },
  api: async () => ({ok:true,active:true,accepted:true,status:'awaiting_chat'}),
 });
 await ticks(b);
 const state = b.local.state.pendingReviewJobs.A.states.grok;
 assert.equal(state.outcome?.raw, raw);
 assert.equal((await b.session.get([key]))[key], undefined);
 assert.equal(b.calls.some(call => call.action === 'complete' && call.results?.some(result => result.provider === 'grok')), true);
});

test('a closed tab wins over a persisted receipt', async () => {
 const raw = JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['closed']});
 const key = 'ashlar:result:A:grok:run-A';
 const b = background({
  local: storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:grokLeg(10)}}),
  session: storage({[`ashlar:closed:A:grok:run-A`]: true, [key]: {jobId:'A',provider:'grok',runId:'run-A',raw,responseText:'closed'}}),
  tabs: new Map([[10,{id:10,url:GROK,status:'complete',active:false,frozen:true}]]),
  handler: () => { throw new Error('closed page cannot answer'); },
  api: async () => ({ok:true,active:true,accepted:true,status:'awaiting_chat'}),
 });
 await ticks(b);
 const failure = b.calls.find(call => call.action === 'failure');
 assert.match(failure?.error || '', /^tab_closed:/);
 assert.equal(b.calls.some(call => call.action === 'complete'), false);
 assert.equal((await b.session.get([key]))[key], undefined);
});

test('a late close marker preserves a durably harvested success', async () => {
 const raw = JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['harvested']});
 const job = grokLeg(10);
 job.states.grok.outcome = {ok:true,raw,responseText:'harvested'};
 const b = background({
  local: storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}),
  session: storage({
   'ashlar:closed:A:grok:run-A': true,
   'ashlar:result:A:grok:run-A': {jobId:'A',provider:'grok',runId:'run-A',raw:'late',responseText:'late'},
  }),
  tabs: new Map([[10,{id:10,url:GROK,status:'complete',active:false,frozen:true}]]),
  handler: () => { throw new Error('closed page cannot answer'); },
  api: async () => ({ok:true,active:true,accepted:true,status:'awaiting_chat'}),
 });
 await ticks(b);
 const complete = b.calls.find(call => call.action === 'complete');
 assert.equal(complete?.raw, raw);
 assert.equal(b.calls.some(call => call.action === 'failure'), false);
 assert.equal(complete?.results?.some(result => result.provider === 'grok'), true);
 assert.equal((await b.session.get(['ashlar:result:A:grok:run-A']))['ashlar:result:A:grok:run-A'], undefined);
});

test('a closed receipt is retained until its terminal outcome is persisted', async () => {
 const key = 'ashlar:result:A:grok:run-A';
 const job = grokLeg(10), jobs = {A:job};
 const b = background({session:storage({'ashlar:closed:A:grok:run-A':true,
  [key]:{jobId:'A',provider:'grok',runId:'run-A',raw:'receipt'}})});
 const set = b.local.set;
 b.local.set = async values => {if (values.pendingReviewJobs) throw new Error('storage unavailable');return set(values);};
 await assert.rejects(b.context.settleClosedTab(job,'grok',jobs), /storage unavailable/);
 assert.equal((await b.session.get([key]))[key].raw,'receipt');
 b.local.set = set;
 await b.context.settleClosedTab(job,'grok',jobs);
 assert.equal(b.local.state.pendingReviewJobs.A.states.grok.outcome?.code,'tab_closed');
 assert.equal((await b.session.get([key]))[key],undefined);
});

test('a fix receipt without owned proof is ignored', async () => {
 const raw = JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['fix']});
 const key = 'ashlar:result:A:grok:run-A';
 const job = grokLeg(31); job.kind = 'fix';
 const b = background({
  local: storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}),
  session: storage({[key]: {jobId:'A',provider:'grok',runId:'run-A',raw,responseText:'fix',ownership:'takenOver'}}),
  tabs: new Map([[10,{id:10,url:GROK,status:'complete',active:false,frozen:true}]]),
  handler: () => { throw new Error('frozen page cannot answer'); },
  api: async () => ({ok:true,active:true,accepted:true,status:'awaiting_chat'}),
 });
 await ticks(b);
 assert.equal((await b.session.get([key]))[key].ownership, 'takenOver');
 assert.equal(b.calls.some(call => call.action === 'complete'), false);
});

test('a receipt written after the timeout save replaces that timeout on the next tick', async () => {
 const raw = JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['late receipt']});
 const b = rig(grokLeg(31), {frozen:true, handler:()=>{throw new Error('frozen page cannot answer');}});
 await b.tick();
 assert.equal(b.local.state.pendingReviewJobs.A.states.grok.outcome?.code, 'response_timeout');
 await b.session.set({'ashlar:result:A:grok:run-A': {jobId:'A',provider:'grok',runId:'run-A',raw,responseText:'late',at:Date.now()}});
 await b.tick();
 const state = b.local.state.pendingReviewJobs.A.states.grok;
 assert.equal(state.outcome?.raw, raw);
 assert.equal(b.calls.some(call => call.action === 'complete' && call.results?.some(result => result.provider === 'grok')), true);
});

test('a stale receipt cannot overwrite an already durable success', async () => {
 const raw = JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['durable']});
 const job = grokLeg(10);
 job.states.grok.outcome = {ok:true,raw,responseText:'durable'};
 const key = 'ashlar:result:A:grok:run-A';
 const b = background({
  local: storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}),
  session: storage({[key]: {jobId:'A',provider:'grok',runId:'run-A',raw:'stale',responseText:'stale',at:Date.now()-MIN}}),
  tabs: new Map([[10,{id:10,url:GROK,status:'complete',active:false,frozen:true}]]),
  handler: () => { throw new Error('frozen page cannot answer'); },
  api: async () => ({ok:true,active:true,accepted:true,status:'awaiting_chat'}),
 });
 await ticks(b);
 const state = b.local.state.pendingReviewJobs.A.states.grok;
 assert.equal(state.outcome.raw, raw);
 assert.equal(b.calls.some(call => call.action === 'failure'), false);
 assert.equal((await b.session.get([key]))[key], undefined);
});

test('a receipt older than response_collected cannot replace a timeout outcome', async () => {
 const job = grokLeg(10);
 const collectedAt = Date.now();
 job.states.grok.outcome = {ok:false,code:'response_timeout',error:'old timeout'};
 job.states.grok.workerEvents = [{source:'worker',sequence:1,stage:'response_collected',at:collectedAt}];
 const key = 'ashlar:result:A:grok:run-A';
 const b = background({
  local: storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}),
  session: storage({[key]: {jobId:'A',provider:'grok',runId:'run-A',raw:'stale',responseText:'stale',at:collectedAt-1}}),
  tabs: new Map([[10,{id:10,url:GROK,status:'complete',active:false,frozen:true}]]),
  handler: () => { throw new Error('frozen page cannot answer'); },
  api: async () => ({ok:true,active:true,accepted:true,status:'awaiting_chat'}),
 });
 await ticks(b);
 const state = b.local.state.pendingReviewJobs.A.states.grok;
 assert.equal(state.outcome.code, 'response_timeout');
 assert.equal(state.outcome.raw, undefined);
 assert.equal((await b.session.get([key]))[key], undefined);
});

test('the postsend watchdog rejects a receipt older than the final response probe', async () => {
 const job = grokLeg(31);
 const key = 'ashlar:result:A:grok:run-A';
 const collectedAt = Date.now();
 const progress = [...job.states.grok.pageEvents, {source:'page',sequence:4,stage:'response_collected',at:collectedAt}];
 const session = storage();
 const b = background({
  local: storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}), session,
  tabs: new Map([[10,{id:10,url:GROK,status:'complete',active:false,frozen:false}]]),
  handler: (_id,msg) => {
   if (msg.type === 'ashlar-harvest') {
    session.set({[key]: {jobId:'A',provider:'grok',runId:'run-A',raw:'stale',responseText:'stale',at:collectedAt-1}});
    return {ok:false,code:'busy',jobId:'A',provider:'grok',runId:'run-A',progress:{runId:'run-A',events:progress}};
   }
   return {ok:false,code:'busy'};
  },
  api: async () => ({ok:true,active:true,accepted:true,status:'awaiting_chat'}),
 });
 await ticks(b, 2);
 const state = b.local.state.pendingReviewJobs.A.states.grok;
 assert.equal(state.outcome?.code, 'response_timeout');
 assert.equal(state.outcome?.raw, undefined);
 assert.equal((await b.session.get([key]))[key], undefined);
});

test('a receipt for another run is ignored after a timeout', async () => {
 const b = rig(grokLeg(31), {frozen:true, handler:()=>{throw new Error('frozen page cannot answer');}});
 await b.tick();
 await b.session.set({'ashlar:result:A:grok:run-A': {jobId:'A',provider:'grok',runId:'run-other',raw:'wrong'}});
 await b.tick();
 const state = b.local.state.pendingReviewJobs.A.states.grok;
 assert.equal(state.outcome?.code, 'response_timeout');
 assert.equal(state.outcome?.raw, undefined);
});
