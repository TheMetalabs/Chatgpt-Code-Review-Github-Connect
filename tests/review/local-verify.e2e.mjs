// settings.localReviewRole="verify-clean" through the real webhook → harbor snapshot → merge → post
// path. Chat legs are submitted as the bridge would; Local HTTP is the fixture model server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';
import {isZeroFindings,parseFindingsTotal} from '../../src/lib/review-loop.ts';
import {CLEAN_REVIEW_BODY,REVIEW_RAW_END,REVIEW_RAW_START,REVIEW_SUMMARY_MARK} from '../../src/lib/review-format.ts';
// The review loop's real CONVERGED detector, reading a bot-authored review.
const converged=body=>isZeroFindings(body,{authoredByBot:true});

const finding={severity:'P1',file:'a.ts',line:1,side:'RIGHT',title:'Missing check',failure_scenario:'A duplicate request writes twice',
  root_cause:'No guard',evidence:'a.ts:1: no guard',recommended_fix:'Check the key',recommended_test:'Assert one write'};
const clean=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts: constant change only']});
const dirty=JSON.stringify({findings:[finding],merge_recommendation:'REQUEST_CHANGES'});
const reply=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});

async function setup(t,role='verify-clean',extra={}) {
  const app=await appFixture({localReviewRole:role,...extra});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention('verify-'+role);
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId)?.status==='awaiting_chat','snapshot not ready');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  return {app,jobId:out.jobId,job};
}
// An unverified clean result must not carry the clean sentinel: every substring-based clean detector
// (review-loop.ts documents `"didn't find any major issues"` substring matching) must stay not-converged.
function assertUnverifiedNotClean(body){
  assert.match(body,/^Chat found no major issues, but local verification did not complete — this is not a clean pass\./);
  assert.equal(body.toLowerCase().includes("didn't find any major issues"),false,'no clean sentinel (case-insensitive)');
  assert.equal(body.toLowerCase().includes(CLEAN_REVIEW_BODY.toLowerCase()),false);
  assert.equal(converged(body),false);
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,150));

test('verify-clean: the role is pinned on the job at snapshot and local does not race',async t=>{
  const {app,job}=await setup(t);
  assert.equal(job().localReviewRole,'verify-clean');
  assert.equal(job().reviewProviders.join(','),'chatgpt,local');
  await settle();assert.equal(app.localRequests.length,0,'no local generation at the start');
  assert.ok(app.ops.some(body=>body.includes('Reviewers: chatgpt (Chrome); local verifies a clean result.')));
});

test('verify-clean: chat findings post now without any local generation',async t=>{
  const {app,jobId,job}=await setup(t);
  assert.equal((await app.harbor.submitHarborChat(jobId,dirty)).ok,true);
  await eventually(()=>app.reviews.length===1,'chat findings were not posted');
  assert.equal(job().status,'posted');assert.equal(app.reviews[0].comments.length,1);
  assert.doesNotMatch(app.reviews[0].body,/Skipped local/);
  await settle();assert.equal(app.localRequests.length,0);
  assert.equal(app.harbor.hasLocalSample(jobId),false,'the never-used local snapshot is released at the terminal status');
});

test('verify-clean: clean chat starts the local round; local findings are what gets posted',async t=>{
  const {app,jobId,job}=await setup(t);
  await app.harbor.submitHarborChat(jobId,clean);
  await eventually(()=>app.localRequests.length===1,'clean chat did not start local verification');
  assert.equal(app.reviews.length,0,'a clean chat result is held until local verifies');
  assert.equal(job().status,'awaiting_chat');assert.ok(job().localVerifyStartedAt);
  app.localResponses[0].end(reply(dirty));
  await eventually(()=>app.reviews.length===1,'local findings were not posted');
  assert.equal(app.reviews[0].comments.length,1);
  assert.match(app.reviews[0].body,/chatgpt found nothing; local verification found 1\./);
  assert.match(app.reviews[0].body,/ashlar-findings total=1 /);
  assert.equal(app.localRequests.length,1);
});

