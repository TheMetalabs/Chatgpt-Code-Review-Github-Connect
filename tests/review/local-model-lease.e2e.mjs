// One review occupies the local model across ALL of its multi-turn requests (src/lib/local-model-lease.ts,
// harbor acquireLocalModel). Production Harbor + Local HTTP; GitHub and model replies are controlled.
// Before the lease, a second review's first request reached the concurrency-1 server between the
// first review's turns (A1, B1, A2, …), evicting A's prompt cache on every turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';
import {localLegDetail} from '../../src/lib/reviewer-progress.ts';

const clean=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts: constant change only']});
const final=res=>res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:clean}}],usage:{prompt_tokens:10}}));
const toolTurn=(res,i)=>res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:'',tool_calls:[
  {id:`read-${i}`,type:'function',function:{name:'file_read',arguments:JSON.stringify({file_path:'a.ts'})}}]}}],usage:{prompt_tokens:10}}));
const settle=()=>new Promise(resolve=>setTimeout(resolve,150));

async function fixture(t){
  // Multi-turn local-only review; no chat reviewer, so each job posts on its local leg.
  const app=await appFixture({reviewChatgpt:false,localReviewMode:'multiturn',localJsonRepairEnabled:false});
  t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  return app;
}
function mentionPr(app,pr){
  return app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:`lease-pr-${pr}`,event:'issue_comment',payload:{action:'created',installation:{id:1},
    repository:{full_name:'fixture/fixture'},sender:{login:'author'},issue:{number:pr,pull_request:{},title:`PR ${pr}`},comment:{id:100+pr,body:'@ashlar-bot review'}}});
}
const job=(app,id)=>app.harbor.getHarbor().jobs.find(j=>j.id===id);
async function started(app,pr){
  const out=await mentionPr(app,pr);
  await eventually(()=>job(app,out.jobId)?.status==='awaiting_chat',`PR ${pr} snapshot not ready`);
  return out.jobId;
}
/** Answer request #i (0-based, in arrival order) once it arrives. */
async function answer(app,i,respond){
  await eventually(()=>app.localRequests.length>i,`local request #${i+1} never arrived`);
  respond(app.localResponses[i],i);
}

test('multi-turn: review A runs A1..A3 back to back while B waits at position 1; B1 only after A finishes', async t=>{
  const app=await fixture(t);
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  const b=await started(app,2);
  await eventually(()=>job(app,b)?.providerProgress?.local?.stage==='local_lease_waiting','B is not waiting for the lease');
  assert.equal(job(app,b).providerProgress.local.queuePosition,1);
  assert.equal(localLegDetail(job(app,b).providerProgress.local,Date.now(),300_000),'waiting for local model (position 1)');

  const order=[];
  const aTurn=async(i,respond)=>{await answer(app,i,respond);order.push(`A${i+1}`);};
  await aTurn(0,toolTurn);
  await aTurn(1,toolTurn);
  // Between A's turns B never reaches the server (the old behaviour sent B1 here).
  await settle();
  assert.equal(app.localRequests.length,3,'only A2 and A3 follow A1; B1 did not cut in');
  await aTurn(2,final);
  await eventually(()=>job(app,a)?.status==='posted','A did not post');

  await eventually(()=>app.localRequests.length===4,'B1 not sent after A released the model');
  order.push('B1');
  assert.notEqual(job(app,b).providerProgress.local.stage,'local_lease_waiting','B left the lease queue');
  await answer(app,3,final);
  await eventually(()=>job(app,b)?.status==='posted','B did not post');
  assert.deepEqual(order,['A1','A2','A3','B1']);
  assert.equal(app.localRequests.length,4);
});

