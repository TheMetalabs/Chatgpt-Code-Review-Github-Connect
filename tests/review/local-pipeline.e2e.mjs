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

async function run(t,settings,answers,env={},respond=(res,content)=>res.end(reply(content)),github={}){
  const app=await appFixture({reviewChatgpt:false,localJsonRepairEnabled:false,localReviewPipeline:true,localPipelineLenses:1,...settings},github);t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  Object.assign(app.env,env);
  const out=await app.mention('pipeline-'+Object.values(settings).join('-'));
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  const stages=[];let answered=0;
  await eventually(()=>{
    while(answered<app.localResponses.length){
      const body=app.localRequests[answered].raw??JSON.stringify(app.localRequests[answered]);
      const s=stage(body);stages.push(s);
      respond(app.localResponses[answered],answers[s](stages.filter(x=>x===s).length,body));answered++;
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
  // local_review.pipeline_thinking (default focused), on the wire: the map turn is sent with thinking off.
  const wire=app.localRequests.map(r=>JSON.parse(r.raw??JSON.stringify(r)));
  assert.deepEqual(wire.map(b=>b.chat_template_kwargs??null),[{enable_thinking:false},null,null]);
  await eventually(()=>/Local pipeline: 1 feature group\(s\) × 1 lens\(es\), 1 candidate\(s\), 1 to verify, 1 confirmed, 0 refuted, 1 posted/.test(app.ops.at(-1)??''),'no pipeline summary in the ops comment');
});

test('pipeline off: the grouped tool loop of before (no map, no verify turn)',async t=>{
  const {stages}=await run(t,{localReviewMode:'multiturn',localReviewPipeline:false},{review:()=>dirty});
  assert.deepEqual(stages,['review']);
});

test('a streamed reply: the turn log has its time to first token, token counts and reply/reasoning sizes; the ops line sums them per stage',async t=>{
  // An SSE reply in two content chunks, then the usage chunk (stream_options.include_usage).
  const sse=(res,content)=>{
    const data=o=>`data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(data({choices:[{delta:{reasoning_content:'think'}}]}));
    res.write(data({choices:[{delta:{content:content.slice(0,5)}}]}));
    res.end(data({choices:[{delta:{content:content.slice(5)},finish_reason:'stop'}]})+data({choices:[],usage:{prompt_tokens:120,completion_tokens:30,prompt_tokens_details:{cached_tokens:60}}})+'data: [DONE]\n\n');
  };
  const lines=[];const info=console.info;console.info=(...a)=>{lines.push(a.join(' '));};
  t.after(()=>{console.info=info;});
  const {app,stages}=await run(t,{localReviewMode:'single'},{review:()=>dirty,verify:()=>confirmed},{ASHLAR_LOCAL_LLM_STREAM:'true'},sse);
  console.info=info;
  assert.deepEqual(stages,['review','verify']);
  assert.ok(lines.some(l=>new RegExp(String.raw`pipeline verify\[c1\]#1: finish=stop think=on chars=\d+ [\d.]+s ttft=[\d.]+s prompt=120 cached=60 out=30 reply=${confirmed.length}c reasoning=5c$`).test(l)),lines.filter(l=>/pipeline /.test(l)).join('\n'));
  await eventually(()=>/1 posted \(2 turns, \d+ min\) · feature 1t [\d.]+m in 120 cached 50% out 30 · verify 1t [\d.]+m in 120 cached 50% out 30/.test(app.ops.at(-1)??''),'no per-stage breakdown in the ops comment');
});

test('a partial review with no finding (one feature cut off, the other only a build claim) posts as a review, never clean',async t=>{
  // Two unrelated files, each its own feature. b.ts's turns are cut off at the output cap (no reply kept);
  // a.ts reports only a compile-error claim, which the build-claim gate drops. Before 2026-11-18 the result
  // had investigated_safe: [] and the poster rejected it, so the job failed and the run was thrown away.
  const snapshot={changedPaths:['a.ts','b.ts'],files:[{path:'a.ts',content:'export const answer = 42;\n',language:'ts'},{path:'b.ts',content:'export const other = 1;\n',language:'ts'}],
    diff:'--- a.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n\n--- b.ts\n@@ -1 +1 @@\n-export const other = 0;\n+export const other = 1;'};
  const map=JSON.stringify({files:[{file:'a.ts',summary:'changes the answer',guards:[],effects:[]},{file:'b.ts',summary:'changes other',guards:[],effects:[]}]});
  const buildClaim=JSON.stringify({findings:[{...finding,title:'answer does not compile',failure_scenario:'The build fails with a compile error.'}],merge_recommendation:'REQUEST_CHANGES',investigated_safe:['a.ts: read']});
  const cut={choices:[{finish_reason:'length',message:{content:'{"findings": ['}}]};
  const review=(_n,body)=>/one feature of this PR: b\.ts\./.test(JSON.parse(body).messages[1].content)?cut:buildClaim;
  const respond=(res,content)=>res.end(typeof content==='string'?reply(content):JSON.stringify(content));
  const {app,job,stages}=await run(t,{localReviewMode:'multiturn'},{map:()=>map,review},{ASHLAR_LOCAL_REVIEW_GROUP_MAX_CHARS:'50'},respond,{snapshot});
  assert.ok(!stages.includes('verify'),'the build claim never gets a verify turn');
  assert.equal(job.status,'posted',job.githubError||job.plan);
  assert.equal(app.reviews.length,1);
  const body=app.reviews[0].body;
  // Posted as raw evidence (outcome "raw"): not the clean sentinel, not a CONVERGED total=0 marker.
  assert.match(body,/ashlar-findings total=0 inline=0 body=1 raw=1 /);
  assert.doesNotMatch(body,/Didn't find any major issues|ashlar-coverage cleared=/);
  assert.match(body,/No complete review from local \(reply posted as evidence\)/);
  assert.match(body,/Reviewed 1 of 2 files in feature turns; no defect was confirmed \(0 candidate\(s\) refuted, 1 build\/test claim\(s\) dropped\); not reviewed: b\.ts \(feature turn failed\)/);
  assert.deepEqual([...job.incompleteProviders],['local']);
});