test('verify-clean: chat clean + local clean posts the clean (CONVERGED) review',async t=>{
  const {app,jobId}=await setup(t);
  await app.harbor.submitHarborChat(jobId,clean);
  await eventually(()=>app.localRequests.length===1,'clean chat did not start local verification');
  app.localResponses[0].end(reply(clean));
  await eventually(()=>app.reviews.length===1,'clean review was not posted');
  assert.match(app.reviews[0].body,/^Didn't find any major issues\./);
  assert.match(app.reviews[0].body,/local verification agreed/);
  assert.match(app.reviews[0].body,/ashlar-findings total=0 /);
  assert.equal(converged(app.reviews[0].body),true,'a verified clean review IS the converged signal');
});

test('verify-clean: chat clean + local failure posts chat\'s clean result with the note',async t=>{
  const {app,jobId,job}=await setup(t);
  await app.harbor.submitHarborChat(jobId,clean);
  await eventually(()=>app.localRequests.length===1,'clean chat did not start local verification');
  app.localResponses[0].writeHead(500,{'content-type':'application/json'});app.localResponses[0].end('{"error":"model crashed"}');
  await eventually(()=>app.reviews.length===1,'chat clean result was not posted after local failed');
  assert.equal(job().status,'posted');
  assertUnverifiedNotClean(app.reviews[0].body);
  assert.match(app.reviews[0].body,/local verification did not complete \(/);
  assert.match(app.reviews[0].body,/ashlar-findings total=0 .*unverified=1 -->$/);
  assert.equal(parseFindingsTotal(app.reviews[0].body),0);
  assert.equal(converged(app.reviews[0].body),false,'an unverified clean result must never end the loop as converged');
});

test('verify-clean: an unparseable local verifier reply is posted verbatim as unverified evidence, never filtered out',async t=>{
  const {app,jobId,job}=await setup(t,'verify-clean',{localJsonRepairEnabled:false});
  await app.harbor.submitHarborChat(jobId,clean);
  await eventually(()=>app.localRequests.length===1,'clean chat did not start local verification');
  // every reply (the first and the one correction) is prose carrying a real finding
  const prose='P1 a.ts:1 LOCAL-RAW: a duplicate request writes twice (nothing structured here)';
  let answered=0;
  await eventually(()=>{while(answered<app.localResponses.length)app.localResponses[answered++].end(reply(prose));return app.reviews.length===1;},'the review was not posted after local replied unparseable');
  const body=app.reviews[0].body;
  assert.equal(job().status,'posted');
  assert.equal(body.split('\n')[0],REVIEW_SUMMARY_MARK);
  const block=body.slice(body.indexOf(REVIEW_RAW_START),body.indexOf(REVIEW_RAW_END));
  assert.ok(block.includes(prose),'the verifier\'s finding text is posted inside the raw block');
  assert.match(body,/local verification's reply was not parseable review JSON/);
  assert.match(body,/<!-- ashlar-findings total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0 unverified=1 -->$/);
  assert.equal(body.toLowerCase().includes("didn't find any major issues"),false,'no clean sentinel');
  assert.equal(converged(body),false,'an unparseable verifier is no verification: never converged');
  assert.equal(app.reviews[0].comments.length,0);
});

test('verify-clean: the first unparseable reply is kept as evidence even when the JSON correction replies differently',async t=>{
  const {app,jobId}=await setup(t,'verify-clean',{localJsonRepairEnabled:false});
  await app.harbor.submitHarborChat(jobId,clean);
  await eventually(()=>app.localRequests.length===1,'clean chat did not start local verification');
  app.localResponses[0].end(reply('P1 a.ts:1 FIRST-REPLY-MARK: a duplicate request writes twice'));
  await eventually(()=>app.localRequests.length===2,'local did not ask for its one JSON correction');
  app.localResponses[1].end(reply('still prose, sorry'));
  await eventually(()=>app.reviews.length===1,'the review was not posted');
  const body=app.reviews[0].body;
  const block=body.slice(body.indexOf(REVIEW_RAW_START),body.indexOf(REVIEW_RAW_END));
  assert.ok(block.includes('FIRST-REPLY-MARK'),'the first reply (the one with the finding) is posted');
  assert.ok(block.includes('still prose, sorry'),'and the correction reply');
  assert.equal(converged(body),false);
});

test('race (default): local still starts with the chat leg',async t=>{
  const {app,job}=await setup(t,'race');
  assert.equal(job().localReviewRole,'race');
  await eventually(()=>app.localRequests.length===1,'race mode did not start local at snapshot');
});

test('verify-clean: chat with no usable result releases local as today\'s fallback (never a lost review)',async t=>{
  const {app,jobId,job}=await setup(t);
  await app.harbor.submitHarborChat(jobId,'{"findings": "not a list"}');
  await eventually(()=>app.localRequests.length===1,'chat failure did not start the local fallback');
  assert.ok(job().localFallbackAt);assert.equal(job().localVerifyStartedAt,undefined);
  app.localResponses[0].end(reply(dirty));
  await eventually(()=>app.reviews.length===1,'local fallback review was not posted');
  assert.equal(app.reviews[0].comments.length,1);
  assert.doesNotMatch(app.reviews[0].body,/local verification/);
});

test('verify-clean: a Chrome bridge that stays offline releases local as the fallback (the review still completes)',async t=>{
  const {app,jobId,job}=await setup(t);
  await settle();assert.equal(app.localRequests.length,0,'held while within the bridge grace period');
  assert.equal(app.bridge.getBridgePublic().connected,false);
  app.clock.now+=120_001; // past BRIDGE_CONNECTED_MS with no chat progress
  await eventually(()=>app.localRequests.length===1,'offline bridge never released the held local leg');
  assert.ok(job().localFallbackAt);assert.equal(job().localVerifyStartedAt,undefined);
  app.localResponses[0].end(reply(dirty));
  await eventually(()=>app.reviews.length===1,'local fallback review was not posted');
  assert.equal(job().status,'posted');assert.equal(app.reviews[0].comments.length,1);
  assert.match(app.reviews[0].body,/Skipped chatgpt/,'the offline chat reviewer stays visible');
  assert.doesNotMatch(app.reviews[0].body,/local verification/);
  assert.equal(app.harbor.hasLocalSample(jobId),false);
});

test('verify-clean: supersession frees a held job\'s local snapshot (terminal cleanup runs for every cancelled job)',async t=>{
  const {app,jobId,job}=await setup(t);
  let prev=jobId,prevJob=job;
  for(let i=0;i<3;i++){
    assert.equal(prevJob().status,'awaiting_chat');
    assert.equal(app.harbor.hasLocalSample(prev),true,'held verify-clean job keeps its snapshot');
    const out=await app.mention('verify-supersede-'+i);
    await eventually(()=>prevJob().status==='cancelled','previous job was not superseded');
    assert.match(prevJob().skipReason,/superseded by/);
    assert.equal(app.harbor.hasLocalSample(prev),false,'superseded job leaked its local snapshot');
    await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId)?.status==='awaiting_chat','new snapshot not ready');
    const id=out.jobId;prev=id;prevJob=()=>app.harbor.getHarbor().jobs.find(j=>j.id===id);
  }
});
