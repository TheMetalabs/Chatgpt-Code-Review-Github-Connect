// Every path that ends a job goes through transitionJob, and terminal cleanup runs there once
// (docs/local-verify-clean.md §3). One row per terminal path; each asserts the job status, how many
// local requests ran, that the local snapshot is freed, how many reviews posted, that the reviewer
// watcher stops, and whether an in-flight local request was aborted. Rows are verify-clean unless
// named race (race behavior must not change).
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';
import {isZeroFindings} from '../../src/lib/review-loop.ts';
import {CLEAN_REVIEW_BODY} from '../../src/lib/review-format.ts';

const finding={severity:'P1',file:'a.ts',line:1,side:'RIGHT',title:'Missing check',failure_scenario:'A duplicate request writes twice',
  root_cause:'No guard',evidence:'a.ts:1: no guard',recommended_fix:'Check the key',recommended_test:'Assert one write'};
const clean=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts: constant change only']});
const dirty=JSON.stringify({findings:[finding],merge_recommendation:'REQUEST_CHANGES'});
const none='{"findings":"not a list"}';
// a complete clean review whose own free-form assumption says "skipped": no reviewer was skipped
const cleanAssumesSkipped=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts: constant change only'],
  assumptions:['Generated fixtures were skipped because they are irrelevant.']});
const reply=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});
const fail500=res=>{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"model crashed"}');};
const settle=()=>new Promise(resolve=>setTimeout(resolve,150));
const skippedLocal=job=>(job.assumptions??[]).some(a=>/^Skipped local/.test(a));
/** The ops comment of a job whose fallback release waives chat: it says chat is not awaited and never
 * that chat starts on reconnect or waits for the bridge. */
function assertWaivedOps(body=''){
  assert.match(body,/ChatGPT is not awaited, even if the extension reconnects/,'ops: chat is not awaited');
  assert.match(body,/- ChatGPT: not awaited · local runs as the fallback/,'ops: the chat lane');
  assert.doesNotMatch(body,/start when the extension reconnects|waiting for Chrome bridge/,'ops: no promise that chat starts');
  assert.match(body,/\nReviewers: chatgpt \(Chrome\); local runs as the fallback\.\n/,'ops: the header describes local by its release');
}
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

/** A history store whose write of one job's cancelled record throws once (the fault the live → terminal
 * edge must survive: the job is terminal, so no later transition would run its cleanup again). */
function historyFault(){
  const fault={jobId:undefined,thrown:0};
  const githubOptions={wrap:{'src/lib/review-history.server.ts':real=>({recordJobHistory(job){
    if(!fault.thrown&&job.id===fault.jobId&&job.status==='cancelled'){fault.thrown++;throw new Error('history store unavailable');}
    return real.recordJobHistory(job);
  }})}};
  return {fault,githubOptions};
}
/** Start a verify-clean job whose cancelled-record history write will throw; `verifying` also starts
 * the local verification round (streaming, so its liveness watchdog is armed). */
async function startFaulted(t,{verifying,delivery}){
  const {fault,githubOptions}=historyFault();
  const s=await start(t,{githubOptions,delivery});
  fault.jobId=s.jobId;s.fault=fault;
  if(verifying){
    s.app.env.ASHLAR_LOCAL_LLM_STREAM='true';
    await s.app.harbor.submitHarborChat(s.jobId,clean);
    await eventually(()=>s.app.localRequests.length===1,'verification round did not start');
    assert.equal(s.app.harbor.hasLocalLegState(s.jobId),true,'the running leg has activity and liveness state');
    s.abort=trackAbort(s.app.localResponses[0]);
  }
  return s;
}
/** Collects console.warn lines (the fixture realm shares this console) until the test ends. */
function warnings(t){
  const lines=[],warn=console.warn;
  console.warn=(...args)=>{lines.push(args.join(' '));};
  t.after(()=>{console.warn=warn;});
  return lines;
}
/** The failed write is surfaced as a non-fatal history error on the dashboard's health. */
function assertHistoryFault(app,id){
  const health=app.harbor.historyHealth();
  assert.equal(health.ok,false,'surfaced as a history error');
  assert.equal(health.error,'history_write_failed');
  assert.equal(health.failedId,id);
}
/** The throwing write never reached the caller: it was logged, and the edge's cleanup ran. */
function assertCleanedDespiteHistory(s,thrown,logged){
  assert.equal(thrown,undefined,'a history failure never aborts the transition it records');
  assert.equal(s.fault.thrown,1,'the cancelled record write failed');
  assert.equal(s.job().status,'cancelled','the job is terminal');
  assert.equal(s.app.harbor.hasLocalLegState(s.jobId),false,'activity and liveness cleared on the edge');
  assert.ok(logged.some(l=>l.includes(s.jobId)&&/history store unavailable/.test(l)),'the failure is logged');
}

