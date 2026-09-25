// verify-clean outcome matrix, chat stimulus x local stimulus, through the real webhook → snapshot →
// merge → post path (docs/local-verify-clean.md §1). Every posted cell asserts the exact first line,
// trailing marker, CONVERGED, where raw evidence lands, the note and how many local requests ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {appFixture,eventually} from './app-fixture.mjs';
import {isZeroFindings} from '../../src/lib/review-loop.ts';
import {CLEAN_REVIEW_BODY,REVIEW_RAW_END,REVIEW_RAW_START,REVIEW_SUMMARY_MARK,UNVERIFIED_CLEAN_REVIEW_BODY} from '../../src/lib/review-format.ts';
import {salvageReviewJson} from '../../src/lib/extract-chat-json.ts';
import {postedOutcome} from '../../src/lib/review-outcome.ts';
import {notCleanDetail} from '../../src/lib/review-loop-runtime.server.ts';

const converged=body=>isZeroFindings(body,{authoredByBot:true});
const finding={severity:'P1',file:'a.ts',line:1,side:'RIGHT',title:'Missing check',failure_scenario:'A duplicate request writes twice',
  root_cause:'No guard',evidence:'a.ts:1: no guard',recommended_fix:'Check the key',recommended_test:'Assert one write'};
const cleanJson=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts: constant change only']});
// clean, with a free-form reviewer assumption that says "skipped" (no reviewer was skipped)
const assumesSkippedJson=JSON.stringify({...JSON.parse(cleanJson),assumptions:['Generated fixtures were skipped because they are irrelevant.']});
const dirtyJson=JSON.stringify({findings:[finding],merge_recommendation:'REQUEST_CHANGES'});
// exactly the shape the correction prompt asks for (no investigated_safe)
const minimalJson=JSON.stringify({findings:[],merge_recommendation:'COMMENT',keep:[]});
const envelope=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});
const LOCAL_RAW='P1 a.ts:1 LOCAL-RAW: a duplicate request writes twice';
// valid JSON whose only finding lacks recommended_test: the gate drops it for its shape
const {recommended_test:_test,...partial}=finding;
const malformedJson=JSON.stringify({findings:[{...partial,title:'LOCAL-RAW duplicate write'}],merge_recommendation:'REQUEST_CHANGES'});
// nine well-formed findings: the gate inspects eight, all on a file this PR does not change (policy
// drops), and never reaches the ninth, a valid P1 on the changed file
const overflowOf=mark=>JSON.stringify({merge_recommendation:'REQUEST_CHANGES',findings:[
  ...Array.from({length:8},(_,i)=>({...finding,file:'unchanged.ts',title:`Unchanged file ${i+1}`})),
  {...finding,title:`${mark} ninth finding: duplicate write`},
]});
const overflowJson=overflowOf('LOCAL-RAW');

const CHAT={
  clean:cleanJson,
  findings:dirtyJson,
  // exactly what the bridge stores for an unparseable reply with JSON repair off
  unparseable:salvageReviewJson('P1 a.ts:1 CHAT-RAW duplicate write'),
  // the gate rejects it (findings is not a list); beside a usable leg it is posted as evidence
  none:'{"findings":"CHAT-RAW not a list"}',
  // valid JSON whose only P1 lacks recommended_test: the gate drops it for its shape, so it is no verdict
  malformed:JSON.stringify({findings:[{...partial,title:'CHAT-RAW duplicate write'}],merge_recommendation:'REQUEST_CHANGES'}),
  // the same nine rows from chat: its unread ninth P1 makes it evidence, never a clean result
  overflow:overflowOf('CHAT-RAW'),
};
const fail500=res=>{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"model crashed"}');};
// Local request #i gets replies[i] (the last one repeats); a function reply answers the request itself.
const answer=(...replies)=>(res,i)=>{const r=replies[Math.min(i,replies.length-1)];typeof r==='function'?r(res):res.end(envelope(r));};
const LOCAL={
  clean:{answer:answer(cleanJson)},
  // the clean object alone inside one complete four-backtick fence: nothing outside it was discarded
  fencedClean:{answer:answer('````json\n'+cleanJson+'\n````')},
  // the clean object alone in a fence the reply never closes: CommonMark closes it at the end
  unclosedFence:{answer:answer('```json\n'+cleanJson+'\n')},
  // the clean object alone in a fence whose info string is a MIME type (any CommonMark info string)
  mimeFencedClean:{answer:answer('```application/json\n'+cleanJson+'\n```')},
  // the finding in prose on the fence marker's own line, then the clean object on that line: the prose
  // is the opener's info string (CommonMark), so the object is not inside the block and the prose stays
  sameLineFenceProse:{answer:answer('~~~ '+LOCAL_RAW+' '+cleanJson+'\n~~~')},
  assumesSkipped:{answer:answer(assumesSkippedJson)},
  findings:{answer:answer(dirtyJson)},
  unparseable:{answer:answer(LOCAL_RAW)},
  // the first reply completes with the finding in prose, then the one JSON correction fails
  proseThen500:{answer:answer(LOCAL_RAW,fail500)},
  // the multi-turn tool loop (what auto mode picks for a large PR) replying with the finding in prose
  multiturnProse:{answer:answer(LOCAL_RAW),settings:{localReviewMode:'multiturn'}},
  // the finding in prose, then a JSON object the parser accepts but the gate rejects
  schemaInvalid:{answer:answer(`${LOCAL_RAW}\n{"findings":"see above","merge_recommendation":"REQUEST_CHANGES"}`)},
  malformed:{answer:answer(malformedJson)},
  overflow:{answer:answer(overflowJson)},
  // the finding in prose, then the one JSON correction (which never sees the first reply) parses
  proseThenClean:{answer:answer(LOCAL_RAW,cleanJson)},
  proseThenMinimal:{answer:answer(LOCAL_RAW,minimalJson)},
  // one completed reply: the finding in prose, then a clean review JSON object the parser accepts
  proseAndClean:{answer:answer(`${LOCAL_RAW}\n${cleanJson}`)},
  multiturnProseAndClean:{answer:answer(`${LOCAL_RAW}\n${cleanJson}`),settings:{localReviewMode:'multiturn'}},
  error:{answer:answer(fail500)},
  offline:{offline:true},
  notRun:{settings:{reviewLocal:false}},
};

