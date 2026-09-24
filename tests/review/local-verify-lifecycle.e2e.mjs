// Every path that ends a job goes through transitionJob, and terminal cleanup runs there once
// (docs/local-verify-clean.md §3). One row per terminal path; each asserts the job status, how many
// local requests ran, that the local snapshot is freed, how many reviews posted, that the reviewer
// watcher stops, and whether an in-flight local request was aborted. Rows are verify-clean unless
// named race (race behavior must not change).
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';

const finding={severity:'P1',file:'a.ts',line:1,side:'RIGHT',title:'Missing check',failure_scenario:'A duplicate request writes twice',
  root_cause:'No guard',evidence:'a.ts:1: no guard',recommended_fix:'Check the key',recommended_test:'Assert one write'};
const clean=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts: constant change only']});
const dirty=JSON.stringify({findings:[finding],merge_recommendation:'REQUEST_CHANGES'});
const none='{"findings":"not a list"}';
const reply=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});
const fail500=res=>{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"model crashed"}');};
const settle=()=>new Promise(resolve=>setTimeout(resolve,150));
const TERMINAL=['posted','skipped','dlq','cancelled'];

async function start(t,{role='verify-clean',settings={},githubOptions={},delivery='lifecycle'}={}){
  const app=await appFixture({localReviewRole:role,localJsonRepairEnabled:false,...settings},githubOptions);t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention(delivery);
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  return {app,jobId:out.jobId,job};
}
/** Records whether the fixture's response closed before it was answered (the client aborted it). */
function trackAbort(res){
  const seen={aborted:false};
  res.once('close',()=>{seen.aborted=!res.writableEnded;});
  return seen;
}
/** Answer local request #i once it arrives. */
async function answerLocal(app,i,respond){
  await eventually(()=>app.localRequests.length>i,`local request #${i+1} never arrived`);
  respond(app.localResponses[i]);
}
async function newJobAfter(app,id,delivery){
  const out=await app.mention(delivery);
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===id)?.status==='cancelled','previous job was not superseded');
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId)?.status==='awaiting_chat','new snapshot not ready');
  return out.jobId;
}