// expect: status, skip (regex or undefined), requests (total local requests), reviews, aborted, and
// optionally body (regex), clean (the review is a clean pass: the clean first line and CONVERGED) and
// reviewers (the findings body's exact reviewers line: local's release, not its configured role, and
// only the chat reviewers that ran) and ops (the final ops comment's reviewers header, from the release).
// The findings body's reviewers line: held (verify-clean), released as the fallback while chat was
// unavailable (chat never ran, so it is not named as running), and a failed fallback after which chat
// was awaited again and ran.
const VERIFIER='chatgpt ran in parallel. Local LLM verifies a clean chat result.';
const FALLBACK_ONLY='Local LLM ran as the fallback.';
const CHAT_AFTER_FALLBACK='chatgpt ran. Local LLM ran as the fallback.';
const VERIFIER_OPS='Reviewers: chatgpt (Chrome); local verifies a clean result.';
const FALLBACK_OPS='Reviewers: chatgpt (Chrome); local runs as the fallback.';
const ROWS=[
  {name:'L1 chat findings: local stays held and never runs',expect:{status:'posted',requests:0,reviews:1,reviewers:VERIFIER,ops:VERIFIER_OPS},
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
  // Release of the held local leg happens only on an explicit terminal signal (docs §2).
  {name:'L10 bridge never connects: released as the fallback once disconnected past the grace',expect:{status:'posted',requests:1,reviews:1,body:/Skipped chatgpt/,reviewers:FALLBACK_ONLY,ops:FALLBACK_OPS},
    async run(t){
      const s=await start(t);
      await settle();assert.equal(s.app.localRequests.length,0,'held within the bridge grace period');
      assert.equal(s.app.bridge.getBridgePublic().connected,false);
      s.app.clock.now+=120_001; // past BRIDGE_CONNECTED_MS, measured from the disconnect, with no chat progress
      await answerLocal(s.app,0,res=>res.end(reply(dirty)));
      assert.ok(s.job().localFallbackAt&&!s.job().localVerifyStartedAt,'released as the fallback, not a verification');
      return s;
    }},
  {name:'L11 chat reports an explicit quota failure: released as the fallback',expect:{status:'posted',requests:1,reviews:1,body:/Skipped chatgpt/,reviewers:FALLBACK_ONLY,ops:FALLBACK_OPS},
    async run(t){
      const s=await start(t);
      s.app.bridge.bridgeHeartbeat();
      const take=s.app.bridge.takeNextBridgeJob('lifecycle-client');
      assert.equal(take?.jobId,s.jobId,'the bridge claims the job');
      await settle();assert.equal(s.app.localRequests.length,0,'a claimed chat leg keeps local held');
      assert.equal(s.app.bridge.failBridgeProvider(s.jobId,'chatgpt','quota: usage limit reached',take.leaseId),true);
      await answerLocal(s.app,0,res=>res.end(reply(dirty)));
      assert.ok(s.job().localFallbackAt,'released as the fallback');
      return s;
    }},
  {name:'L12 claim lease expiry while the owning profile stays connected never releases local; only cancel ends it',expect:{status:'cancelled',skip:/cancelled by operator/,requests:0,reviews:0},
    async run(t){
      const s=await start(t);
      s.app.bridge.bridgeHeartbeat();
      assert.ok(s.app.bridge.takeNextBridgeJob('lifecycle-client'),'the bridge claims the job');
      // 12 × 110s = 22 min > BRIDGE_CLAIM_MS (20 min): every 110s the owner heartbeats and polls for
      // other work while it holds this job (excluded, so its lease is not renewed), staying connected
      for(let i=0;i<12;i++){
        s.app.clock.now+=110_000;s.app.bridge.bridgeHeartbeat();
        assert.equal(s.app.bridge.takeNextBridgeJob('lifecycle-client',[s.jobId]),null,'no other work');
        await new Promise(resolve=>setTimeout(resolve,60)); // a few watcher ticks at each step
      }
      assert.equal(s.app.bridge.getBridgePublic().connected,true);
      assert.equal(s.job().status,'awaiting_chat','the job still waits for chat');
      assert.equal(s.app.localRequests.length,0,'an expired lease is not a reviewer deadline');
      assert.equal(s.app.harbor.hasLocalSample(s.jobId),true,'the held job keeps its snapshot');
      s.app.harbor.cancelHarborJob(s.jobId);
      return s;
    }},
  // Chat ownership is per profile: only the owner can resume a claimed run (nextBridgeJob, claimBridgeJob),
  // so the owner's silence stalls the job whatever another profile does.
  {name:'L22 another profile keeps the bridge connected: the silent owner still stalls, local is released as the fallback, and the other profile never takes the owner\'s run',expect:{status:'posted',requests:1,reviews:1,body:/Skipped chatgpt/,reviewers:FALLBACK_ONLY,ops:FALLBACK_OPS},
    async run(t){
      const s=await start(t);
      s.app.bridge.bridgeHeartbeat();
      const take=s.app.bridge.takeNextBridgeJob('client-a');
      assert.equal(take?.jobId,s.jobId,'client A claims the job');
      await settle();assert.equal(s.app.localRequests.length,0,'a claimed chat leg keeps local held');
      // Client A goes silent. Client B heartbeats and polls for work every 60s, past A's grace.
      for(let i=0;i<5;i++){
        s.app.clock.now+=60_000;s.app.bridge.bridgeHeartbeat();
        assert.equal(s.app.bridge.takeNextBridgeJob('client-b'),null,'client B never takes A\'s run');
        await new Promise(resolve=>setTimeout(resolve,60)); // a few watcher ticks at each step
      }
      assert.equal(s.app.bridge.getBridgePublic().connected,true,'the bridge stays connected through client B');
      await eventually(()=>s.app.localRequests.length===1,'the fallback did not start');
      assert.ok(s.job().localFallbackAt&&!s.job().localVerifyStartedAt,'released as the fallback, not a verification');
      assert.equal(s.app.bridge.takeNextBridgeJob('client-b'),null,'client B still cannot take A\'s run');
      assert.match(String(s.app.bridge.claimBridgeJob(s.jobId,'client-b').error),/another Chrome profile/,'nor claim it');
      await answerLocal(s.app,0,res=>res.end(reply(dirty)));
      return s;
    }},
  {name:'L23 the owner\'s lease pings keep its long chat run alive while another profile heartbeats: local stays held',expect:{status:'posted',requests:0,reviews:1,reviewers:VERIFIER,ops:VERIFIER_OPS},
    async run(t){
      const s=await start(t);
      s.app.bridge.bridgeHeartbeat();
      const take=s.app.bridge.takeNextBridgeJob('client-a');
      assert.equal(take?.jobId,s.jobId,'client A claims the job');
      // A generates for 10 min, heard from only through its job's lease pings (as the extension does).
      for(let i=0;i<10;i++){
        s.app.clock.now+=60_000;s.app.bridge.bridgeHeartbeat();
        assert.equal(s.app.bridge.refreshBridgeClaim(s.jobId,{chatgpt:true},{},take.leaseId),true,'A\'s lease ping is accepted');
        await new Promise(resolve=>setTimeout(resolve,60)); // a few watcher ticks at each step
      }
      assert.equal(s.app.localRequests.length,0,'a live owner\'s generation is not a stall');
      assert.equal((await s.app.bridge.completeBridgeJob(s.jobId,dirty,[{provider:'chatgpt',raw:dirty}],take.leaseId)).ok,true);
      return s;
    }},
  // A history write that fails is never a bridge disconnect: every ping is applied and speaks for its owner.
  {name:'L24 history writes fail through a long claimed chat run: the owner\'s lease pings are applied, it stays connected, local stays held, and the run completes',expect:{status:'posted',requests:0,reviews:1,reviewers:VERIFIER,ops:VERIFIER_OPS},
    async run(t){
      const fault={on:false,thrown:0};
      const githubOptions={wrap:{'src/lib/review-history.server.ts':real=>({recordJobHistory(job){
        if(fault.on){fault.thrown++;throw new Error('history store unavailable');}
        return real.recordJobHistory(job);
      }})}};
      const s=await start(t,{githubOptions,delivery:'lifecycle-history-pings'});
      s.app.bridge.bridgeHeartbeat();
      const take=s.app.bridge.takeNextBridgeJob('client-a');
      assert.equal(take?.jobId,s.jobId,'client A claims the job');
      const logged=warnings(t);
      fault.on=true;
      // 5 min of pings, past BRIDGE_CONNECTED_MS (2 min), while every job history write fails
      for(let i=0;i<5;i++){
        s.app.clock.now+=60_000;s.app.bridge.bridgeHeartbeat();
        assert.equal(s.app.bridge.refreshBridgeClaim(s.jobId,{chatgpt:true},{},take.leaseId),true,'A\'s lease ping is accepted');
        assert.equal(s.job().bridgeClaimedAt,s.app.clock.now,'and applied');
        assert.equal(s.app.bridge.chatBridgeLink(s.job()).connected,true,'the owner stays connected');
        await new Promise(resolve=>setTimeout(resolve,60)); // a few watcher ticks at each step
      }
      assert.ok(fault.thrown>=5,'every ping\'s history write failed');
      assert.ok(logged.some(l=>/history write failed/.test(l)),'the failures are logged');
      assertHistoryFault(s.app,s.jobId);
      assert.equal(s.app.localRequests.length,0,'no verify-clean fallback while the owner pings');
      fault.on=false; // history storage restored
      assert.equal((await s.app.bridge.completeBridgeJob(s.jobId,dirty,[{provider:'chatgpt',raw:dirty}],take.leaseId)).ok,true);
      return s;
    }},
  // Every authenticated bridge request under the owner's lease speaks for the owner before its action
  // runs (noteBridgeRequest): a submit the server cannot archive yet is still the owner, alive.
  {name:'L25 the owner\'s submits fail on history storage for minutes: each is heard from the owner first, so local stays held, and the run completes once storage is back',expect:{status:'posted',requests:0,reviews:1,reviewers:VERIFIER,ops:VERIFIER_OPS},
    async run(t){
      const fault={on:false};
      const failing=new Set(['recordJob','recordResponse']);
      const githubOptions={wrap:{'src/lib/review-history.server.ts':real=>({reviewHistory(){
        const history=real.reviewHistory();
        return fault.on?new Proxy(history,{get(target,prop){
          if(failing.has(prop))return()=>{throw new Error('history store unavailable');};
          const value=target[prop];return typeof value==='function'?value.bind(target):value;
        }}):history;
      }})}};
      const s=await start(t,{githubOptions,delivery:'lifecycle-history-submits'});
      s.app.bridge.bridgeHeartbeat();
      const take=s.app.bridge.takeNextBridgeJob('client-a');
      assert.equal(take?.jobId,s.jobId,'client A claims the job');
      const submit=()=>fetch(s.app.origin+'/api/bridge',{method:'POST',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},
        body:JSON.stringify({action:'complete',jobId:s.jobId,leaseId:take.leaseId,results:[{provider:'chatgpt',raw:dirty}]})}).then(async r=>({status:r.status,...await r.json()}));
      fault.on=true;
      // 5 min past the claim, past BRIDGE_CONNECTED_MS (2 min): A's only requests are submits that fail
      for(let i=0;i<5;i++){
        s.app.clock.now+=60_000;
        const out=await submit();
        assert.equal(out.status,503,'the submit is refused until its archive is saved');
        assert.equal(out.code,'history_unavailable');
        assert.equal(s.app.bridge.chatBridgeLink(s.job()).connected,true,'the owner stays connected');
        await new Promise(resolve=>setTimeout(resolve,60)); // a few watcher ticks at each step
      }
      assert.equal(s.app.localRequests.length,0,'no verify-clean fallback while the owner submits');
      fault.on=false; // history storage restored: the owner's retry lands
      assert.equal((await submit()).status,200);
      return s;
    }},
  {name:'L13 a bridge token rotation waits the grace from the rotation, not from an older unseen bridge',expect:{status:'posted',requests:1,reviews:1,body:/Skipped chatgpt/,reviewers:FALLBACK_ONLY,ops:FALLBACK_OPS},
    async run(t){
      // Job A is admitted while the bridge has never been seen, then the bridge connects and stays
      // healthy for hours: that old unseen spell must not date a later disconnect.
      const a=await start(t,{delivery:'lifecycle-rotation-a'});
      await settle();
      a.app.bridge.bridgeHeartbeat();await settle();
      a.app.harbor.cancelHarborJob(a.jobId);
      for(let i=0;i<30;i++){a.app.clock.now+=100_000;a.app.bridge.bridgeHeartbeat();}
      const out=await a.app.mention('lifecycle-rotation-b');
      const job=()=>a.app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
      await eventually(()=>job()?.status==='awaiting_chat','job B not ready');
      a.app.bridge.rotateBridgeToken(); // the extension is disconnected until it gets the new token
      assert.equal(a.app.bridge.getBridgePublic().connected,false);
      assert.equal(a.app.bridge.getBridgePublic().disconnectedAt,a.app.clock.now,'disconnected at the rotation');
      await settle();
      assert.equal(a.app.localRequests.length,0,'held: the bridge disconnected just now');
      a.app.clock.now+=120_001;
      await answerLocal(a.app,0,res=>res.end(reply(dirty)));
      assert.ok(job().localFallbackAt,'released as the fallback once past the grace');
      return {app:a.app,jobId:out.jobId,job};
    }},
  {name:'L14 the bridge reconnects after the fallback release: chat is never required again and gets no fresh work',expect:{status:'posted',requests:1,reviews:1,body:/Skipped chatgpt/},
    async run(t){
      const s=await start(t);
      await settle();assert.equal(s.app.localRequests.length,0,'held within the bridge grace period');
      s.app.clock.now+=120_001; // offline past the grace: released as the fallback
      await eventually(()=>s.app.localRequests.length===1,'the fallback did not start');
      assert.ok(s.job().localFallbackAt,'released as the fallback');
      // The ops comment never promises chat on reconnect: the job does not wait on it.
      await eventually(()=>/ChatGPT is not awaited, even if the extension reconnects/.test(s.app.ops.at(-1)??''),'the ops comment does not say chat is not awaited');
      assertWaivedOps(s.app.ops.at(-1));
      s.app.bridge.bridgeHeartbeat(); // the bridge is back before local answers, and chat never returns
      assert.equal(s.app.bridge.getBridgePublic().connected,true);
      assert.equal(s.app.bridge.takeNextBridgeJob('lifecycle-client'),null,'no fresh chat generation for a fallback-released job');
      assert.equal(s.app.bridge.getBridgePublic().pendingJobs,0,'nothing is offered to the reconnected bridge');
      await settle(); // several watcher ticks with the bridge connected
      assertWaivedOps(s.app.ops.at(-1));
      await answerLocal(s.app,0,res=>res.end(reply(clean)));
      return s;
    }},
  // The waiver lasts only while the fallback can still deliver: once local ends with no payload, chat
  // is the only reviewer left and is awaited again (fresh work included), never a skip.
  {name:'L16 the fallback fails after the bridge reconnects: chat is awaited and offered again, and its review posts once',expect:{status:'posted',requests:1,reviews:1,body:/- Skipped local[\s\S]*ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 /,reviewers:CHAT_AFTER_FALLBACK,ops:FALLBACK_OPS},
    async run(t){
      const s=await start(t);
      await settle();
      s.app.clock.now+=120_001; // offline past the grace: released as the fallback
      await eventually(()=>s.app.localRequests.length===1,'the fallback did not start');
      assert.ok(s.job().localFallbackAt,'released as the fallback');
      s.app.bridge.bridgeHeartbeat();
      assert.equal(s.app.bridge.takeNextBridgeJob('lifecycle-client'),null,'no fresh chat work while the fallback can still deliver');
      fail500(s.app.localResponses[0]);
      await eventually(()=>skippedLocal(s.job()),'the fallback never failed');
      await settle(); // several watcher ticks: the job keeps waiting on chat instead of skipping
      assert.equal(s.job().status,'awaiting_chat','chat is awaited again');
      await eventually(()=>/- ChatGPT: waiting for Chrome bridge/.test(s.app.ops.at(-1)??''),'the ops comment does not show chat awaited again');
      assert.doesNotMatch(s.app.ops.at(-1),/not awaited/,'ops: the waiver ended');
      assert.equal(s.app.bridge.getBridgePublic().pendingJobs,1,'the job is offered to the reconnected bridge');
      const take=s.app.bridge.takeNextBridgeJob('lifecycle-client');
      assert.equal(take?.jobId,s.jobId,'fresh chat work for the job');
      assert.deepEqual([...take.providers],['chatgpt']);
      assert.equal((await s.app.bridge.completeBridgeJob(s.jobId,dirty,[{provider:'chatgpt',raw:dirty}],take.leaseId)).ok,true);
      return s;
    }},
  {name:'L17 the fallback fails while a chat run still holds its claim: that run is awaited and its review posts once',expect:{status:'posted',requests:1,reviews:1,body:/- Skipped local[\s\S]*ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 /,reviewers:CHAT_AFTER_FALLBACK,ops:FALLBACK_OPS},
    async run(t){
      const s=await start(t);
      s.app.bridge.bridgeHeartbeat();
      const take=s.app.bridge.takeNextBridgeJob('lifecycle-client');
      assert.equal(take?.jobId,s.jobId,'the bridge claims the job');
      await settle();
      s.app.clock.now+=250_000; // the bridge goes silent past the grace; the 20 min claim lease still holds
      await eventually(()=>s.app.localRequests.length===1,'the fallback did not start');
      assert.ok(s.job().localFallbackAt,'released as the fallback');
      s.app.bridge.bridgeHeartbeat(); // the bridge is back and its run resumes under the same lease
      fail500(s.app.localResponses[0]);
      await eventually(()=>skippedLocal(s.job()),'the fallback never failed');
      await settle();
      assert.equal(s.job().status,'awaiting_chat','the claimed chat run is awaited');
      assert.equal((await s.app.bridge.completeBridgeJob(s.jobId,dirty,[{provider:'chatgpt',raw:dirty}],take.leaseId)).ok,true);
      return s;
    }},
  // Terminal cleanup runs on the live → terminal edge even when that edge's history write throws, and
  // the throw never reaches the caller: it is logged and surfaced as a non-fatal history error.
  {name:'L18 operator cancel while local verifies, history write throws: still aborted and released',expect:{status:'cancelled',skip:/cancelled by operator/,requests:1,reviews:0,aborted:true},
    async run(t){
      const s=await startFaulted(t,{verifying:true,delivery:'lifecycle-history-cancel-verifying'});
      const logged=warnings(t);
      let thrown;try{s.app.harbor.cancelHarborJob(s.jobId);}catch(e){thrown=e;}
      assertCleanedDespiteHistory(s,thrown,logged);
      assertHistoryFault(s.app,s.jobId);
      await eventually(()=>s.abort.aborted,'the in-flight local request was not aborted');
      return s;
    }},
  {name:'L19 operator cancel while local is held, history write throws: the snapshot is still released',expect:{status:'cancelled',skip:/cancelled by operator/,requests:0,reviews:0},
    async run(t){
      const s=await startFaulted(t,{verifying:false,delivery:'lifecycle-history-cancel-held'});
      assert.equal(s.app.harbor.hasLocalSample(s.jobId),true,'the held job keeps its snapshot');
      const logged=warnings(t);
      let thrown;try{s.app.harbor.cancelHarborJob(s.jobId);}catch(e){thrown=e;}
      assertCleanedDespiteHistory(s,thrown,logged);
      assertHistoryFault(s.app,s.jobId);
      assert.equal(s.app.harbor.hasLocalSample(s.jobId),false,'released on the edge');
      return s;
    }},
  {name:'L20 superseded while local verifies, history write throws: still aborted and released',expect:{status:'cancelled',skip:/superseded by/,requests:1,reviews:0,aborted:true},
    async run(t){
      const s=await startFaulted(t,{verifying:true,delivery:'lifecycle-history-supersede-verifying'});
      const logged=warnings(t);
      let thrown;try{await s.app.mention('lifecycle-history-supersede-verifying-next');}catch(e){thrown=e;}
      assertCleanedDespiteHistory(s,thrown,logged);
      await eventually(()=>s.abort.aborted,'the superseded job\'s local request was not aborted');
      return s;
    }},
  {name:'L21 superseded while held, history write throws: the snapshot is still released',expect:{status:'cancelled',skip:/superseded by/,requests:0,reviews:0},
    async run(t){
      const s=await startFaulted(t,{verifying:false,delivery:'lifecycle-history-supersede-held'});
      const logged=warnings(t);
      let thrown;try{await s.app.mention('lifecycle-history-supersede-held-next');}catch(e){thrown=e;}
      assertCleanedDespiteHistory(s,thrown,logged);
      assert.equal(s.app.harbor.hasLocalSample(s.jobId),false,'released on the edge');
      return s;
    }},
  {name:'R1 race: chat and local both find the issue',expect:{status:'posted',requests:1,reviews:1},
    async run(t){
      const s=await start(t,{role:'race'});
      await s.app.harbor.submitHarborChat(s.jobId,dirty);
      await answerLocal(s.app,0,res=>res.end(reply(dirty)));return s;
    }},
  {name:'L15 chat and local clean, each assuming something was "skipped": verified-clean and CONVERGED',expect:{status:'posted',requests:1,reviews:1,clean:true,body:/local verification agreed/},
    async run(t){
      const s=await start(t);await s.app.harbor.submitHarborChat(s.jobId,cleanAssumesSkipped);
      await answerLocal(s.app,0,res=>res.end(reply(cleanAssumesSkipped)));return s;
    }},
  {name:'R3 race: chat and local clean, each assuming something was "skipped": clean and CONVERGED',expect:{status:'posted',requests:1,reviews:1,clean:true},
    async run(t){
      const s=await start(t,{role:'race'});
      await s.app.harbor.submitHarborChat(s.jobId,cleanAssumesSkipped);
      await answerLocal(s.app,0,res=>res.end(reply(cleanAssumesSkipped)));return s;
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
    if(e.body)assert.match(app.reviews[0].body,e.body,'review body');
    if(e.reviewers)assert.equal(app.reviews[0].body.split('\n').find(l=>l.includes('Local LLM')),e.reviewers,'reviewers line');
    if(e.ops){
      await eventually(()=>/\*\*Status:\*\* review posted/.test(app.ops.at(-1)??''),`${row.name}: the ops comment never said the review posted`);
      assert.equal(app.ops.at(-1).split('\n').find(l=>l.startsWith('Reviewers:')),e.ops,'ops comment reviewers header');
    }
    if(e.clean){
      const body=app.reviews[0].body;
      assert.equal(body.split('\n')[0],CLEAN_REVIEW_BODY,'a clean pass');
      assert.equal(isZeroFindings(body,{authoredByBot:true}),true,'CONVERGED');
      assert.equal(JSON.stringify(job().skippedProviders),'[]','no reviewer was skipped');
      assert.doesNotMatch(body,/skipped/i,'a reviewer assumption is not listed as a skipped reviewer');
    }
    await eventually(()=>!app.harbor.hasLocalSample(jobId),`${row.name}: the local snapshot was never released`);
    await eventually(()=>!app.harbor.isWatchingJob(jobId),`${row.name}: the reviewer watcher never stopped`);
    assert.equal(Boolean(s.abort?.aborted),Boolean(e.aborted),'in-flight local request aborted');
  });
}