test('abort while queued: a cancelled waiting review leaves the queue and never sends a request', async t=>{
  const app=await fixture(t);
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  const b=await started(app,2);
  await eventually(()=>job(app,b)?.providerProgress?.local?.stage==='local_lease_waiting','B is not waiting');
  const c=await started(app,3);
  await eventually(()=>job(app,c)?.providerProgress?.local?.queuePosition===2,'C is not second in the queue');

  app.harbor.cancelHarborJob(b);
  assert.equal(job(app,b).status,'cancelled');
  await eventually(()=>job(app,c)?.providerProgress?.local?.queuePosition===1,'C did not move up after B left the queue');

  await answer(app,0,final);
  await eventually(()=>job(app,a)?.status==='posted','A did not post');
  await answer(app,1,final); // C's request, not B's
  await eventually(()=>job(app,c)?.status==='posted','C did not post');
  await settle();
  assert.equal(app.localRequests.length,2,'the cancelled review never sent a request');
  assert.equal(job(app,b).status,'cancelled');
});

test('configured capacity 2: two local reviews hold the model at once', async t=>{
  const app=await appFixture({reviewChatgpt:false,localReviewMode:'single',localJsonRepairEnabled:false,localLeaseCapacity:2});
  t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  const b=await started(app,2);
  await eventually(()=>app.localRequests.length===2,'B should send in parallel at capacity 2');
  assert.notEqual(job(app,b)?.providerProgress?.local?.stage,'local_lease_waiting','B is not waiting behind A');
  await answer(app,0,final);
  await answer(app,1,final);
  await eventually(()=>job(app,a)?.status==='posted','A did not post');
  await eventually(()=>job(app,b)?.status==='posted','B did not post');
});

test('releaseJob frees the lease: cancelling the holder starts the next review without waiting for its request', async t=>{
  const app=await fixture(t);
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  const b=await started(app,2);
  await eventually(()=>job(app,b)?.providerProgress?.local?.stage==='local_lease_waiting','B is not waiting');

  app.harbor.cancelHarborJob(a); // A's request is still unanswered at the server
  await eventually(()=>app.localRequests.length===2,'B1 was not sent after the holder was cancelled');
  await answer(app,1,final);
  await eventually(()=>job(app,b)?.status==='posted','B did not post');
  assert.equal(job(app,a).status,'cancelled');
  assert.equal(app.reviews.length,1,'only B posted');
});

test('a cancellation landing between the lease grant and the leg continuing sends nothing and frees the model', async t=>{
  // Wrap the real lease so the first granted job is cancelled right after its grant resolves, before its
  // local leg resumes (the window the #141 review named). Everything else is the production lease.
  let app,armed=true;const cancelled=[];
  const wrap={'src/lib/local-model-lease.ts':real=>{
    const lease=real.localModelLease();
    const proxy={
      acquire:async(owner,opts)=>{
        const handle=await lease.acquire(owner,opts);
        if(armed){armed=false;cancelled.push(owner);app.harbor.cancelHarborJob(owner);}
        return handle;
      },
      releaseOwner:owner=>lease.releaseOwner(owner),position:owner=>lease.position(owner),snapshot:()=>lease.snapshot(),
      checkpoint:(handle,cap)=>lease.checkpoint(handle,cap),
    };
    return {...real,localModelLease:()=>proxy};
  }};
  app=await appFixture({reviewChatgpt:false,localReviewMode:'multiturn',localJsonRepairEnabled:false},{wrap});
  t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const a=(await mentionPr(app,1)).jobId;
  await eventually(()=>job(app,a)?.status==='cancelled','the job was not cancelled after its grant');
  assert.deepEqual(cancelled,[a]);
  await settle();
  assert.equal(app.localRequests.length,0,'a review cancelled after its grant never sends a request');
  // It stops AT the grant: it never records holding the model and never runs (and fails) a local leg.
  const steps=(app.history.getJob(a,true)?.steps??[]).map(s=>s.stage);
  assert.ok(!steps.includes('local.lease_acquired'),`cancelled job recorded a lease: ${steps}`);
  assert.ok(!steps.includes('local.failed'),`cancelled job ran its local leg: ${steps}`);
  const b=await started(app,2);
  await answer(app,0,final);
  await eventually(()=>job(app,b)?.status==='posted','the next review did not get the model');
  assert.equal(app.localRequests.length,1);
});

