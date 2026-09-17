import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appFixture,eventually} from './app-fixture.mjs';
const raw=JSON.stringify({findings:[],investigated_safe:['a.ts: checked "condition"'],merge_recommendation:'COMMENT'});
const original=raw.replace(/\\"/g,'"');
const sourceHash=createHash('sha256').update(original).digest('hex');
async function post(app,body){const res=await fetch(app.origin+'/api/bridge',{method:'POST',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},body:JSON.stringify(body)});return {http:res.status,...await res.json()};}
async function setup(t,settings={}){
 const app=await appFixture({reviewLocal:false,...settings});t.after(()=>app.close());const mention=app.mention();
 await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===mention.jobId)?.status==='awaiting_chat','job not ready');
 const {job}=await post(app,{action:'take',clientId:'fixture'});
 const binding={jobId:job.jobId,leaseId:job.leaseId,provider:'chatgpt',runId:'run-A',responseId:'response-A',sourceHash};
 await post(app,{action:'progress',...binding,progress:{chatgpt:{runId:'run-A',events:[{source:'page',sequence:1,at:Date.now(),stage:'response_completed_json_invalid'}]}}});
 const start=()=>post(app,{action:'repair',...binding,source:{text:original,totalChars:original.length,truncated:false,responseId:'response-A',completed:true,stable:true}});
 return {app,binding,start};
}
const respond=(app,content=raw,index=0)=>app.localResponses[index].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
test('HTTP: completed unparseable reply -> one Local repair -> original provider commit -> one review',async t=>{
 const {app,binding,start}=await setup(t);const out=await start();assert.equal(out.ok,true);assert.equal(out.repair.status,'running');
 await eventually(()=>app.localRequests.length===1,'no repair request');
 assert.equal(JSON.parse(app.localRequests[0].messages[1].content).original,original);assert.equal(app.reviews.length,0);
 for(let i=0;i<3;i++)await start();assert.equal(app.localRequests.length,1);
 respond(app);
 await eventually(async()=> (await post(app,{action:'repair-status',...binding,repairId:out.repair.id})).repair?.status==='ready','candidate not ready');
 assert.equal(app.reviews.length,0,'candidate readiness was treated as result ACK');
 const accepted=await post(app,{action:'repair-commit',...binding,repairId:out.repair.id});assert.equal(accepted.repair.status,'accepted');
 await eventually(()=>app.reviews.length===1,'review not posted');
 await post(app,{action:'repair-commit',...binding,repairId:out.repair.id});assert.equal(app.reviews.length,1);
 const job=app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId);assert.deepEqual(Array.from(job.storedLegs,l=>l.provider),['chatgpt']);assert.equal(job.storedLegs[0].repair.normalizedBy,'local');
 assert.equal(app.history.getJob(binding.jobId,true).responses.chatgpt.original,original);
});
test('HTTP: OFF/new settings inhibit Local without aborting or failing the original job',async t=>{
 const {app,binding,start}=await setup(t,{localJsonRepairEnabled:false});const out=await start();assert.equal(out.repair.status,'disabled');
 assert.equal(app.localRequests.length,0);assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId).status,'awaiting_chat');
 assert.equal((await post(app,{action:'complete',...binding,repairProtocol:1,results:[{provider:'chatgpt',raw}]})).ok,true);
 await eventually(()=>app.reviews.length===1,'normal result stopped by disabled repair');
});
test('HTTP: kill switch during a long queued repair suppresses candidate application, no generation deadline',async t=>{
 const {app,binding,start}=await setup(t);const out=await start();await eventually(()=>app.localRequests.length===1,'no repair');
 app.clock.now+=365*24*3600_000;
 assert.equal((await post(app,{action:'repair-status',...binding,repairId:out.repair.id})).repair.status,'running');
 app.harbor.patchHarborSettings({localJsonRepairEnabled:false});
 assert.equal((await post(app,{action:'repair-status',...binding,repairId:out.repair.id})).repair.status,'disabled');
 assert.equal(app.reviews.length,0);assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId).status,'awaiting_chat');
});
test('HTTP: foreign lease/run/hash and unfinished/truncated source cannot invoke repair',async t=>{
 const {app,binding}=await setup(t);
 const source={text:original,totalChars:original.length,truncated:false,responseId:'response-A',completed:true,stable:true};
 for(const patch of [{leaseId:'foreign'},{runId:'foreign'},{sourceHash:'foreign'},{source:{...source,completed:false}},{source:{...source,truncated:true}},{source:{...source,totalChars:original.length+1}}]){
  const r=await post(app,{action:'repair',...binding,source,...patch});assert.equal(r.ok,false);
 }
 assert.equal(app.localRequests.length,0);
});
test('HTTP: a normal result supersedes pending repair; late candidate never changes its provider result',async t=>{
 const {app,binding,start}=await setup(t);const out=await start();await eventually(()=>app.localRequests.length===1,'no repair');
 await post(app,{action:'complete',...binding,results:[{provider:'chatgpt',raw}]});await eventually(()=>app.reviews.length===1,'normal review not posted');respond(app);
 assert.equal((await post(app,{action:'repair-status',...binding,repairId:out.repair.id})).repair.status,'superseded');assert.equal(app.reviews.length,1);
});
test('HTTP: syntactically valid but malformed finding schema reaches repair instead of silent finding loss',async t=>{
 const {app,binding}=await setup(t);const invalid=JSON.stringify({findings:[{severity:'P1',file:'a.ts',line:1,title:'Bug'}]});
 const out=await post(app,{action:'complete',...binding,repairProtocol:1,results:[{provider:'chatgpt',raw:invalid,originalText:invalid}]});
 assert.equal(out.http,422);assert.equal(out.code,'json_repair_required');assert.equal(app.reviews.length,0);assert.equal(app.localRequests.length,0);
});
test('HTTP: archive failures do not authorize invocation or repaired-response ACK',async t=>{
 const {app,start}=await setup(t);app.history.putRepair=()=>{throw Error('disk failure');};assert.equal((await start()).http,503);assert.equal(app.localRequests.length,0);assert.equal(app.reviews.length,0);
});

