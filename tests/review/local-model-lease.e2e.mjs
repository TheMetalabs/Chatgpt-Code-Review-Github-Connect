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
    };
    return {localModelLease:()=>proxy};
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