test('local_lease_waiting until HTTP is sent; local_queued only after dispatch', async t=>{
  let releaseHttp=()=>{};
  const gate=new Promise(resolve=>{releaseHttp=resolve;});
  const wrap={'src/lib/local-chat-request.server.ts':real=>({
    ...real,
    requestLocalJson:async(...args)=>{await gate;return real.requestLocalJson(...args);},
  })};
  const app=await appFixture({reviewChatgpt:false,localReviewMode:'multiturn',localJsonRepairEnabled:false},{wrap});
  t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const a=await started(app,1);
  await eventually(()=>job(app,a)?.providerProgress?.local?.stage==='local_lease_waiting','A is not waiting for the lease before send');
  assert.equal(app.localRequests.length,0,'HTTP must not be sent while local_lease_waiting');
  releaseHttp();
  await eventually(()=>app.localRequests.length===1,'HTTP was not dispatched after the gate opened');
  assert.equal(job(app,a).providerProgress.local.stage,'local_queued');
  await answer(app,0,final);
  await eventually(()=>job(app,a)?.status==='posted','A did not post');
});

test('queued-without-output: keepalives do not save a ghost; abort releases the lease', async t=>{
  const app=await fixture(t);
  app.env.ASHLAR_LOCAL_LLM_STREAM='true';
  app.env.ASHLAR_LOCAL_REVIEW_QUEUED_MS='200';
  app.env.ASHLAR_LOCAL_REVIEW_LIVENESS_MS='60000';
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  const res=app.localResponses[0];
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'});
  const keepalive={id:'c1',object:'chat.completion.chunk',created:0,model:'keepalive',choices:[{index:0,delta:{role:'assistant',content:''},finish_reason:null}]};
  const tick=setInterval(()=>{try{res.write(`data: ${JSON.stringify(keepalive)}\n\n`);}catch{/* aborted */}},20);
  t.after(()=>{clearInterval(tick);try{res.end();}catch{/* already closed */}});
  const b=await started(app,2);
  await eventually(()=>job(app,b)?.providerProgress?.local?.stage==='local_lease_waiting','B is not waiting for the lease');
  await eventually(()=>job(app,a)?.assumptions?.some(s=>/queued without output/i.test(s)),'A was not aborted for queued-without-output despite keepalives');
  await eventually(()=>app.localRequests.length===2||job(app,b)?.providerProgress?.local?.stage==='local_queued',
    'B did not take the lease after A released it');
});

test('queued-without-output: buffered headers with no body abort and release the lease', async t=>{
  const app=await fixture(t);
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  app.env.ASHLAR_LOCAL_REVIEW_QUEUED_MS='200';
  app.env.ASHLAR_LOCAL_REVIEW_LIVENESS_MS='60000';
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  // Headers only: a hang after 200 JSON with no body must not count as output.
  const hung=app.localResponses[0];
  hung.writeHead(200,{'content-type':'application/json'});
  hung.flushHeaders();
  const b=await started(app,2);
  await eventually(()=>job(app,b)?.providerProgress?.local?.stage==='local_lease_waiting','B is not waiting for the lease');
  await eventually(()=>job(app,a)?.assumptions?.some(s=>/queued without output/i.test(s)),'A was not aborted for queued-without-output after headers with no body');
  await eventually(()=>app.localRequests.length===2||job(app,b)?.providerProgress?.local?.stage==='local_queued',
    'B did not take the lease after A released it');
});