test('chat bridge link: an owned job follows its owner, an unowned one the server-wide bridge, and a rotation disconnects every owner',async t=>{
  const {app,jobId}=await start(t,{delivery:'lifecycle-bridge-link'});
  const link=bridgeClientId=>({...app.bridge.chatBridgeLink({bridgeClientId})}); // copied into this realm for deepEqual
  const serverWide=()=>{const {connected,disconnectedAt}=app.bridge.getBridgeStatus();return {connected,disconnectedAt};};
  assert.deepEqual(link(undefined),serverWide(),'no owner: the server-wide status (offline)');
  app.bridge.bridgeHeartbeat();
  assert.deepEqual(link(undefined),serverWide(),'no owner: the server-wide status (online)');
  assert.deepEqual(link(''),serverWide(),'a claim without a profile id has no owner');
  assert.equal(link('client-a').connected,false,'a profile never heard from is offline, whoever else heartbeats');
  assert.equal(app.bridge.claimBridgeJob(jobId,'client-a').ok,true);
  const claimedAt=app.clock.now;
  assert.deepEqual(link('client-a'),{connected:true,disconnectedAt:undefined},'a claim is heard from its profile');
  app.clock.now+=120_001;app.bridge.bridgeHeartbeat();
  assert.deepEqual(link('client-a'),{connected:false,disconnectedAt:claimedAt+120_000},'offline when its own window closed');
  assert.equal(app.bridge.recoverBridgeJob('client-a',[]),null,'nothing to recover');
  assert.equal(link('client-a').connected,true,'a recover request is heard from its profile');
  app.clock.now+=120_001;
  assert.equal(link('client-a').connected,false);
  assert.equal(app.bridge.recoverBridgeJob('client-a','malformed'),null,'a malformed recover');
  assert.equal(link('client-a').connected,true,'is heard from its profile too');
  app.clock.now+=10_000;
  app.bridge.rotateBridgeToken();
  assert.deepEqual(link('client-a'),{connected:false,disconnectedAt:app.clock.now},'offline at the rotation, as an unseen bridge is');
  app.harbor.cancelHarborJob(jobId);
});

