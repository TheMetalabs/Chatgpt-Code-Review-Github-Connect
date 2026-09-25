import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';
async function post(app,body) {const r=await fetch(app.origin+'/api/bridge',{method:'POST',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};}
async function ready(app) {const out=app.mention();await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId)?.status==='awaiting_chat','not ready');const claim=await post(app,{action:'take',clientId:'browser'});return claim.job;}
test('observability: non-mention comments are delivery events, not review jobs',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const out=app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'ordinary',event:'issue_comment',payload:{action:'created',repository:{full_name:'fixture/fixture'},issue:{number:1,pull_request:{}},sender:{login:'operator'},comment:{id:7,body:'ordinary discussion'}}});
 assert.equal(out.queued,false);assert.equal(app.harbor.getHarbor().jobs.length,0);
 assert.equal(app.history.listDeliveries({}).items[0].commentId,7);
});
test('observability: trace endpoint rejects a foreign lease and accepts bound submission evidence',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());const job=await ready(app);
 const progress={chatgpt:{runId:'run-A',events:[{source:'page',sequence:1,stage:'send_unconfirmed',at:Date.now()}]}};
 assert.equal((await post(app,{action:'progress',jobId:job.jobId,leaseId:'foreign',progress})).status,409);
 assert.equal((await post(app,{action:'progress',jobId:job.jobId,leaseId:job.leaseId,progress})).ok,true);
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===job.jobId).providerProgress.chatgpt.stage,'send_unconfirmed');
 assert.ok(app.history.getJob(job.jobId).steps.some(e=>e.stage==='send_unconfirmed'));
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===job.jobId).status,'awaiting_chat');
});
test('observability: a well-formed stage without a label reaches the lane and history under the fallback; a malformed one is dropped',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());const job=await ready(app);
 const {buildReviewerLanes}=await import('../../src/lib/reviewer-progress.ts');const {stepLabel}=await import('../../src/lib/review-progress.ts');
 const at=Date.now();
 const progress={chatgpt:{runId:'run-A',events:[{source:'page',sequence:1,stage:'send_unconfirmed',at},
   {source:'worker',sequence:1,stage:'tab_woken',at:at+1},{source:'worker',sequence:2,stage:'lifecycle_diverged:closed/preserved',at:at+2}]}};
 assert.equal((await post(app,{action:'progress',jobId:job.jobId,leaseId:job.leaseId,progress})).ok,true);
 const live=app.harbor.getHarbor().jobs.find(j=>j.id===job.jobId);
 assert.equal(live.providerProgress.chatgpt.stage,'tab_woken','the latest well-formed stage is the live one, labelled or not');
 assert.equal(buildReviewerLanes(live).find(l=>l.provider==='chatgpt').detail,'Unlabelled step · tab_woken');
 const steps=Array.from(app.history.getJob(job.jobId).steps).filter(e=>e.runId==='run-A');
 assert.deepEqual(steps.map(e=>e.stage),['send_unconfirmed','tab_woken']);
 assert.equal(stepLabel(steps[1]),'Unlabelled step · tab_woken');
});
test('observability: history requires token and keeps response text out of default metadata',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());const job=await ready(app);
 const noToken=await fetch(app.origin+'/api/history');assert.equal(noToken.status,401);
 const raw=JSON.stringify({findings:[],investigated_safe:['fixture checked'],merge_recommendation:'COMMENT'});
 const out=await post(app,{action:'complete',jobId:job.jobId,leaseId:job.leaseId,results:[{provider:'chatgpt',raw,originalText:'PRIVATE ORIGINAL'}]});assert.equal(out.ok,true);
 const request=path=>fetch(app.origin+path,{headers:{'x-ashlar-history-token':'fixture-history-token-32-characters-long'}}).then(r=>r.json());
 const detail=await request('/api/history?jobId='+job.jobId);assert.equal(JSON.stringify(detail).includes('PRIVATE ORIGINAL'),false);
 const privateDetail=await request('/api/history?jobId='+job.jobId+'&responses=1');assert.equal(privateDetail.record.responses.chatgpt.original,'PRIVATE ORIGINAL');
});
test('observability: response archive failure preserves unacknowledged delivery',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());const job=await ready(app);app.history.recordResponse=()=>{throw new Error('disk failure');};
 const raw=JSON.stringify({findings:[],investigated_safe:['checked']});const out=await post(app,{action:'complete',jobId:job.jobId,leaseId:job.leaseId,raw});
 assert.equal(out.status,503);assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===job.jobId).storedLegs.length,0);assert.equal(app.reviews.length,0);
});
test('observability: unparsed observed text is private evidence, never a final review',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());const job=await ready(app);
 const progress={chatgpt:{runId:'run-A',events:[{source:'page',sequence:1,stage:'waiting_for_json',at:Date.now()}]}};
 await post(app,{action:'progress',jobId:job.jobId,leaseId:job.leaseId,progress});
 const observation={action:'observe',jobId:job.jobId,leaseId:job.leaseId,provider:'chatgpt',runId:'run-A',text:'PRIVATE UNPARSED',totalChars:16,truncated:false};
 assert.equal((await post(app,observation)).ok,true);
 assert.equal(app.history.getJob(job.jobId,true).observations.chatgpt.text,'PRIVATE UNPARSED');
 assert.equal(JSON.stringify(app.history.getJob(job.jobId)).includes('PRIVATE UNPARSED'),false);
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===job.jobId).storedLegs.length,0);assert.equal(app.reviews.length,0);
 assert.equal((await post(app,{...observation,runId:'another-run'})).status,409);
});
test('observability: Local completed response and invocation are archived without another generate',async t=>{
 const app=await appFixture({reviewChatgpt:false,reviewLocal:true});t.after(()=>app.close());const started=app.mention('local-history');
 await eventually(()=>app.localRequests.length===1,'Local did not start');
 const raw='Here is the result: '+JSON.stringify({findings:[],investigated_safe:['fixture checked'],merge_recommendation:'COMMENT'});
 app.localResponses[0].end(JSON.stringify({choices:[{message:{content:raw},finish_reason:'stop'}]}));
 await eventually(()=>app.reviews.length===1,'Local did not finish');const record=app.history.getJob(started.jobId,true);
 assert.equal(record.responses.local.original,raw);assert.ok(record.steps.some(s=>s.stage==='local.requested'));assert.equal(app.localRequests.length,1);
});
test('observability: a bridge automation token alone cannot read the private archive',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const response=await fetch(app.origin+'/api/history',{headers:{'x-ashlar-bridge-token':'fixture-token'}});
 assert.equal(response.status,401,'raw history needs a separate server-only read credential');
});
test('observability: completed-invalid JSON is visible and archived without posting or terminating generation by time',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());const job=await ready(app);
 const stage='response_completed_json_invalid';
 const progress={chatgpt:{runId:'run-A',events:[{source:'page',sequence:1,stage,at:Date.now()}]}};
 assert.equal((await post(app,{action:'progress',jobId:job.jobId,leaseId:job.leaseId,progress})).ok,true);
 assert.equal((await post(app,{action:'observe',jobId:job.jobId,leaseId:job.leaseId,provider:'chatgpt',runId:'run-A',text:'{"findings":[],"evidence":"a "quote""}',totalChars:36})).ok,true);
 const live=app.harbor.getHarbor().jobs.find(j=>j.id===job.jobId);
 assert.equal(live.providerProgress.chatgpt.stage,stage);assert.equal(live.status,'awaiting_chat');assert.equal(app.reviews.length,0);
 assert.ok(app.history.getJob(job.jobId,true).observations.chatgpt.text.includes('"quote"'));
 assert.equal(JSON.stringify(app.history.getJob(job.jobId)).includes('"quote"'),false);
});
test('bridge prompt reads negotiate V2 while old clients keep legacy frames',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());const job=await ready(app);
 assert.match(job.prompt,/<<<ATTACH:/);assert.doesNotMatch(job.prompt,/<<<ASHLAR_ATTACHMENTS_V2>>>/);
 const get=protocol=>fetch(`${app.origin}/api/bridge?jobId=${encodeURIComponent(job.jobId)}&attachmentProtocol=${protocol}`,{headers:{'x-ashlar-bridge-token':'fixture-token'}}).then(r=>r.json());
 assert.match((await get(2)).prompt,/<<<ASHLAR_ATTACHMENTS_V2>>>/);assert.match((await get(1)).prompt,/<<<ATTACH:/);
 assert.equal(app.reviews.length,0);
});