const MF='total=1 inline=1 body=0 p0=0 p1=1 p2=0';
const MR='total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0';
const MRU=MR+' unverified=1';
const M0='total=0 inline=0 body=0 p0=0 p1=0 p2=0';
const M0U=M0+' unverified=1';
const CLEAN=CLEAN_REVIEW_BODY,SUMMARY=REVIEW_SUMMARY_MARK,UNVERIFIED=UNVERIFIED_CLEAN_REVIEW_BODY;
const posted=(first,marker,requests,extra={})=>({status:'posted',first,marker,requests,converged:marker===M0,raw:[],note:null,...extra});
const skipped=requests=>({status:'skipped',requests});
const chatFindings=posted(SUMMARY,MF,0,{stamp:'none'});
// why: the raw header's cause (Job.rawCauses), never inferred from the outcome
const WHY_UNPARSEABLE='the reply was not valid review JSON.';
const WHY_UNREAD="the reply parsed, but its findings past the gate's row cap were not inspected.";
const WHY_NOT_VERDICT='the reply could not be used as a complete structured review.';
const chatRaw=why=>posted(SUMMARY,MR,0,{raw:['CHAT-RAW'],stamp:'none',why});
// local as the fallback beside chat's rejected reply: the merge posts, so that reply is evidence too
const fallback=(first,marker,requests,extra={})=>posted(first,marker,requests,{stamp:'fallback',...extra,raw:['CHAT-RAW',...(extra.raw??[])]});
const WHY_CHAT_REJECTED='ChatGPT: the reply could not be used as a complete structured review; Local LLM: ';
const RAW_NOTE=/local verification's reply could not be used as a review/;
const RESIDUAL_NOTE=/could not be used as a review \(a completed reply carried text outside its review JSON\)/;