test('history: a new job whose delivery and job history writes fail still starts its review, and the failure never reaches the webhook',async t=>{
  const thrown=[];
  const githubOptions={wrap:{'src/lib/review-history.server.ts':real=>({
    recordJobHistory(job){if(job.status==='queued'){thrown.push('job');throw new Error('history store unavailable');}return real.recordJobHistory(job);},
    recordDeliveryHistory(){thrown.push('delivery');throw new Error('history store unavailable');},
  })}};
  const app=await appFixture({localReviewRole:'verify-clean',localJsonRepairEnabled:false},githubOptions);t.after(()=>app.close());
  const logged=warnings(t);
  let out,error;try{out=app.mention('history-new-job');}catch(e){error=e;}
  assert.equal(error,undefined,'the webhook is accepted');
  assert.equal(out.queued,true);
  assert.deepEqual(thrown,['delivery','job'],'both writes failed');
  assert.equal(logged.filter(l=>/history write failed/.test(l)).length,2,'each failure is logged');
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId)?.status==='awaiting_chat','the review never started');
  assert.equal(app.harbor.hasLocalSample(out.jobId),true,'the held verify-clean job has its snapshot');
});

test('history: an operator reset whose history write fails still drops every job and releases its local state',async t=>{
  const fault={on:false,thrown:0};
  const githubOptions={wrap:{'src/lib/review-history.server.ts':real=>({recordJobHistory(job){
    if(fault.on&&job.skipReason==='operator reset'){fault.thrown++;throw new Error('history store unavailable');}
    return real.recordJobHistory(job);
  }})}};
  const {app,jobId}=await start(t,{githubOptions,delivery:'history-reset'});
  assert.equal(app.harbor.hasLocalSample(jobId),true,'the held job keeps its snapshot');
  const logged=warnings(t);
  fault.on=true;
  let error;try{app.harbor.resetHarbor();}catch(e){error=e;}
  assert.equal(error,undefined,'the reset completes');
  assert.equal(fault.thrown,1,'the cancelled record write failed');
  assert.equal(app.harbor.getHarbor().jobs.length,0,'every job is dropped');
  assert.equal(app.harbor.hasLocalSample(jobId),false,'its snapshot is released');
  assert.ok(logged.some(l=>l.includes(jobId)),'the failure is logged');
  assertHistoryFault(app,jobId);
  await eventually(()=>!app.harbor.isWatchingJob(jobId),'the reviewer watcher never stopped');
});

