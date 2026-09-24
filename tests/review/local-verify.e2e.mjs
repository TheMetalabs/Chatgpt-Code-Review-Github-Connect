// settings.localReviewRole="verify-clean" through the real webhook → harbor snapshot → merge → post
// path. Chat legs are submitted as the bridge would; Local HTTP is the fixture model server. The
// chat × local outcome matrix is local-verify-outcomes.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';
import {isZeroFindings} from '../../src/lib/review-loop.ts';
import {REVIEW_RAW_END,REVIEW_RAW_START} from '../../src/lib/review-format.ts';
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