// [chat, local] → expected. stamp: which release the held local leg got (verify round / fallback / none).
const CELLS={
  'clean x clean':posted(CLEAN,M0,1,{note:/chatgpt found nothing; local verification agreed\./,stamp:'verify'}),
  'clean x fencedClean':posted(CLEAN,M0,1,{note:/chatgpt found nothing; local verification agreed\./,stamp:'verify'}),
  'clean x unclosedFence':posted(CLEAN,M0,1,{note:/chatgpt found nothing; local verification agreed\./,stamp:'verify'}),
  'clean x mimeFencedClean':posted(CLEAN,M0,1,{note:/chatgpt found nothing; local verification agreed\./,stamp:'verify'}),
  'clean x sameLineFenceProse':posted(SUMMARY,MRU,1,{raw:['LOCAL-RAW'],note:RESIDUAL_NOTE,stamp:'verify'}),
  'clean x assumesSkipped':posted(CLEAN,M0,1,{note:/chatgpt found nothing; local verification agreed\./,stamp:'verify'}),
  'clean x findings':posted(SUMMARY,MF,1,{note:/chatgpt found nothing; local verification found 1\./,stamp:'verify'}),
  'clean x unparseable':posted(SUMMARY,MRU,2,{raw:['LOCAL-RAW'],note:RAW_NOTE,stamp:'verify'}),
  'clean x proseThen500':posted(SUMMARY,MRU,2,{raw:['LOCAL-RAW'],note:RAW_NOTE,stamp:'verify'}),
  'clean x multiturnProse':posted(SUMMARY,MRU,1,{raw:['LOCAL-RAW'],note:RAW_NOTE,stamp:'verify'}),
  'clean x schemaInvalid':posted(SUMMARY,MRU,1,{raw:['LOCAL-RAW'],note:/could not be used as a review \(empty findings without investigated_safe/,stamp:'verify'}),
  'clean x proseThenClean':posted(SUMMARY,MRU,2,{raw:['LOCAL-RAW'],note:/could not be used as a review \(a completed reply was not review JSON\)/,stamp:'verify'}),
  'clean x proseThenMinimal':posted(SUMMARY,MRU,2,{raw:['LOCAL-RAW'],note:/could not be used as a review \(empty findings without investigated_safe/,stamp:'verify'}),
  'clean x malformed':posted(SUMMARY,MRU,1,{raw:['LOCAL-RAW'],note:/could not be used as a review \(1 finding\(s\) missing required fields\)/,stamp:'verify'}),
  'clean x overflow':posted(SUMMARY,MRU,1,{raw:['LOCAL-RAW'],note:/could not be used as a review \(1 finding\(s\) past the gate's row cap were not inspected\)/,stamp:'verify'}),
  'clean x proseAndClean':posted(SUMMARY,MRU,1,{raw:['LOCAL-RAW'],note:RESIDUAL_NOTE,stamp:'verify'}),
  'clean x multiturnProseAndClean':posted(SUMMARY,MRU,1,{raw:['LOCAL-RAW'],note:RESIDUAL_NOTE,stamp:'verify'}),
  'clean x error':posted(UNVERIFIED,M0U,1,{note:/local verification did not complete \(/,stamp:'verify'}),
  'clean x offline':posted(UNVERIFIED,M0U,0,{note:/local verification did not complete \(/,stamp:'verify'}),
  'clean x notRun':posted(CLEAN,M0,0),
  ...Object.fromEntries(Object.keys(LOCAL).map(local=>[`findings x ${local}`,local==='notRun'?posted(SUMMARY,MF,0):chatFindings])),
  ...Object.fromEntries(Object.keys(LOCAL).map(local=>[`unparseable x ${local}`,local==='notRun'?posted(SUMMARY,MR,0,{raw:['CHAT-RAW'],why:WHY_UNPARSEABLE}):chatRaw(WHY_UNPARSEABLE)])),
  // chat's unread rows are evidence: never verify / verified-clean / clean, local stays held
  ...Object.fromEntries(Object.keys(LOCAL).map(local=>[`overflow x ${local}`,local==='notRun'?posted(SUMMARY,MR,0,{raw:['CHAT-RAW'],why:WHY_UNREAD}):chatRaw(WHY_UNREAD)])),
  // a P1 the gate dropped for its shape leaves chat without a complete verdict: evidence, local held
  ...Object.fromEntries(Object.keys(LOCAL).map(local=>[`malformed x ${local}`,local==='notRun'?posted(SUMMARY,MR,0,{raw:['CHAT-RAW'],why:WHY_NOT_VERDICT}):chatRaw(WHY_NOT_VERDICT)])),
  // local as the chat-down fallback is an ordinary reviewer (race parity, no verification note), and
  // chat's rejected reply is no verdict: it posts beside local's result as evidence, never clean
  'none x clean':fallback(SUMMARY,MR,1,{why:WHY_NOT_VERDICT}),
  'none x fencedClean':fallback(SUMMARY,MR,1,{why:WHY_NOT_VERDICT}),
  'none x unclosedFence':fallback(SUMMARY,MR,1,{why:WHY_NOT_VERDICT}),
  'none x mimeFencedClean':fallback(SUMMARY,MR,1,{why:WHY_NOT_VERDICT}),
  'none x sameLineFenceProse':fallback(SUMMARY,MR,1,{raw:['LOCAL-RAW']}),
  'none x assumesSkipped':fallback(SUMMARY,MR,1,{why:WHY_NOT_VERDICT}),
  'none x findings':fallback(SUMMARY,MF,1),
  'none x unparseable':fallback(SUMMARY,MR,2,{raw:['LOCAL-RAW'],why:WHY_CHAT_REJECTED+WHY_UNPARSEABLE}),
  'none x proseThen500':fallback(SUMMARY,MR,2,{raw:['LOCAL-RAW']}),
  'none x multiturnProse':fallback(SUMMARY,MR,1,{raw:['LOCAL-RAW']}),
  'none x schemaInvalid':fallback(SUMMARY,MR,1,{raw:['LOCAL-RAW']}),
  'none x malformed':fallback(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_CHAT_REJECTED+WHY_NOT_VERDICT}),
  'none x proseThenClean':fallback(SUMMARY,MR,2,{raw:['LOCAL-RAW']}),
  'none x proseThenMinimal':fallback(SUMMARY,MR,2,{raw:['LOCAL-RAW']}),
  'none x overflow':fallback(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_CHAT_REJECTED+WHY_UNREAD}),
  'none x proseAndClean':fallback(SUMMARY,MR,1,{raw:['LOCAL-RAW']}),
  'none x multiturnProseAndClean':fallback(SUMMARY,MR,1,{raw:['LOCAL-RAW']}),
  'none x error':skipped(1),
  'none x offline':skipped(0),
  'none x notRun':skipped(0),
};

async function closedPortUrl(){
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();await new Promise(resolve=>server.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

async function runCell(t,chat,local,role='verify-clean'){
  const stim=LOCAL[local];
  const settings={localReviewRole:role,localJsonRepairEnabled:false,...stim.settings,...(stim.offline?{localLlmBaseUrl:await closedPortUrl()}:{})};
  const app=await appFixture(settings);t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention(`matrix-${chat}-${local}`);
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId,CHAT[chat]);
  // Answer every local request as it arrives, noting whether a review had already posted then.
  let answered=0,postedBeforeLocal=false;
  await eventually(()=>{
    while(answered<app.localResponses.length){postedBeforeLocal||=app.reviews.length>0;stim.answer(app.localResponses[answered],answered);answered++;}
    return ['posted','skipped','dlq','cancelled'].includes(job().status);
  },`${chat} x ${local}: the job never finished`);
  await new Promise(resolve=>setTimeout(resolve,150));
  return {app,job:job(),jobId:out.jobId,postedBeforeLocal};
}

function assertPosted(name,e,{app,job},body){
  assert.equal(body.split('\n')[0],e.first,`${name}: first line`);
  assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],e.marker,`${name}: trailing marker`);
  assert.equal(converged(body),e.converged,`${name}: CONVERGED`);
  assert.equal(body.toLowerCase().includes("didn't find any major issues"),e.converged,`${name}: clean sentinel iff converged`);
  const start=body.indexOf(REVIEW_RAW_START),end=body.indexOf(REVIEW_RAW_END);
  const outside=start<0?body:body.slice(0,start)+body.slice(end);
  for(const mark of ['CHAT-RAW','LOCAL-RAW']){
    assert.equal(body.includes(mark),e.raw.includes(mark),`${name}: ${mark} kept iff expected`);
    assert.equal(outside.includes(mark),false,`${name}: ${mark} only inside the raw block`);
  }
  if(e.why)assert.equal(/\*\*⚠️ Review posted verbatim — ([^*]*)\*\*/.exec(body)?.[1],e.why,`${name}: why the raw block is posted`);
  assert.doesNotMatch(body,/local repair/i,`${name}: local repair never causes an outcome`);
  // a body that is not clean never carries the converging total=0 marker (unverified=1 is not one)
  if(!e.converged)assert.doesNotMatch(body,/ashlar-findings total=0 inline=0 body=0 p0=0 p1=0 p2=0 -->/,`${name}: no converging total=0 marker`);
  if(e.note)assert.match(body,e.note,`${name}: note`);
  else assert.doesNotMatch(body,/local verification/,`${name}: no verification note`);
  if(e.stamp==='verify')assert.ok(job.localVerifyStartedAt&&!job.localFallbackAt,`${name}: verification round stamp`);
  // local verified only when its reply was a structured verdict: never with raw evidence or no reply
  if(e.stamp==='verify')assert.equal(job.localVerified,e.marker!==MRU&&e.marker!==M0U,`${name}: localVerified`);
  if(e.stamp==='fallback')assert.ok(job.localFallbackAt&&!job.localVerifyStartedAt,`${name}: fallback stamp`);
  if(e.stamp==='none')assert.ok(!job.localFallbackAt&&!job.localVerifyStartedAt,`${name}: local stayed held`);
  assert.equal(app.reviews.length,1,`${name}: exactly one review`);
}

test('verify-clean outcome: every chat × local stimulus has a decided cell',()=>{
  const missing=Object.keys(CHAT).flatMap(chat=>Object.keys(LOCAL).map(local=>`${chat} x ${local}`)).filter(name=>!CELLS[name]);
  assert.deepEqual(missing,[]);
});

for(const [name,e] of Object.entries(CELLS)){
  test(`verify-clean outcome: chat ${name.replace(' x ',' × local ')}`,async t=>{
    const [chat,local]=name.split(' x ');
    const run=await runCell(t,chat,local);
    const {app,job,jobId,postedBeforeLocal}=run;
    assert.equal(job.status,e.status,`${name}: status`);
    assert.equal(app.localRequests.length,e.requests,`${name}: local requests`);
    assert.equal(postedBeforeLocal,false,`${name}: nothing posts while the local leg is running`);
    assert.equal(app.harbor.hasLocalSample(jobId),false,`${name}: local snapshot released`);
    if(e.status==='skipped'){assert.equal(app.reviews.length,0,`${name}: no review`);return;}
    assertPosted(name,e,run,app.reviews[0].body);
  });
}

// Race is where the unread-row case posted clean and CONVERGED before: chat's ninth row was never read.
test('race outcome: chat overflow × local clean is evidence, never clean or CONVERGED',async t=>{
  const app=await appFixture({localReviewRole:'race',localJsonRepairEnabled:false});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention('race-chat-overflow');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId,CHAT.overflow);
  await eventually(()=>app.localRequests.length===1,'race did not start local');
  app.localResponses[0].end(envelope(cleanJson));
  await eventually(()=>app.reviews.length===1,'the review was not posted');
  const body=app.reviews[0].body;
  assert.equal(body.split('\n')[0],SUMMARY,'not the clean first line');
  assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],MR,'raw marker');
  assert.equal(converged(body),false,'never CONVERGED');
  const start=body.indexOf(REVIEW_RAW_START);
  assert.ok(start>=0&&body.indexOf('CHAT-RAW ninth finding')>start,'the unread ninth row is posted in the raw block');
  assert.ok(job().assumptions.includes("chatgpt: 1 finding(s) past the gate's row cap were not inspected (reply posted verbatim)"),'the job records why');
  // The reply parsed: the body and the loop handoff name the unread rows, never a parse failure or local repair.
  assert.deepEqual({...job().rawCauses},{chatgpt:'unread-rows'},'the merge stamps the structured cause');
  assert.match(body,/Review posted verbatim — the reply parsed, but its findings past the gate's row cap were not inspected\./,'the body names the row cap');
  assert.doesNotMatch(body,/not parseable|not valid review JSON|local repair/i,'the body never calls the parsed reply unparseable');
  const handoff=notCleanDetail(job(),postedOutcome(job(),0));
  assert.match(handoff,/row cap were not inspected/,'the loop handoff names the row cap');
  assert.doesNotMatch(handoff,/not parseable|not valid review JSON|local repair/i,'the loop handoff never calls it a parse failure');
});

// The bridge (repair off) salvages a reply that parses as JSON but fails the review schema exactly as
// it salvages prose, so the pre-gate cause's text must hold for both: never "not parseable".
test('race outcome: a parseable chat reply the review schema rejects is posted verbatim as not valid review JSON, never as unparseable',async t=>{
  const app=await appFixture({localReviewRole:'race',localJsonRepairEnabled:false,reviewLocal:false});t.after(()=>app.close());
  const out=await app.mention('race-chat-schema-invalid');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take=app.bridge.takeNextBridgeJob('schema-client');
  assert.equal(take?.jobId,out.jobId,'the bridge claims the job');
  // valid JSON; its one finding carries a key the review schema does not allow
  const parseable=JSON.stringify({findings:[{...finding,title:'CHAT-RAW duplicate write',confidence:'high'}],merge_recommendation:'REQUEST_CHANGES'});
  assert.equal((await app.bridge.completeBridgeJob(out.jobId,parseable,[{provider:'chatgpt',raw:parseable}],take.leaseId)).ok,true);
  await eventually(()=>app.reviews.length===1,'the review was not posted');
  const body=app.reviews[0].body;
  assert.ok(body.indexOf('CHAT-RAW duplicate write')>body.indexOf(REVIEW_RAW_START),'the reply is posted in the raw block');
  assert.deepEqual({...job().rawCauses},{chatgpt:'unparseable'},'a pre-gate salvage');
  assert.match(body,/Review posted verbatim — the reply was not valid review JSON\./);
  assert.doesNotMatch(body,/not parseable/i,'a reply that parsed as JSON is never called unparseable');
  const handoff=notCleanDetail(job(),postedOutcome(job(),0));
  assert.match(handoff,/posted verbatim: the reply was not valid review JSON/);
  assert.doesNotMatch(handoff,/not parseable/i,'nor in the loop handoff');
});

// Race: the complete-verdict rule (docs §1) on the default role. Each chat × local pair posts through the
// same path as the verify-clean matrix; only a leg that is its reviewer's complete verdict earns clean.
const RACE_CELLS={
  'clean x clean':posted(CLEAN,M0,1),
  'clean x unclosedFence':posted(CLEAN,M0,1),
  'clean x mimeFencedClean':posted(CLEAN,M0,1),
  'clean x sameLineFenceProse':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_NOT_VERDICT}),
  // a reply the gate rejects beside a usable one is evidence, never a clean total=0
  'none x clean':posted(SUMMARY,MR,1,{raw:['CHAT-RAW'],why:WHY_NOT_VERDICT}),
  'malformed x clean':posted(SUMMARY,MR,1,{raw:['CHAT-RAW'],why:WHY_NOT_VERDICT}),
  'clean x malformed':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_NOT_VERDICT}),
  'clean x schemaInvalid':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_NOT_VERDICT}),
  // the first reply set aside for the JSON correction, or prose around the accepted object, is evidence
  'clean x proseThenClean':posted(SUMMARY,MR,2,{raw:['LOCAL-RAW'],why:WHY_NOT_VERDICT}),
  'clean x proseAndClean':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_NOT_VERDICT}),
  'clean x multiturnProseAndClean':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_NOT_VERDICT}),
  // a leg that failed after completing a reply keeps that reply as evidence, never "Skipped local":
  // the correction replied in prose too, or failed outright, or the multi-turn group did
  'clean x unparseable':posted(SUMMARY,MR,2,{raw:['LOCAL-RAW'],why:WHY_UNPARSEABLE}),
  'clean x proseThen500':posted(SUMMARY,MR,2,{raw:['LOCAL-RAW'],why:WHY_UNPARSEABLE}),
  'clean x multiturnProse':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],why:WHY_UNPARSEABLE}),
  // with no usable leg a rejected reply still skips (nothing posts, nothing claims clean)
  'none x error':skipped(1),
};
for(const [name,e] of Object.entries(RACE_CELLS)){
  test(`race outcome: chat ${name.replace(' x ',' × local ')}`,async t=>{
    const [chat,local]=name.split(' x ');
    const run=await runCell(t,chat,local,'race');
    const {app,job}=run;
    assert.equal(job.status,e.status,`${name}: status`);
    assert.equal(app.localRequests.length,e.requests,`${name}: local requests`);
    if(e.status==='skipped'){assert.equal(app.reviews.length,0,`${name}: no review`);return;}
    assertPosted(`race ${name}`,e,run,app.reviews[0].body);
    const incomplete=[...(job.incompleteProviders??[])];
    assert.deepEqual(incomplete,e.converged?[]:[e.raw.includes('CHAT-RAW')?'chatgpt':'local'],`${name}: the reviewer without a complete verdict`);
  });
}