// Capacity retention (80 completed jobs) and removal: a live job is never dropped, and a job that
// leaves state goes through the same release its terminal edge runs (removeJobs → releaseJob).
const CAPACITY=80;
/** A mention on another PR of the fixture repo (a mention on PR 1 would supersede the job under test). */
function mentionOn(app,pr,deliveryId){
  return app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId,event:'issue_comment',payload:{action:'created',installation:{id:1},
    repository:{full_name:'fixture/fixture'},sender:{login:'author'},issue:{number:pr,pull_request:{},title:'fixture'},comment:{id:1000+pr,body:'@ashlar-bot review'}}});
}
/** Push `count` newer completed jobs through capacity: mentions on PR 9, each superseding (cancelling)
 * the one before, and the last one cancelled too. */
async function flood(app,count,tag){
  let last;
  for(let i=0;i<count;i++){app.clock.now+=1;last=mentionOn(app,9,`${tag}-${i}`).jobId;}
  app.harbor.cancelHarborJob(last);
  await eventually(()=>app.harbor.getHarbor().jobs.filter(j=>j.pr===9).every(j=>TERMINAL.includes(j.status)),'the flood never settled');
}

test('capacity: a held verify-clean job is never dropped; it keeps its snapshot and watcher past the cap',async t=>{
  const {app,jobId,job}=await start(t,{delivery:'capacity-held'});
  await flood(app,CAPACITY+5,'capacity-held-flood');
  // trimmed at each insert: the last flood job, cancelled after the last insert, is the one over the cap
  assert.equal(app.harbor.getHarbor().jobs.filter(j=>j.pr===9).length,CAPACITY+1,'the older completed jobs were trimmed');
  assert.equal(job()?.status,'awaiting_chat','the live held job is retained beyond the cap');
  assert.equal(app.harbor.hasLocalSample(jobId),true,'with its snapshot');
  assert.equal(app.harbor.isWatchingJob(jobId),true,'and its watcher');
  assert.equal(app.localRequests.length,0,'local stays held');
  assert.deepEqual([...app.harbor.orphanedLocalState()],[],'no local state outlives a dropped job');
  app.harbor.cancelHarborJob(jobId);
});