test('short lane: a holding review lends the model to a waiting short job at its next turn boundary, then resumes ahead of queued reviews', async t=>{
  // The app runs in its own module graph: reach ITS process-wide lease through the fixture's wrap hook.
  let leaseModule;
  const wrap={'src/lib/local-model-lease.ts':real=>{leaseModule=real;return real;}};
  const app=await appFixture({reviewChatgpt:false,localReviewMode:'multiturn',localJsonRepairEnabled:false},{wrap});
  t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const localModelLease=()=>leaseModule.localModelLease();
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  const b=await started(app,2);
  await eventually(()=>job(app,b)?.providerProgress?.local?.stage==='local_lease_waiting','B is not waiting');
  // A JSON repair (short lane) arrives while A1 is generating: it never preempts A1.
  let shortHandle;
  const short=localModelLease().acquire('repair:e2e',{lane:'short'}).then(h=>{shortHandle=h;});
  await settle();
  assert.equal(shortHandle,undefined,'no preemption mid-turn');
  assert.deepEqual([...localModelLease().snapshot().queued],['repair:e2e',b]);
  await answer(app,0,toolTurn); // A1 completes; A's next turn boundary lends the model to the short job
  await short;
  assert.ok(shortHandle,'the short job was granted at A\'s turn boundary');
  await settle();
  assert.equal(app.localRequests.length,1,'A2 waits while the short job holds the lent model; B never cuts in');
  shortHandle.release();
  await eventually(()=>app.localRequests.length===2,'A did not resume after the short job');
  await answer(app,1,final);
  await eventually(()=>job(app,a)?.status==='posted','A did not post');
  await eventually(()=>app.localRequests.length===3,'B1 not sent after A released');
  await answer(app,2,final);
  await eventually(()=>job(app,b)?.status==='posted','B did not post');
});

// ── Small reviews and re-requests (2026-11-09: small PRs waited 50–90 minutes behind large reviews; a
// re-request went to the back of the queue) ──

async function pipelineFixture(t,github={}){
  let leaseModule;
  const wrap={'src/lib/local-model-lease.ts':real=>{leaseModule=real;return real;}};
  const app=await appFixture({reviewChatgpt:false,localReviewPipeline:true,localJsonRepairEnabled:false,localPipelineLenses:1},{...github,wrap});
  t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  return {app,lease:()=>leaseModule.localModelLease()};
}
const prOf=body=>/fixture\/fixture#(\d+)/.exec(JSON.stringify(body))?.[1];
/** A reply that fits the request's pipeline stage (map, verify, select or a feature turn). */
function stageReply(res,body){
  const sys=body.messages?.[0]?.content??'';
  const user=body.messages?.[1]?.content??'';
  const content=sys.startsWith('You summarize')
    ? JSON.stringify({files:[...user.matchAll(/=== FILE: (\S+)/g)].map(m=>({file:m[1],summary:'s',guards:[],effects:[]}))})
    : sys.startsWith('You rank') ? JSON.stringify({selected:[]})
    : /ONE reported defect/.test(sys) ? JSON.stringify({trace:'t',blocking_code:'',verdict:'uncertain',proof_quote:'',severity:'P2'})
    : clean;
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}],usage:{prompt_tokens:10}}));
}
/** Answer every request from index `from` on as it arrives; returns a stop function. */
function answerAll(app,from=0){
  const done=new Set();
  const timer=setInterval(()=>{
    for(let i=from;i<app.localRequests.length;i++){
      if(done.has(i))continue;
      done.add(i);
      stageReply(app.localResponses[i],app.localRequests[i]);
    }
  },20);
  return ()=>clearInterval(timer);
}

test('small lane: a PR reviewed in one turn queues ahead of a waiting large review, and a running large review lends it the model', async t=>{
  const {app,lease}=await pipelineFixture(t);
  // PR 1 is "large": a feature budget below its diff makes the pipeline split it (map + features).
  app.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS='20';
  const a=await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  delete app.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS;
  // A large review already waiting (a manual review-lane waiter), then the small PR 2.
  let manual;
  const queued=lease().acquire('manual-large',{}).then(h=>{manual=h;});
  const b=await started(app,2);
  await eventually(()=>lease().snapshot().queued.includes(b),'B not queued');
  assert.deepEqual([...lease().snapshot().queued],[b,'manual-large'],'the small review waits ahead of the large one');
  // A1 completes; at A's next turn boundary the model is lent to B, before A2 and the waiting large review.
  stageReply(app.localResponses[0],app.localRequests[0]);
  await eventually(()=>app.localRequests.length===2,'no request after A1');
  assert.equal(prOf(app.localRequests[1]),'2','the request after A1 is the small review\'s');
  const stop=answerAll(app,1);
  t.after(stop);
  await eventually(()=>job(app,b)?.status==='posted','B did not post while A was running');
  assert.equal(manual,undefined,'the waiting large review still waits while A runs');
  await eventually(()=>['posted','failed'].includes(job(app,a)?.status),'A did not finish');
  await queued; manual.release();
});