// expect: status, skip (regex or undefined), requests (total local requests), reviews, aborted.
const ROWS=[
  {name:'L1 chat findings: local stays held and never runs',expect:{status:'posted',requests:0,reviews:1},
    async run(t){const s=await start(t);await s.app.harbor.submitHarborChat(s.jobId,dirty);return s;}},
  {name:'L2 chat clean, local verifies clean',expect:{status:'posted',requests:1,reviews:1},
    async run(t){const s=await start(t);await s.app.harbor.submitHarborChat(s.jobId,clean);await answerLocal(s.app,0,res=>res.end(reply(clean)));return s;}},
  {name:'L3 chat clean, local HTTP 500',expect:{status:'posted',requests:1,reviews:1},
    async run(t){const s=await start(t);await s.app.harbor.submitHarborChat(s.jobId,clean);await answerLocal(s.app,0,fail500);return s;}},
  {name:'L4 operator cancel while local is held',expect:{status:'cancelled',skip:/cancelled by operator/,requests:0,reviews:0},
    async run(t){const s=await start(t);s.app.harbor.cancelHarborJob(s.jobId);return s;}},
  {name:'L5 operator cancel while local verifies: aborted, and a late reply is ignored',expect:{status:'cancelled',skip:/cancelled by operator/,requests:1,reviews:0,aborted:true},
    async run(t){
      const s=await start(t);await s.app.harbor.submitHarborChat(s.jobId,clean);
      await eventually(()=>s.app.localRequests.length===1,'verification round did not start');
      s.abort=trackAbort(s.app.localResponses[0]);
      s.app.harbor.cancelHarborJob(s.jobId);
      await eventually(()=>s.abort.aborted,'the in-flight local request was not aborted');
      try{s.app.localResponses[0].end(reply(dirty));}catch{/* the connection is already gone */}
      return s;
    }},
  {name:'L6 superseded while held (three times in a row)',expect:{status:'cancelled',skip:/superseded by/,requests:0,reviews:0},
    async run(t){
      const s=await start(t);
      let prev=s.jobId;
      for(let i=0;i<3;i++){
        assert.equal(s.app.harbor.hasLocalSample(prev),true,'a held job keeps its snapshot until it ends');
        const next=await newJobAfter(s.app,prev,`lifecycle-supersede-${i}`);
        await eventually(()=>!s.app.harbor.hasLocalSample(prev),`superseded job ${i} leaked its local snapshot`);
        prev=next;
      }
      return s;
    }},
  {name:'L7 superseded while local verifies: aborted',expect:{status:'cancelled',skip:/superseded by/,requests:1,reviews:0,aborted:true},
    async run(t){
      const s=await start(t);await s.app.harbor.submitHarborChat(s.jobId,clean);
      await eventually(()=>s.app.localRequests.length===1,'verification round did not start');
      s.abort=trackAbort(s.app.localResponses[0]);
      await newJobAfter(s.app,s.jobId,'lifecycle-supersede-verifying');
      await eventually(()=>s.abort.aborted,'the superseded job\'s local request was not aborted');
      return s;
    }},
  {name:'L8 GitHub Reviews API fails: dlq',expect:{status:'dlq',skip:/GitHub Reviews API failed/,requests:0,reviews:0},
    async run(t){
      const s=await start(t,{githubOptions:{beforeReview:async()=>{throw new Error('GitHub 502');}}});
      await s.app.harbor.submitHarborChat(s.jobId,dirty);return s;
    }},
  {name:'L9 chat unusable, local fallback HTTP 500: skipped',expect:{status:'skipped',requests:1,reviews:0},
    async run(t){const s=await start(t);await s.app.harbor.submitHarborChat(s.jobId,none);await answerLocal(s.app,0,fail500);return s;}},
  {name:'R1 race: chat and local both find the issue',expect:{status:'posted',requests:1,reviews:1},
    async run(t){
      const s=await start(t,{role:'race'});
      await s.app.harbor.submitHarborChat(s.jobId,dirty);
      await answerLocal(s.app,0,res=>res.end(reply(dirty)));return s;
    }},
  {name:'R2 race: superseded while local runs: aborted',expect:{status:'cancelled',skip:/superseded by/,requests:2,reviews:0,aborted:true},
    async run(t){
      const s=await start(t,{role:'race'});
      await eventually(()=>s.app.localRequests.length===1,'race did not start local at snapshot');
      s.abort=trackAbort(s.app.localResponses[0]);
      await newJobAfter(s.app,s.jobId,'lifecycle-race-supersede');
      await eventually(()=>s.abort.aborted,'the superseded race job\'s local request was not aborted');
      // the new race job starts its own local leg: one request per job
      await eventually(()=>s.app.localRequests.length===2,'the new race job did not start local');
      return s;
    }},
];

for(const row of ROWS){
  test(`lifecycle: ${row.name}`,async t=>{
    const s=await row.run(t);
    const {app,jobId,job}=s,e=row.expect;
    await eventually(()=>TERMINAL.includes(job().status),`${row.name}: the job never ended`);
    await settle();
    assert.equal(job().status,e.status,'status');
    if(e.skip)assert.match(job().skipReason??'',e.skip,'skipReason');
    assert.equal(app.localRequests.length,e.requests,'local requests');
    assert.equal(app.reviews.length,e.reviews,'reviews posted');
    await eventually(()=>!app.harbor.hasLocalSample(jobId),`${row.name}: the local snapshot was never released`);
    await eventually(()=>!app.harbor.isWatchingJob(jobId),`${row.name}: the reviewer watcher never stopped`);
    assert.equal(Boolean(s.abort?.aborted),Boolean(e.aborted),'in-flight local request aborted');
  });
}