// ChatGPT clean beside a Grok reply the gate rejects: Grok returned no verdict, so the result is not
// clean and never starts (or passes) a verification round. Grok's reply is evidence, posted verbatim.
test('verify-clean outcome: clean ChatGPT beside a gate-rejected Grok is evidence, never verified-clean or CONVERGED',async t=>{
  const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false,reviewGrok:true});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention('matrix-rejected-peer');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  assert.equal(job().reviewProviders.join(','),'chatgpt,grok,local');
  const grok='{"findings":"GROK-RAW P1 a.ts:1 duplicate write","merge_recommendation":"REQUEST_CHANGES"}';
  await app.harbor.submitHarborChat(out.jobId,cleanJson,[{provider:'chatgpt',raw:cleanJson},{provider:'grok',raw:grok}]);
  await eventually(()=>app.reviews.length===1,'the review was not posted');
  await new Promise(resolve=>setTimeout(resolve,150));
  const body=app.reviews[0].body;
  assert.equal(app.localRequests.length,0,'no verification round for a result with a rejected reviewer');
  assert.equal(body.split('\n')[0],SUMMARY,'not the clean first line');
  assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],MR,'raw marker, never total=0');
  assert.equal(converged(body),false,'never CONVERGED');
  assert.doesNotMatch(body,/didn't find any major issues|local verification agreed/i);
  const start=body.indexOf(REVIEW_RAW_START);
  assert.ok(start>=0&&body.indexOf('GROK-RAW P1 a.ts:1 duplicate write')>start,'the rejected reply is kept in the raw block');
  assert.deepEqual([...job().incompleteProviders],['grok'],'grok gave no complete verdict');
  assert.deepEqual({...job().rawCauses},{grok:'not-a-verdict'});
  assert.match(body,/- No complete review from grok \(reply posted as evidence\)/);
  assert.equal(job().localVerifyStartedAt,undefined,'local stays held');
});

