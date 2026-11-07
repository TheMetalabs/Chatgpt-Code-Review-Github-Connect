// Settings local_review.pipeline through the real webhook → harbor snapshot → local leg → post path.
// The local model is the fixture's HTTP server; each request is answered by its stage (system message).
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';

const finding={severity:'P1',file:'a.ts',line:1,side:'RIGHT',title:'answer is off by one',failure_scenario:'Callers expecting 41 get 42.',
  root_cause:'The constant changed.',evidence:'a.ts:1 `export const answer = 42;`',recommended_fix:'Keep 41.',recommended_test:'Assert 41.'};
const dirty=JSON.stringify({findings:[finding],merge_recommendation:'REQUEST_CHANGES',investigated_safe:[]});
const reply=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});
const stage=body=>{const s=JSON.parse(body).messages[0].content;return s.startsWith('You summarize')?'map':/You judge ONE reported defect/.test(s)?'verify':s.startsWith('You rank')?'select':'review';};
const confirmed=JSON.stringify({verdict:'confirmed',reason:'the constant changed',proof_quote:'export const answer = 42;',severity:'P1'});
const refuted=JSON.stringify({verdict:'refuted',reason:'documented change',counter_quote:'export const answer = 42;'});

async function run(t,settings,answers,env={}){
  const app=await appFixture({reviewChatgpt:false,localJsonRepairEnabled:false,localReviewPipeline:true,localPipelineLenses:1,...settings});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  Object.assign(app.env,env);
  const out=await app.mention('pipeline-'+Object.values(settings).join('-'));
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  const stages=[];let answered=0;
  await eventually(()=>{
    while(answered<app.localResponses.length){
      const body=app.localRequests[answered].raw??JSON.stringify(app.localRequests[answered]);
      const s=stage(body);stages.push(s);
      app.localResponses[answered].end(reply(answers[s](stages.filter(x=>x===s).length)));answered++;
    }
    return ['posted','skipped','dlq','cancelled'].includes(job()?.status);
  },'the job never finished');
  await new Promise(r=>setTimeout(r,150));
  return {app,job:job(),stages};
}

test('small PR (whole PR in one turn): a refuted finding never posts; the review says what the verifier did',async t=>{
  const {app,job,stages}=await run(t,{localReviewMode:'single'},{review:()=>dirty,verify:()=>refuted});
  assert.deepEqual(stages,['review','verify']);
  assert.equal(job.status,'posted');
  assert.match(app.reviews[0].body,/ashlar-findings total=0 /);
  await eventually(()=>/Local pipeline: 1 feature group\(s\) × 1 lens\(es\), 1 candidate\(s\), 1 to verify, 0 confirmed, 1 refuted, 0 posted/.test(app.ops.at(-1)??''),'the ops comment does not report the verification');
});

test('small PR: a confirmed finding posts',async t=>{
  const {app,stages}=await run(t,{localReviewMode:'single'},{review:()=>dirty,verify:()=>confirmed});
  assert.deepEqual(stages,['review','verify']);
  assert.match(app.reviews[0].body,/ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 p2=0/);
});

test('three lenses: one candidate pass per focus, the same finding verified once',async t=>{
  const {app,stages}=await run(t,{localReviewMode:'single',localPipelineLenses:3},{review:()=>dirty,verify:()=>confirmed});
  assert.deepEqual(stages,['review','review','review','verify']);
  assert.match(app.reviews[0].body,/ashlar-findings total=1 /);
});

test('a hedged finding the verifier confirms posts through the leg gate (trusted verified keys); the gate still runs',async t=>{
  const hedged=JSON.stringify({findings:[{...finding,title:'answer may be off by one',failure_scenario:'Callers expecting 41 could get 42.'}],merge_recommendation:'REQUEST_CHANGES',investigated_safe:[]});
  const {app,job}=await run(t,{localReviewMode:'single',findingGate:'rules'},{review:()=>hedged,verify:()=>confirmed});
  assert.equal(job.status,'posted');
  assert.match(app.reviews[0].body,/ashlar-findings total=1 /);
  assert.match(app.reviews[0].body,/answer may be off by one/);
});

test('large PR: the staged pipeline runs map → feature → verify and posts the confirmed finding',async t=>{
  const map=JSON.stringify({files:[{file:'a.ts',summary:'changes the answer constant',guards:[],effects:[]}]});
  const {app,stages}=await run(t,{localReviewMode:'multiturn'},{map:()=>map,review:()=>dirty,verify:()=>confirmed},{ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS:'50'});
  assert.deepEqual(stages,['map','review','verify']);
  assert.match(app.reviews[0].body,/ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 p2=0/);
  await eventually(()=>/Local pipeline: 1 feature group\(s\) × 1 lens\(es\), 1 candidate\(s\), 1 to verify, 1 confirmed, 0 refuted, 1 posted/.test(app.ops.at(-1)??''),'no pipeline summary in the ops comment');
});

test('pipeline off: the grouped tool loop of before (no map, no verify turn)',async t=>{
  const {stages}=await run(t,{localReviewMode:'multiturn',localReviewPipeline:false},{review:()=>dirty});
  assert.deepEqual(stages,['review']);
});
