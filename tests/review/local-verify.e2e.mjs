// settings.localReviewRole="verify-clean" through the real webhook → harbor snapshot → merge → post
// path. Chat legs are submitted as the bridge would; Local HTTP is the fixture model server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';
import {isZeroFindings,parseFindingsTotal} from '../../src/lib/review-loop.ts';
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
  assert.match(app.reviews[0].body,/^Didn't find any major issues\./);
  assert.match(app.reviews[0].body,/local verification did not complete \(/);
  assert.match(app.reviews[0].body,/ashlar-findings total=0 .*unverified=1 -->$/);
  assert.equal(parseFindingsTotal(app.reviews[0].body),0);
  assert.equal(converged(app.reviews[0].body),false,'an unverified clean result must never end the loop as converged');
});

test('verify-clean: an unparseable local reply is no verification: chat\'s clean result posts with the note',async t=>{
  const {app,jobId,job}=await setup(t,'verify-clean',{localJsonRepairEnabled:false});
  await app.harbor.submitHarborChat(jobId,clean);
  await eventually(()=>app.localRequests.length===1,'clean chat did not start local verification');
  // the local leg may ask again (multi-turn): every reply stays unparseable
  let answered=0;
  await eventually(()=>{while(answered<app.localResponses.length)app.localResponses[answered++].end(reply('Looks fine to me, nothing structured here.'));return app.reviews.length===1;},'chat clean result was not posted after local replied unparseable');
  assert.equal(job().status,'posted');
  assert.match(app.reviews[0].body,/^Didn't find any major issues\./,'the clean sentinel, not the raw-reply wrapper');
  assert.match(app.reviews[0].body,/local verification did not complete \(/);
  assert.match(app.reviews[0].body,/ashlar-findings total=0 .*unverified=1 -->$/);
  assert.equal(converged(app.reviews[0].body),false,'an unparseable verifier is no verification: never converged');
  assert.doesNotMatch(app.reviews[0].body,/nothing structured here/,'the verifier\'s raw text stays out of the review');
  assert.equal(app.reviews[0].comments.length,0);
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
