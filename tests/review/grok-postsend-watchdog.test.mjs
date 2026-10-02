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
