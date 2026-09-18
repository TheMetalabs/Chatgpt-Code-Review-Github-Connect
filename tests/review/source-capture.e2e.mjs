import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appFixture,eventually} from './app-fixture.mjs';
const original='{"findings":[],"investigated_safe":["checked "literal""]}';
const digest=s=>createHash('sha256').update(s).digest('hex');
async function setup(t,options={}){
 const app=await appFixture({reviewLocal:false,localJsonRepairEnabled:false,...options});t.after(()=>app.close());
 const mention=app.mention();await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===mention.jobId)?.status==='awaiting_chat','no job');
 const post=async body=>{const res=await fetch(app.origin+'/api/bridge',{method:'POST',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},body:JSON.stringify(body)});return {http:res.status,...await res.json()};};
 const {job}=await post({action:'take',clientId:'capture-fixture'});
 await post({action:'progress',jobId:job.jobId,leaseId:job.leaseId,progress:{chatgpt:{runId:'run-A',events:[{source:'page',sequence:1,stage:'response_completed_json_invalid',at:Date.now()}]}}});
 const body={action:'capture',jobId:job.jobId,leaseId:job.leaseId,provider:'chatgpt',runId:'run-A',responseId:'response-A',sourceHash:digest(original),source:{text:original,totalChars:original.length,truncated:false,completed:true,stable:true,responseId:'response-A'}};
 return {app,post,job,body};
}
test('full completed source capture is durable, private, idempotent and NOT a review completion',async t=>{
 const f=await setup(t);const out=await f.post(f.body);assert.equal(out.http,200);assert.equal(out.capture.sourceHash,digest(original));
 assert.equal(f.app.harbor.getHarbor().jobs.find(j=>j.id===f.job.jobId).status,'awaiting_chat');
 assert.equal(f.app.localRequests.length,0);assert.equal(f.app.reviews.length,0);
 assert.equal((await f.post(f.body)).capture.id,out.capture.id);
 const detail=f.app.history.getJob(f.job.jobId,true);assert.equal(detail.captures[0].text,original);
 assert.equal(JSON.stringify(f.app.history.getJob(f.job.jobId)).includes('checked'),false);
});
test('capture rejects foreign runs, missing completion and changed hash without granting receipt',async t=>{
 const f=await setup(t);
 for(const patch of [{runId:'foreign'},{sourceHash:'0'.repeat(64)},{source:{...f.body.source,stable:false}},{source:{...f.body.source,truncated:true}}]){
  const out=await f.post({...f.body,...patch});assert.equal(out.ok,false);assert.equal(out.capture,undefined);
 }
 assert.equal(f.app.localRequests.length,0);
});
test('failed source archive never grants a capture receipt',async t=>{
 const f=await setup(t);f.app.history.putCapture=()=>{throw Error('disk unavailable');};
 const out=await f.post(f.body);assert.equal(out.http,503);assert.equal(out.capture,undefined);
});
test('repair can start from a confirmed archived source with no current page stage',async t=>{
 const f=await setup(t,{localJsonRepairEnabled:true});const capture=await f.post(f.body);assert.equal(capture.http,200);
 await f.post({action:'progress',jobId:f.job.jobId,leaseId:f.job.leaseId,progress:{chatgpt:{runId:'run-A',events:[{source:'worker',sequence:1,stage:'tab_closed',at:Date.now()}]}}});
 const out=await f.post({...f.body,action:'repair',source:{...f.body.source,captureId:capture.capture.id}});
 assert.equal(out.http,200);await eventually(()=>f.app.localRequests.length===1,'formatter not called');
 assert.equal(JSON.parse(f.app.localRequests[0].messages[1].content).original,original);
});

test('full source reads require the same capture identity and stay outside public metadata',async t=>{
 const f=await setup(t);const out=await f.post(f.body);
 const request={...f.body,action:'capture-read',captureId:out.capture.id};delete request.source;
 const read=await f.post(request);assert.equal(read.http,200);assert.equal(read.capture.text,original);
 assert.equal((await f.post({...request,responseId:'another'})).http,409);
 assert.equal((await f.post({...request,captureId:'../unrelated'})).http,409);
});