test('capacity: a verify-clean job trimmed while its local verifier still holds the snapshot is aborted, and its snapshot, liveness and watcher are released',async t=>{
  const {app,jobId,job}=await start(t,{delivery:'capacity-trimmed'});
  app.env.ASHLAR_LOCAL_LLM_STREAM='true'; // arms the leg's liveness watchdog
  await app.harbor.submitHarborChat(jobId,clean);
  await eventually(()=>app.localRequests.length===1,'verification round did not start');
  const abort=trackAbort(app.localResponses[0]);
  // The job ends while its verifier runs (a skip written through the job writer): a skip never
  // aborts local generation, so the running leg still holds the snapshot and its liveness.
  app.harbor.patchHarborJob(jobId,j=>({...j,status:'skipped',skipReason:'ended while local verified',updatedAt:Date.now()}));
  assert.equal(app.harbor.hasLocalSample(jobId),true,'the running leg keeps the snapshot');
  assert.equal(app.harbor.hasLocalLegState(jobId),true,'and its liveness');
  await flood(app,CAPACITY+1,'capacity-trimmed-flood');
  assert.equal(job(),undefined,'the oldest completed job is trimmed');
  assert.equal(app.harbor.hasLocalSample(jobId),false,'its snapshot is released');
  assert.equal(app.harbor.hasLocalLegState(jobId),false,'its activity and liveness are released');
  await eventually(()=>abort.aborted,'its local request was not aborted');
  await eventually(()=>!app.harbor.isWatchingJob(jobId),'its watcher never stopped');
  await eventually(()=>app.harbor.orphanedLocalState().length===0,'local state outlived a trimmed job');
  // Again: a second held job through another flood leaves nothing behind either.
  const again=await mentionOn(app,2,'capacity-trimmed-again');
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===again.jobId)?.status==='awaiting_chat','second job not ready');
  app.harbor.cancelHarborJob(again.jobId);
  await flood(app,CAPACITY+1,'capacity-trimmed-flood-2');
  await eventually(()=>app.harbor.orphanedLocalState().length===0,'local state outlived the second trimmed job');
  assert.equal(app.localRequests.length,1,'no other local request ran');
});