test('HTTP: changing reviewLocal never gates, cancels or adds a review to the formatter request',async t=>{
 const {app,binding,start}=await setup(t,{reviewLocal:false});const out=await start();await eventually(()=>app.localRequests.length===1,'no formatter');
 for (const reviewLocal of [true,false]) {
  app.harbor.patchHarborSettings({reviewLocal});
  assert.equal((await post(app,{action:'repair-status',...binding,repairId:out.repair.id})).repair.status,'running');
  assert.equal(app.localRequests.length,1);
 }
 respond(app);await eventually(async()=>(await post(app,{action:'repair-status',...binding,repairId:out.repair.id})).repair.status==='ready','not ready');
 await post(app,{action:'repair-commit',...binding,repairId:out.repair.id});await eventually(()=>app.reviews.length===1,'not posted');
 assert.equal(app.localRequests.length,1);assert.deepEqual(Array.from(app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId).storedLegs,l=>l.provider),['chatgpt']);
});

test('HTTP: candidate commit waits for response archive recovery without another Local request',async t=>{
 const {app,binding,start}=await setup(t);const out=await start();await eventually(()=>app.localRequests.length===1,'not started');respond(app);
 await eventually(async()=>(await post(app,{action:'repair-status',...binding,repairId:out.repair.id})).repair.status==='ready','not ready');
 const save=app.history.recordResponse.bind(app.history);app.history.recordResponse=()=>{throw Error('disk full');};
 assert.equal((await post(app,{action:'repair-commit',...binding,repairId:out.repair.id})).repair.status,'ready');
 assert.equal(app.reviews.length,0);app.history.recordResponse=save;
 assert.equal((await post(app,{action:'repair-commit',...binding,repairId:out.repair.id})).repair.status,'accepted');
 await eventually(()=>app.reviews.length===1,'not posted');assert.equal(app.localRequests.length,1);
});