test('heartbeat reports a capacity block without claiming progress or exposing originals',async t=>{
 const f=await setup(t);
 const report={checkedAt:Date.now(),admissionPhase:'tab_capacity',activeJobs:4,pendingCleanup:2,sourceCaptured:3,
  capacity:{limit:4,used:4,managedTabs:4,reserved:0,restorationReserved:0,providerTabs:7,unverifiedTabs:0,blockers:[{text:'DO NOT LEAK'}]}};
 const out=await f.post({action:'ping',extensionVersion:'1.1.21',workerStatus:report});
 assert.equal(out.bridge.connected,true);assert.equal(out.bridge.workerStatusFresh,true);
 assert.equal(out.bridge.workerStatus.admissionPhase,'tab_capacity');assert.equal(out.bridge.workerStatus.capacity.used,4);
 assert.equal(JSON.stringify(out).includes('DO NOT LEAK'),false);
 assert.equal(f.app.localRequests.length,0);
 const old=await f.post({action:'ping',extensionVersion:'1.1.21',workerStatus:{...report,checkedAt:Date.now()-86_400_000}});
 assert.equal(old.bridge.connected,true);
 assert.equal(old.bridge.workerStatusFresh,true,'client wall-clock age is informational; a newly received observation starts its server freshness window');
});

test('recovery-only claim returns an existing bound run without admitting unrelated queued work',async t=>{
 const f=await setup(t);
 const request={action:'recover',clientId:'capture-fixture',bindings:[{jobId:f.job.jobId,provider:'chatgpt',runId:'run-A'}]};
 const out=await f.post(request);
 assert.equal(out.http,200);assert.equal(out.job.jobId,f.job.jobId);assert.equal(out.job.leaseId,f.job.leaseId);
 assert.deepEqual(out.job.resumeProviders,['chatgpt']);assert.deepEqual(out.job.bindings,request.bindings);
 for(const patch of [{clientId:'other-profile'},{bindings:[{...request.bindings[0],runId:'wrong'}]}]){
  const rejected=await f.post({...request,...patch});assert.equal(rejected.job,null);
 }
 assert.equal(f.app.localRequests.length,0);assert.equal(f.app.reviews.length,0);
});

test('capture requires positive current completion and cannot replace an already final provider',async t=>{
 const f=await setup(t);
 await f.post({action:'progress',jobId:f.job.jobId,leaseId:f.job.leaseId,progress:{chatgpt:{runId:'run-A',events:[{source:'page',sequence:2,stage:'generating',at:Date.now()+1}]}}});
 assert.equal((await f.post(f.body)).http,409);
 await f.post({action:'progress',jobId:f.job.jobId,leaseId:f.job.leaseId,progress:{chatgpt:{runId:'run-A',events:[{source:'page',sequence:3,stage:'response_completed_json_invalid',at:Date.now()+2}]}}});
 await f.post({action:'failure',jobId:f.job.jobId,leaseId:f.job.leaseId,provider:'chatgpt',error:'tab_closed: explicitly closed'});
 assert.equal((await f.post(f.body)).http,409);assert.equal(f.app.localRequests.length,0);
});

test('captured sources remain protected behind the history read token',async t=>{
 const f=await setup(t);await f.post(f.body);
 const read=token=>fetch(`${f.app.origin}/api/history?jobId=${encodeURIComponent(f.job.jobId)}&responses=1`,{headers:token?{'x-ashlar-history-token':token}:{}});
 assert.equal((await read()).status,401);assert.equal((await read('fixture-token')).status,401);
 const response=await read('fixture-history-token-32-characters-long');assert.equal(response.status,200);
 assert.equal((await response.json()).record.captures[0].text,original);
});