// chat clean with a skipped chat peer (grok quota) × local: the round is incomplete whatever local
// did, so the note alone tells an agreeing verification from a failed one; raw evidence still wins.
const SKIPPED_PEER={
  clean:{marker:undefined,raw:[],note:/\nchatgpt found nothing; local verification agreed\.\n/},
  error:{marker:undefined,raw:[],note:/\nchatgpt found nothing; local verification did not complete \(/},
  unparseable:{marker:MRU,raw:['LOCAL-RAW'],note:RAW_NOTE},
};
for(const [local,e] of Object.entries(SKIPPED_PEER)){
  test(`verify-clean outcome: chat clean + grok skipped × local ${local}`,async t=>{
    const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false,reviewGrok:true});t.after(()=>app.close());
    app.env.ASHLAR_LOCAL_LLM_STREAM='false';
    const out=await app.mention(`matrix-skipped-peer-${local}`);
    const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
    await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
    app.bridge.bridgeHeartbeat();
    const take=app.bridge.takeNextBridgeJob('matrix-client');
    assert.equal(take?.jobId,out.jobId,'the bridge claims the job');
    assert.equal(app.bridge.failBridgeProvider(out.jobId,'grok','quota: usage limit reached',take.leaseId),true);
    assert.equal((await app.bridge.completeBridgeJob(out.jobId,cleanJson,[{provider:'chatgpt',raw:cleanJson}],take.leaseId)).ok,true);
    let answered=0;
    await eventually(()=>{
      while(answered<app.localResponses.length){LOCAL[local].answer(app.localResponses[answered],answered);answered++;}
      return app.reviews.length===1;
    },'the review was not posted');
    const body=app.reviews[0].body;
    assert.ok(job().localVerifyStartedAt,'a verification round ran');
    assert.equal(body.split('\n')[0],SUMMARY);
    assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],e.marker,'trailing marker');
    assert.equal(converged(body),false,'never CONVERGED with a reviewer skipped');
    assert.match(body,/- Skipped grok/);
    assert.match(body,e.note,'the verification note');
    for(const mark of ['LOCAL-RAW'])assert.equal(body.includes(mark),e.raw.includes(mark),`${mark} kept iff expected`);
    const note=body.match(e.note)[0].trim();
    await eventually(()=>(app.ops.at(-1)??'').includes(note),'the ops comment does not carry the same note');
  });
}

