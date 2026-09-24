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
const overflowJson=JSON.stringify({merge_recommendation:'REQUEST_CHANGES',findings:[
  ...Array.from({length:8},(_,i)=>({...finding,file:'unchanged.ts',title:`Unchanged file ${i+1}`})),
  {...finding,title:'LOCAL-RAW ninth finding: duplicate write'},
]});

const CHAT={
  clean:cleanJson,
  findings:dirtyJson,
  // exactly what the bridge stores for an unparseable reply with JSON repair off
  unparseable:salvageReviewJson('P1 a.ts:1 CHAT-RAW duplicate write'),
  none:'{"findings":"not a list"}',
};
const fail500=res=>{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"model crashed"}');};
// Local request #i gets replies[i] (the last one repeats); a function reply answers the request itself.
const answer=(...replies)=>(res,i)=>{const r=replies[Math.min(i,replies.length-1)];typeof r==='function'?r(res):res.end(envelope(r));};
const LOCAL={
  clean:{answer:answer(cleanJson)},
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
const chatRaw=posted(SUMMARY,MR,0,{raw:['CHAT-RAW'],stamp:'none'});
const RAW_NOTE=/local verification's reply could not be used as a review/;
const RESIDUAL_NOTE=/could not be used as a review \(a completed reply carried text outside its review JSON\)/;

// [chat, local] → expected. stamp: which release the held local leg got (verify round / fallback / none).
const CELLS={
  'clean x clean':posted(CLEAN,M0,1,{note:/chatgpt found nothing; local verification agreed\./,stamp:'verify'}),
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
  ...Object.fromEntries(Object.keys(LOCAL).map(local=>[`unparseable x ${local}`,local==='notRun'?posted(SUMMARY,MR,0,{raw:['CHAT-RAW']}):chatRaw])),
  // local as the chat-down fallback is an ordinary reviewer: race parity, no verification note
  'none x clean':posted(CLEAN,M0,1,{stamp:'fallback'}),
  'none x assumesSkipped':posted(CLEAN,M0,1,{stamp:'fallback'}),
  'none x findings':posted(SUMMARY,MF,1,{stamp:'fallback'}),
  'none x unparseable':posted(SUMMARY,MR,2,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x proseThen500':posted(SUMMARY,MR,2,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x multiturnProse':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x schemaInvalid':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x malformed':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x proseThenClean':posted(SUMMARY,MR,2,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x proseThenMinimal':posted(SUMMARY,MR,2,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x overflow':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x proseAndClean':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x multiturnProseAndClean':posted(SUMMARY,MR,1,{raw:['LOCAL-RAW'],stamp:'fallback'}),
  'none x error':skipped(1),
  'none x offline':skipped(0),
  'none x notRun':skipped(0),
};

async function closedPortUrl(){
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();await new Promise(resolve=>server.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

async function runCell(t,chat,local){
  const stim=LOCAL[local];
  const settings={localReviewRole:'verify-clean',localJsonRepairEnabled:false,...stim.settings,...(stim.offline?{localLlmBaseUrl:await closedPortUrl()}:{})};
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

test('verify-clean outcome: the note credits only the chat reviewer whose structured result was clean',async t=>{
  const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false,reviewGrok:true});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention('matrix-credit');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='awaiting_chat','snapshot not ready');
  assert.equal(job().reviewProviders.join(','),'chatgpt,grok,local');
  await app.harbor.submitHarborChat(out.jobId,cleanJson,[{provider:'chatgpt',raw:cleanJson},{provider:'grok',raw:CHAT.none}]);
  await eventually(()=>app.localRequests.length===1,'clean chatgpt did not start the verification round');
  app.localResponses[0].end(envelope(cleanJson));
  await eventually(()=>app.reviews.length===1,'the verified review was not posted');
  assert.match(app.reviews[0].body,/\nchatgpt found nothing; local verification agreed\.\n/);
  assert.doesNotMatch(app.reviews[0].body,/grok found nothing/);
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
