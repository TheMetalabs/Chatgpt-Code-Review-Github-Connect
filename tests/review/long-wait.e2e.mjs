// Production bridge/Harbor/Local HTTP paths. GitHub and model responses are controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';
import {json} from './load-source.mjs';
const envelope=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});

test('HTTP result receipt does not wait for slow GitHub posting; duplicate receipt posts once',async t=>{
 let release,entered=false;const hold=new Promise(resolve=>{release=resolve;});
 const app=await appFixture({reviewLocal:false},{beforeReview:async()=>{entered=true;await hold;}});
 t.after(()=>{release();return app.close();});
 const submitted=app.mention('ack-decoupling');await eventually(()=>app.bridge.nextBridgeJob(),'job did not become available');
 const task=app.bridge.takeNextBridgeJob('fixture');assert.equal(task.jobId,submitted.jobId);
 const body={action:'complete',jobId:task.jobId,leaseId:task.leaseId,raw:json,results:[{provider:'chatgpt',raw:json}]};
 const send=()=>fetch(app.origin+'/api/bridge',{method:'POST',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},body:JSON.stringify(body)});
 let ack;const response=send().then(async res=>{ack=await res.json();return res;});
 await eventually(()=>entered,'posting did not start');
 await eventually(()=>ack?.ok===true,'receipt still waits for blocked publication');
 assert.equal((await response).status,200);assert.equal(app.reviews.length,0);
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===task.jobId).storedLegs[0].raw,json);
 assert.equal((await send()).status,200);assert.equal(app.reviews.length,0);
 release();await eventually(()=>app.reviews.length===1,'review did not finish');
 assert.equal(app.reviews.length,1);
});

test('Local generation waits across eight-hour queue and body gaps, then produces exactly one result',async t=>{
 const app=await appFixture({reviewChatgpt:false});t.after(()=>app.close());const started=app.mention('local-indefinite');
 await eventually(()=>app.localRequests.length===1,'local request did not start');
 app.clock.now+=8*3600_000;
 let job=app.harbor.getHarbor().jobs.find(j=>j.id===started.jobId);
 assert.equal(job.status,'awaiting_chat');assert.equal(job.generating.local,true);assert.equal(job.storedLegs.length,0);
 app.localResponses[0].writeHead(200,{'content-type':'application/json'});app.localResponses[0].write('{"choices":');
 app.clock.now+=8*3600_000;
 job=app.harbor.getHarbor().jobs.find(j=>j.id===started.jobId);
 assert.equal(job.status,'awaiting_chat');assert.equal(app.reviews.length,0);assert.equal(app.localRequests.length,1);
 app.localResponses[0].end(envelope(json).slice('{"choices":'.length));
 await eventually(()=>app.reviews.length===1,'Local final review was not posted');
 assert.equal(app.localRequests.length,1);
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===started.jobId).status,'posted');
});