// A chat run that started before the verification round can land during it (Grok here, after its
// quota report let ChatGPT's clean result start the round). Its finding posts, and the note credits it
// to Grok: local verification is never said to have found what another reviewer reported.
test('verify-clean outcome: a late chat finding during the verification round is attributed to its reviewer, never to local',async t=>{
  const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false,reviewGrok:true});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention('matrix-late-grok');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take=app.bridge.takeNextBridgeJob('matrix-client');
  assert.equal(take?.jobId,out.jobId,'the bridge claims the job');
  assert.equal(app.bridge.failBridgeProvider(out.jobId,'grok','quota: usage limit reached',take.leaseId),true);
  assert.equal((await app.bridge.completeBridgeJob(out.jobId,cleanJson,[{provider:'chatgpt',raw:cleanJson}],take.leaseId)).ok,true);
  await eventually(()=>app.localRequests.length===1,'clean chatgpt did not start the verification round');
  assert.deepEqual([...job().localVerifyChat],['chatgpt']);
  // Grok's already-started run lands while local is still verifying.
  assert.equal((await app.bridge.completeBridgeJob(out.jobId,dirtyJson,[{provider:'grok',raw:dirtyJson}],take.leaseId)).ok,true);
  await eventually(()=>job().storedLegs.some(l=>l.provider==='grok'),'the late grok result was not kept');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(app.reviews.length,0,'nothing posts while local verifies');
  app.localResponses[0].end(envelope(cleanJson));
  await eventually(()=>app.reviews.length===1,'the review was not posted');
  const body=app.reviews[0].body;
  assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],MF,'grok\'s P1 posts');
  assert.doesNotMatch(body,/local verification found 1/,'the finding is never credited to local');
  const note='chatgpt found nothing; grok found 1; local verification found nothing.';
  assert.equal(job().localVerifyNote,note);
  assert.ok(body.includes(`\n${note}\n`),'the body carries the attributed note');
  await eventually(()=>(app.ops.at(-1)??'').includes(note),'the ops comment does not carry the same note');
});

// The same late Grok run, but its reply is not a verdict (the bridge salvages it, or the gate rejects
// it beside clean ChatGPT) while local verification fails with no reply at all: the raw block holds
// only Grok's reply, so it is plain raw evidence. The header, the note and the loop handoff never
// credit that reply to local verification, and the note still says local did not complete.
const LATE_GROK={
  malformed:{reply:JSON.stringify({findings:[{...partial,title:'GROK-RAW duplicate write'}],merge_recommendation:'REQUEST_CHANGES'}),cause:'unparseable'},
  rejected:{reply:'{"findings":"GROK-RAW not a list"}',cause:'unparseable'},
  emptyWithoutSafe:{reply:'{"findings":[],"merge_recommendation":"APPROVE","highest_risk":"GROK-RAW instant"}',cause:'not-a-verdict'},
};
for(const [name,grok] of Object.entries(LATE_GROK)){
  test(`verify-clean outcome: a late ${name} grok reply beside a failed verification is grok's raw evidence, never local's`,async t=>{
    const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false,reviewGrok:true});t.after(()=>app.close());
    app.env.ASHLAR_LOCAL_LLM_STREAM='false';
    const out=await app.mention(`matrix-late-grok-raw-${name}`);
    const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
    await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
    app.bridge.bridgeHeartbeat();
    const take=app.bridge.takeNextBridgeJob('matrix-client');
    assert.equal(app.bridge.failBridgeProvider(out.jobId,'grok','quota: usage limit reached',take.leaseId),true);
    assert.equal((await app.bridge.completeBridgeJob(out.jobId,cleanJson,[{provider:'chatgpt',raw:cleanJson}],take.leaseId)).ok,true);
    await eventually(()=>app.localRequests.length===1,'clean chatgpt did not start the verification round');
    assert.equal((await app.bridge.completeBridgeJob(out.jobId,grok.reply,[{provider:'grok',raw:grok.reply}],take.leaseId)).ok,true);
    await eventually(()=>job().storedLegs.some(l=>l.provider==='grok'),'the late grok reply was not kept');
    fail500(app.localResponses[0]);
    await eventually(()=>app.reviews.length===1,'the review was not posted');
    const body=app.reviews[0].body;
    const raw=body.slice(body.indexOf(REVIEW_RAW_START),body.indexOf(REVIEW_RAW_END));
    assert.ok(raw.includes('GROK-RAW'),'grok\'s reply is the raw block');
    assert.doesNotMatch(raw,/LOCAL-RAW|model crashed/,'local wrote nothing into it');
    assert.deepEqual({...job().rawCauses},{grok:grok.cause});
    assert.equal(job().localVerified,false);
    assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],MR,'raw evidence, never CONVERGED');
    assert.equal(converged(body),false);
    assert.doesNotMatch(body,/Local verification reply posted verbatim/,'the header never calls grok\'s reply local verification\'s');
    assert.match(body,/\*\*⚠️ Review posted verbatim — /);
    const note=job().localVerifyNote;
    assert.match(note,/^chatgpt found nothing; local verification did not complete \(local LLM HTTP 500[^)]*\); grok's reply could not be used as a review and is posted verbatim below\. Not a clean pass\.$/);
    assert.doesNotMatch(note,/local verification's reply/);
    assert.ok(body.includes(`\n${note}\n`),'the body carries the note');
    const handoff=notCleanDetail(job(),postedOutcome(job(),0));
    assert.doesNotMatch(handoff,/local verification's reply/,'nor does the loop handoff');
    assert.match(handoff,/^posted verbatim: /);
  });
}