test('re-request: a job that supersedes a queued one for the same PR keeps its place in the queue', async t=>{
  const {app,lease}=await pipelineFixture(t);
  app.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS='20'; // every PR "large": one lane, ordered by queue time
  // The fixture's clock is frozen; real requests arrive at different times.
  await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  app.clock.now+=60_000;
  const b=await started(app,2);
  await eventually(()=>lease().snapshot().queued.includes(b),'B not queued');
  app.clock.now+=60_000;
  const c=await started(app,3);
  await eventually(()=>lease().snapshot().queued.includes(c),'C not queued');
  app.clock.now+=60_000;
  // PR 2 is requested again (a new head or a manual re-request): its new job must stay ahead of PR 3.
  const out=await app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'lease-pr-2-again',event:'issue_comment',payload:{action:'created',installation:{id:1},
    repository:{full_name:'fixture/fixture'},sender:{login:'author'},issue:{number:2,pull_request:{},title:'PR 2'},comment:{id:999,body:'@ashlar-bot review'}}});
  await eventually(()=>lease().snapshot().queued.includes(out.jobId),'the re-request is not queued');
  assert.deepEqual([...lease().snapshot().queued],[out.jobId,c],'the re-request keeps PR 2\'s place ahead of PR 3');
  t.after(answerAll(app,0));
});

test('re-request: the superseding job keeps the time the old job queued for the model, not when it was created', async t=>{
  // The old job for PR 2 is created first but its local leg queues last (here its head lookup is slow;
  // in verify mode the local leg starts only after the chat leg). Its re-request must not jump ahead of
  // PR 3, which queued before it.
  let holdHead=false,releaseHead=()=>{};
  const headGate=new Promise(resolve=>{releaseHead=resolve;});
  const {app,lease}=await pipelineFixture(t,{beforeHead:()=>holdHead?headGate:undefined});
  t.after(()=>releaseHead());
  app.env.ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS='20'; // every PR "large": one lane, ordered by queue time
  await started(app,1);
  await eventually(()=>app.localRequests.length===1,'A1 not sent');
  app.clock.now+=60_000;
  holdHead=true;
  const b=(await mentionPr(app,2)).jobId; // created now, but held before its snapshot
  await eventually(()=>app.githubCalls.head>=2,'PR 2 head lookup did not start');
  holdHead=false;
  app.clock.now+=60_000;
  const c=await started(app,3);
  await eventually(()=>lease().snapshot().queued.includes(c),'C not queued');
  app.clock.now+=60_000;
  releaseHead();
  await eventually(()=>lease().snapshot().queued.includes(b),'B not queued');
  assert.deepEqual([...lease().snapshot().queued],[c,b],'B queued after C');
  app.clock.now+=60_000;
  const out=await app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'lease-pr-2-again',event:'issue_comment',payload:{action:'created',installation:{id:1},
    repository:{full_name:'fixture/fixture'},sender:{login:'author'},issue:{number:2,pull_request:{},title:'PR 2'},comment:{id:998,body:'@ashlar-bot review'}}});
  await eventually(()=>lease().snapshot().queued.includes(out.jobId),'the re-request is not queued');
  assert.deepEqual([...lease().snapshot().queued],[c,out.jobId],'the re-request keeps B\'s place behind C');
  t.after(answerAll(app,0));
});