for(const error of ['tab_closed','cancelled','quota','empty','error'])for(const phase of ['running','ready'])
 test(`HTTP: terminal ${error} fences ${phase} repair without cancelling pending Grok`,async t=>{
  const {app,binding,start}=await setup(t,{reviewGrok:true});
  const out=await start();await eventually(()=>app.localRequests.length===1,'repair not started');
  const request=action=>post(app,{action,...binding,repairId:out.repair.id});
  if(phase==='ready'){respond(app);await eventually(async()=>(await request('repair-status')).repair.status==='ready','not ready');}
  assert.equal((await post(app,{action:'failure',...binding,error:`${error}: explicit provider outcome`})).ok,true);
  const live=()=>app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId);
  assert.equal(live().status,'awaiting_chat');
  assert.equal(app.history.getRepair(binding.jobId,out.repair.id).status,'superseded','provider failure did not retire its pending repair');
  if(phase==='running')respond(app); // Simulate late HTTP completion; never applied.
  const committed=await request('repair-commit');
  assert.equal(committed.repair.status,'superseded');
  assert.equal(live().providerErrors.chatgpt.code,error);
  assert.equal(live().storedLegs?.some(leg=>leg.provider==='chatgpt')||false,false);
  assert.equal(live().providerErrors.grok,undefined);
  assert.equal((await start()).repair.status,'superseded');
  assert.equal(app.localRequests.length,1);assert.equal(app.reviews.length,0);
 });
test('HTTP: transient disconnected ping does not fence formatting recovery',async t=>{
 const {app,binding,start}=await setup(t,{reviewGrok:true});const out=await start();await eventually(()=>app.localRequests.length===1,'not started');respond(app);
 const request=action=>post(app,{action,...binding,repairId:out.repair.id});
 await eventually(async()=>(await request('repair-status')).repair.status==='ready','not ready');
 assert.equal((await post(app,{action:'ping',...binding,providerErrors:{chatgpt:{code:'disconnected',message:'temporary connection outage'}}})).accepted,true);
 assert.equal((await request('repair-commit')).repair.status,'accepted');
 const live=app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId);
 assert.equal(live.storedLegs.find(leg=>leg.provider==='chatgpt').raw,raw);assert.equal(live.providerErrors.chatgpt,undefined);
 assert.equal(app.localRequests.length,1);assert.equal(app.reviews.length,0,'pending Grok must not be skipped');
});
test('HTTP: persisted terminal outcome also rejects ready repair when cancellation registry was lost',async t=>{
 const {app,binding,start}=await setup(t,{reviewGrok:true});const out=await start();await eventually(()=>app.localRequests.length===1,'not started');respond(app);
 const request=action=>post(app,{action,...binding,repairId:out.repair.id});
 await eventually(async()=>(await request('repair-status')).repair.status==='ready','not ready');
 app.harbor.patchHarborJob(binding.jobId,job=>({...job,providerErrors:{chatgpt:{code:'tab_closed',message:'recorded terminal outcome'}}}));
 assert.equal((await request('repair-commit')).repair.status,'superseded');
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId).storedLegs?.length||0,0);assert.equal(app.localRequests.length,1);
});
test('HTTP: terminating ChatGPT repair leaves the ready Grok repair usable',async t=>{
 const {app,binding,start}=await setup(t,{reviewGrok:true});const a=await start();
 const grok={...binding,provider:'grok',runId:'run-Grok',responseId:'response-Grok'};
 assert.equal((await post(app,{action:'progress',...grok,progress:{grok:{runId:grok.runId,events:[{source:'page',sequence:1,at:Date.now(),stage:'response_completed_json_invalid'}]}}})).ok,true);
 const b=await post(app,{action:'repair',...grok,source:{text:original,totalChars:original.length,truncated:false,responseId:grok.responseId,completed:true,stable:true}});
 await eventually(()=>app.localRequests.length===2,'parallel repairs not started');respond(app,raw,0);respond(app,raw,1);
 const get=(identity,id,action='repair-status')=>post(app,{action,...identity,repairId:id});
 await eventually(async()=>(await get(binding,a.repair.id)).repair.status==='ready' && (await get(grok,b.repair.id)).repair.status==='ready','both candidates not ready');
 assert.equal((await post(app,{action:'failure',...binding,error:'tab_closed: explicitly closed'})).ok,true);
 assert.equal((await get(binding,a.repair.id)).repair.status,'superseded');assert.equal((await get(grok,b.repair.id)).repair.status,'ready');
 assert.equal((await get(grok,b.repair.id,'repair-commit')).repair.status,'accepted');
 await eventually(()=>app.reviews.length===1,'remaining reviewer did not post');
 const job=app.harbor.getHarbor().jobs.find(j=>j.id===binding.jobId);
 assert.deepEqual(Array.from(job.storedLegs,leg=>leg.provider),['grok']);assert.equal(job.providerErrors.chatgpt.code,'tab_closed');assert.equal(app.localRequests.length,2);
});
