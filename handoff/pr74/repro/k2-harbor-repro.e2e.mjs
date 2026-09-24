// K2 scratch repro: a control delivery whose side effect failed cannot be retried by redelivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './app-fixture.mjs';
const stopEdit=()=>({action:'edited',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
  issue:{number:1957,pull_request:{},title:'t'},comment:{id:42,body:'/review-loop stop',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-02T00:00:00Z'},
  changes:{body:{from:'looks good'}}});
test('I9: a stop whose token fetch failed is not retried on redelivery (claim release is dead)',async t=>{
  let fail=true;
  const app=await appFixture({reviewLocal:false,fixAgent:{provider:'local',delivery:'script-apply',mode:'apply',parallelPrs:3}},{installationToken:async()=>{if(fail)throw new Error('installation token 502');return 'tok';}});
  t.after(()=>app.close());
  app.env.ASHLAR_FIX_AGENT='1';
  const first=app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'stop-1',event:'issue_comment',payload:stopEdit()});
  await new Promise(r=>setTimeout(r,200));
  assert.equal(app.githubCalls.tokens,1,'first delivery tried to get a token');
  assert.equal(app.githubCalls.headRef??0,0,'the stop never reached stopLoop (token failed) — nothing pending');
  fail=false;
  const again=app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'stop-1',event:'issue_comment',payload:stopEdit()});
  await new Promise(r=>setTimeout(r,200));
  assert.equal(app.githubCalls.tokens,1,'BUG: the redelivery never retries the stop (acceptedDeliveryIds already has it)');
  console.log('first',JSON.stringify(first),'again',JSON.stringify(again));
});
import {eventually} from './app-fixture.mjs';
const cmt=(id,body,created)=>({action:'created',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
  issue:{number:1957,pull_request:{},title:'t'},comment:{id,body,created_at:created,updated_at:created}});
test('I10: a /review-loop start superseded before admission is never recorded (the loop silently never starts)',async t=>{
  let release;const held=new Promise(r=>release=r);let calls=0;
  const app=await appFixture({reviewLocal:false,fixAgent:{provider:'local',delivery:'script-apply',mode:'apply',parallelPrs:3}},{beforeHead:async()=>{if(++calls===1)await held;}});
  t.after(()=>app.close());
  app.env.ASHLAR_FIX_AGENT='1';
  const a=app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'start-1',event:'issue_comment',payload:cmt(50,'/review-loop apply','2026-01-01T00:00:00Z')});
  await eventually(()=>calls===1,'start job reached snapshot');
  const b=app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'mention-2',event:'issue_comment',payload:cmt(51,'@ashlar-bot review','2026-01-01T00:00:03Z')});
  release();
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===b.jobId)?.status==='awaiting_chat','mention admitted');
  await new Promise(r=>setTimeout(r,300));
  const jA=app.harbor.getHarbor().jobs.find(j=>j.id===a.jobId);
  assert.equal(jA.status,'cancelled');
  assert.equal(app.ops.filter(x=>x.includes('ashlar-loop-start')).length,0,'BUG: no start record was ever posted');
  assert.equal(app.githubCalls.listIssue??0,0,'startLoop never even ran');
});
test('I8: a stop whose own time PRECEDES a live start still cancels that start job',async t=>{
  const app=await appFixture({reviewLocal:false,fixAgent:{provider:'local',delivery:'script-apply',mode:'apply',parallelPrs:3}});
  t.after(()=>app.close());
  app.env.ASHLAR_FIX_AGENT='1';
  const a=app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'start-1',event:'issue_comment',payload:cmt(60,'/review-loop apply','2026-01-02T00:00:00Z')});
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===a.jobId)?.status==='awaiting_chat','start admitted');
  // a stop from BEFORE the start (a late/redelivered delivery: edit at T1 < start T2)
  const stale={...stopEditAt('2026-01-01T12:00:00Z')};
  app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'stop-old',event:'issue_comment',payload:stale});
  const jA=app.harbor.getHarbor().jobs.find(j=>j.id===a.jobId);
  assert.equal(jA.status,'cancelled','BUG: the newer start review is cancelled by an older stop');
});
function stopEditAt(at){return {action:'edited',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
  issue:{number:1957,pull_request:{},title:'t'},comment:{id:42,body:'/review-loop stop',created_at:'2026-01-01T00:00:00Z',updated_at:at},changes:{body:{from:'lgtm'}}};}