// The raw block is held under GitHub's body limit per reply, never by cutting the concatenation: a
// late Grok reply longer than the whole limit, ahead of local verification's in the block, used to
// take all of it, and the body still said local's reply was posted verbatim. The outcome, header, note
// and handoff describe the block as posted.
const LONG_GROK=`P1 a.ts:1 GROK-RAW ${'g'.repeat(70_000)} GROK-END`;
const TRUNCATED_LOCAL={
  // local's reply is short: it keeps its whole reply, so the block is local verification's reply
  short:{reply:LOCAL_RAW,marker:MRU,localInFull:true},
  // local's reply is long too: both are cut to equal shares, so the block holds neither in full
  long:{reply:`${LOCAL_RAW} ${'l'.repeat(40_000)} LOCAL-END`,marker:MR,localInFull:false},
};
for(const [name,local] of Object.entries(TRUNCATED_LOCAL)){
  test(`verify-clean outcome: a late grok reply over the body limit never crowds out a ${name} local verification reply, and the body says what it holds`,async t=>{
    const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false,reviewGrok:true});t.after(()=>app.close());
    app.env.ASHLAR_LOCAL_LLM_STREAM='false';
    const out=await app.mention(`matrix-late-grok-long-${name}`);
    const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
    await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
    app.bridge.bridgeHeartbeat();
    const take=app.bridge.takeNextBridgeJob('matrix-client');
    assert.equal(app.bridge.failBridgeProvider(out.jobId,'grok','quota: usage limit reached',take.leaseId),true);
    assert.equal((await app.bridge.completeBridgeJob(out.jobId,cleanJson,[{provider:'chatgpt',raw:cleanJson}],take.leaseId)).ok,true);
    await eventually(()=>app.localRequests.length===1,'clean chatgpt did not start the verification round');
    assert.equal((await app.bridge.completeBridgeJob(out.jobId,LONG_GROK,[{provider:'grok',raw:LONG_GROK}],take.leaseId)).ok,true);
    await eventually(()=>job().storedLegs.some(l=>l.provider==='grok'),'the late grok reply was not kept');
    let answered=0;
    await eventually(()=>{while(answered<app.localResponses.length)app.localResponses[answered++].end(envelope(local.reply));return app.reviews.length===1;},'the review was not posted');
    const body=app.reviews[0].body;
    const raw=body.slice(body.indexOf(REVIEW_RAW_START),body.indexOf(REVIEW_RAW_END));
    assert.match(raw,/\*\*Grok:\*\*\n\nDetected severity markers: P1\.\n\nP1 a\.ts:1 GROK-RAW g+\n\n…\(Grok reply truncated to fit GitHub's review body limit/,'grok\'s reply keeps its start and its own marker');
    assert.doesNotMatch(raw,/GROK-END/);
    assert.ok(raw.includes('LOCAL-RAW'),'local verification\'s reply is in the block, never crowded out');
    assert.equal(raw.includes(local.reply),local.localInFull,'local\'s reply is whole iff it fits its share');
    assert.deepEqual([...(job().rawTruncated??[])],local.localInFull?['grok']:['grok','local']);
    // where each reply ends in the block, so a body cut further names exactly whose
    const legs=job().rawLegs??[];
    assert.deepEqual([...legs.map(l=>l.provider)],['grok','local']);
    assert.equal(legs[1].end,job().rawReview.length);
    assert.match(job().rawReview.slice(0,legs[0].end),/…\(Grok reply truncated[^)]*\)$/);
    assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],local.marker);
    assert.equal(converged(body),false);
    const handoff=notCleanDetail(job(),postedOutcome(job(),0));
    if(local.localInFull){
      assert.match(body,/Local verification reply posted verbatim — it could not be used as a review\./);
      assert.match(job().localVerifyNote,/local verification's reply could not be used as a review \([^)]*\); it is posted verbatim below\./);
    }else{
      assert.doesNotMatch(body,/Local verification reply posted verbatim/,'a cut reply is never called local verification\'s verbatim reply');
      assert.match(body,/\*\*⚠️ Review posted verbatim — Grok: the reply was not valid review JSON \(truncated below[^)]*\); Local LLM: the reply was not valid review JSON \(truncated below to fit GitHub's review body limit, full original in review history\)\.\*\*/);
      assert.equal(job().localVerifyNote,"chatgpt found nothing; local verification's reply could not be used as a review (not review JSON); grok's reply could not be used as a review either; posted below (grok + local verification truncated to fit GitHub's review body limit, full originals in review history). Not a clean pass.");
      assert.match(handoff,/^posted verbatim: Grok: [^;]*truncated below[^;]*; Local LLM: [^(]*\(truncated below/,'the loop handoff names the cut too');
    }
    assert.ok(body.includes(`\n${job().localVerifyNote}\n`),'the body carries the note');
  });
}

// The block is sized as the body renders it: each `-->` is neutralized to `--&gt;` (+3). A 52,000-
// character reply quoting a mermaid chart fit the 60,000 limit by its own length, so the merge called it
// whole (raw-unverified) and GitHub's cap then cut its end under "Local verification reply posted
// verbatim".
test('verify-clean outcome: a local verification reply that the body lengthens is cut to fit, and the body, note and handoff say so',async t=>{
  const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention('matrix-neutralized-local');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId,cleanJson);
  const reply=`${LOCAL_RAW}\n${'A --> B\n'.repeat(6_500)}LOCAL-END`;
  assert.ok(reply.length<60_000&&reply.length+3*6_500>60_000,'fits only by its own length');
  let answered=0;
  await eventually(()=>{while(answered<app.localResponses.length)app.localResponses[answered++].end(envelope(reply));return app.reviews.length===1;},'the review was not posted');
  const body=app.reviews[0].body;
  assert.ok(body.length<=65_000,`under GitHub's limit: ${body.length}`);
  assert.doesNotMatch(body,/review body truncated to fit GitHub's limit/,'GitHub\'s cap never cuts the body');
  const raw=body.slice(body.indexOf(REVIEW_RAW_START),body.indexOf(REVIEW_RAW_END));
  assert.ok(body.includes(REVIEW_RAW_END),'the block is whole');
  assert.ok(raw.includes(LOCAL_RAW),'local\'s reply keeps its start');
  assert.match(raw.slice(-200),/A --&gt; B\n(A[^\n]*)?\n\n…\(truncated to fit GitHub's review body limit; full original responses retained in review history\)\n$/,'and ends in its own marker');
  assert.doesNotMatch(raw,/LOCAL-END/);
  assert.deepEqual([...(job().rawTruncated??[])],['local']);
  assert.doesNotMatch(body,/Local verification reply posted verbatim|posted verbatim below/,'a cut reply is never called verbatim');
  assert.match(body,/\*\*⚠️ Review posted verbatim — the reply was not valid review JSON \(truncated below to fit GitHub's review body limit, full original in review history\)\.\*\*/);
  assert.equal(/<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1],MR,'plain raw, never raw-unverified');
  assert.match(job().localVerifyNote,/^chatgpt found nothing; local verification's reply could not be used as a review \([^)]*\); posted below \(local verification truncated to fit GitHub's review body limit, full originals in review history\)\. Not a clean pass\.$/);
  assert.ok(body.includes(`\n${job().localVerifyNote}\n`),'the body carries the note');
  assert.match(notCleanDetail(job(),postedOutcome(job(),0)),/^posted verbatim: the reply was not valid review JSON \(truncated below/,'the loop handoff names the cut');
});

// Scope of the residual-text rule (docs §1): it is local-only. A chat leg's verdict is the review JSON
// its client submits. The extension picks that object out of the page and sends the turn capture
// beside it (originalText): rendered code-block labels, reasoning summaries and page text the server
// cannot tell from prose, so the capture is archived in review history and never judged. Text around
// the JSON of a chat reply submitted as text is archived the same way. If this scope changes, the
// docs change with it.
const CAPTURE='Thought for 12s\nP1 a.ts:1 CAPTURE-PROSE: a duplicate request writes twice\njson\n'+cleanJson;
const CHAT_SHAPES={
  // what the extension sends: the harvested object, the page capture beside it
  'page capture':{raw:cleanJson,originalText:CAPTURE},
  // a reply submitted as text: the bridge canonicalizes it to its object
  'submitted reply text':{raw:'P1 a.ts:1 CAPTURE-PROSE: a duplicate request writes twice\n```json\n'+cleanJson+'\n```'},
};
for(const role of ['race','verify-clean'])for(const [shape,leg] of Object.entries(CHAT_SHAPES)){
  test(`${role} outcome: a chat leg's verdict is the JSON it submitted; the ${shape} around it is archived, not judged`,async t=>{
    const app=await appFixture({localReviewRole:role,localJsonRepairEnabled:false});t.after(()=>app.close());
    app.env.ASHLAR_LOCAL_LLM_STREAM='false';
    const out=await app.mention(`scope-chat-capture-${role}-${shape.replace(/ /g,'-')}`);
    const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
    await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
    app.bridge.bridgeHeartbeat();
    const take=app.bridge.takeNextBridgeJob('scope-client');
    assert.equal((await app.bridge.completeBridgeJob(out.jobId,leg.raw,[{provider:'chatgpt',...leg}],take.leaseId)).ok,true);
    let answered=0;
    await eventually(()=>{while(answered<app.localResponses.length)app.localResponses[answered++].end(envelope(cleanJson));return app.reviews.length===1;},'the review was not posted');
    const body=app.reviews[0].body;
    assert.equal(app.localRequests.length,1,role==='race'?'local raced':'the chat verdict started the verification round');
    assert.equal(body.split('\n')[0],CLEAN,'the submitted JSON is the chat verdict');
    assert.equal(converged(body),true);
    assert.deepEqual([...(job().incompleteProviders??[])],[]);
    assert.doesNotMatch(body,/CAPTURE-PROSE/,'the capture is not posted as evidence');
    const archived=app.history.getJob(out.jobId,true).responses.chatgpt;
    assert.ok(archived.original.includes('CAPTURE-PROSE'),'the whole reply is archived in review history');
    assert.equal(archived.json,cleanJson);
  });
}

// The same scope for a chat leg that is not a verdict: its evidence is the JSON its client submitted,
// never the page capture beside it. Overflow JSON is stored as submitted with JSON repair off; a
// malformed or rejected one reaches the gate only when repair is on (off, the bridge salvages the
// submitted text); a rejected one is posted as evidence beside local's usable result.
const CHAT_DEFECTS={
  overflow:{label:'an overflowing',raw:CHAT.overflow,repair:false,cause:'unread-rows'},
  malformed:{label:'a malformed',raw:CHAT.malformed,repair:true,cause:'not-a-verdict'},
  rejected:{label:'a rejected',raw:CHAT.none,repair:true,cause:'not-a-verdict'},
};
for(const role of ['race','verify-clean'])for(const [defect,{label,raw,repair,cause}] of Object.entries(CHAT_DEFECTS)){
  test(`${role} outcome: ${label} chat leg posts the JSON it submitted as evidence, never its page capture`,async t=>{
    const app=await appFixture({localReviewRole:role,localJsonRepairEnabled:repair},{});t.after(()=>app.close());
    app.env.ASHLAR_LOCAL_LLM_STREAM='false';
    const out=await app.mention(`scope-chat-capture-evidence-${role}-${defect}`);
    const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
    await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
    app.bridge.bridgeHeartbeat();
    const take=app.bridge.takeNextBridgeJob('scope-client');
    const originalText='Thought for 12s\nP1 a.ts:1 CAPTURE-PROSE: a duplicate request writes twice\njson\n'+raw;
    assert.equal((await app.bridge.completeBridgeJob(out.jobId,raw,[{provider:'chatgpt',raw,originalText}],take.leaseId)).ok,true);
    let answered=0;
    await eventually(()=>{while(answered<app.localResponses.length)app.localResponses[answered++].end(envelope(cleanJson));return app.reviews.length===1;},'the review was not posted');
    const body=app.reviews[0].body;
    const start=body.indexOf(REVIEW_RAW_START),end=body.indexOf(REVIEW_RAW_END);
    assert.ok(start>=0&&end>start,'the chat leg posts as raw evidence');
    assert.ok(body.slice(start,end).includes('CHAT-RAW'),'the submitted JSON is the evidence');
    assert.equal(job().rawCauses?.chatgpt,cause,'converted at the gate, not salvaged by the bridge');
    assert.doesNotMatch(body,/CAPTURE-PROSE|Thought for 12s/,'the page capture is not posted');
    assert.ok(app.history.getJob(out.jobId,true).responses.chatgpt.original.includes('CAPTURE-PROSE'),'review history keeps the capture');
  });
}
