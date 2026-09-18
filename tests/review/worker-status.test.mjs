import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadTs,root} from './load-source.mjs';
import {background,storage} from './helpers.mjs';
const load=()=>{assert.ok(existsSync(resolve(root,'src/lib/bridge-worker-status.ts')),'admission telemetry module absent');return loadTs('src/lib/bridge-worker-status.ts');};
test('worker telemetry is an allowlist and cannot publish raw content or tokens',()=>{
 const {sanitizeWorkerStatus,workerStatusLabel}=load();
 const out=sanitizeWorkerStatus({checkedAt:10,admissionPhase:'tab_capacity',activeJobs:4,pendingCleanup:2,sourceCaptured:1,
  capacity:{limit:4,used:4,providerTabs:7,managedTabs:4,reserved:0,restorationReserved:0,unverifiedTabs:0,blockers:[{text:'PRIVATE'}]},token:'SECRET',text:'PRIVATE'},'1.1.21',100);
 assert.equal(out.capacity.used,4);assert.equal(out.receivedAt,100);assert.equal(JSON.stringify(out).includes('PRIVATE'),false);assert.equal(JSON.stringify(out).includes('SECRET'),false);
 assert.match(workerStatusLabel(out,true),/4\/4/);assert.match(workerStatusLabel(out,false),/last report/i);
});
test('malformed or absent capacity is unknown, not a healthy zero-slot report',()=>{
 const {sanitizeWorkerStatus}=load();assert.equal(sanitizeWorkerStatus(null,'1.1.21',10),undefined);
 assert.equal(sanitizeWorkerStatus({checkedAt:10,admissionPhase:'tab_capacity',capacity:{limit:4,used:-1}},'1.1.21',10),undefined);
});


test('archived-only source is backlog, not an active browser review',async()=>{
 const job={jobId:'A',origin:'http://bridge',providers:['chatgpt'],states:{chatgpt:{
  started:true,runId:'run-A',delivered:false,cleanupDone:true,
  sourceCapture:{id:'capture-A',confirmed:true,sourceHash:'hash',responseId:'response-A'}
 }}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:job}}),tabs:new Map()});
 await b.context.recordWorkerStatus({A:job},'http://bridge');
 const status=b.local.state.bridgeWorkerStatus;
 assert.equal(status.activeJobs,0);
 assert.notEqual(status.phase,'reviewing');
 assert.equal(status.sourceCaptured,1);
});
