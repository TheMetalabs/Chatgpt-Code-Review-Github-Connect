// Large webhook deliveries (WalkieBoard #107: an 85 KB PR description in every issue_comment):
// accepted and triggered when under the hard cap, recorded (never silently dropped) when over it,
// HMAC always checked on the exact full body.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {appFixture,eventually} from './app-fixture.mjs';

const SECRET='fixture-webhook-secret';
// ~85 KB of UTF-8, mostly Hangul, like the #107 description.
const description=('## 변경 사항\n이 PR은 보드 동기화와 알림 파이프라인을 재구성합니다. 리뷰 부탁드립니다.\n').repeat(900);
const comment=(text,id=42)=>({action:'created',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
  issue:{number:107,pull_request:{},title:'Big PR',body:description},comment:{id,body:text}});
const sign=(body,secret=SECRET)=>'sha256='+createHmac('sha256',secret).update(body).digest('hex');
async function post(app,event,body,id,signature=sign(body)) {
  const res=await fetch(app.origin+'/api/webhook',{method:'POST',headers:{'content-type':'application/json',
    'x-github-event':event,'x-github-delivery':id,'x-hub-signature-256':signature,
    'x-github-hook-installation-target-type':'integration','x-github-hook-installation-target-id':'77'},body});
  return {status:res.status,...await res.json()};
}
async function fixture(t){const app=await appFixture({reviewLocal:false});t.after(()=>app.close());return app;}

test('fixture description is the #107 shape: over the old 64 KiB cap',()=>{
  assert.ok(Buffer.byteLength(JSON.stringify(comment('/review')))>85_000);
});

for (const [text,id] of [['/review',51],['@ashlar-bot review',52]]) {
  test(`${text} on a PR with an ~85 KB Korean description is accepted, queued and its description truncated`,async t=>{
    const app=await fixture(t);
    const out=await post(app,'issue_comment',JSON.stringify(comment(text,id)),'big-'+id);
    assert.equal(out.status,202);assert.equal(out.queued,true,JSON.stringify(out));
    assert.deepEqual(out.truncated,['issue.body']);
    const job=app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
    assert.equal(job.trigger,'issue_comment.mention');
    assert.equal(job.thread.userText,text);assert.equal(job.thread.commentId,id);
    await eventually(()=>app.history.listDeliveries({}).items.some(d=>d.deliveryId==='big-'+id&&d.httpStatus===202),'accepted delivery recorded');
  });
}

test('HMAC is verified on the full body: a signature over a truncated body is rejected',async t=>{
  const app=await fixture(t);
  const body=JSON.stringify(comment('@ashlar-bot review'));
  const truncated=JSON.stringify({...comment('@ashlar-bot review'),issue:{number:107,pull_request:{},title:'Big PR',body:description.slice(0,8192)}});
  const forged=await post(app,'issue_comment',body,'forged',sign(truncated));
  assert.equal(forged.status,403);assert.equal(forged.reason,'HMAC mismatch');
  const wrong=await post(app,'issue_comment',body,'wrong-secret',sign(body,'other-secret'));
  assert.equal(wrong.status,403);
  assert.equal(app.harbor.getHarbor().jobs.length,0);
});

test('a payload over the hard cap gets 413 and is recorded in delivery history and the event log',async t=>{
  const app=await fixture(t);
  const huge=JSON.stringify({...comment('@ashlar-bot review'),padding:'x'.repeat(5*1024*1024+10)});
  const warns=[];const warn=console.warn;console.warn=(...a)=>{warns.push(a.join(' '));};
  let out;try{out=await post(app,'issue_comment',huge,'too-big');}finally{console.warn=warn;}
  assert.equal(out.status,413);assert.equal(out.reason,'payload too large');assert.equal(out.max,5*1024*1024);
  assert.ok(warns.some(w=>w.includes('413')&&w.includes('too-big')),'logged');
  const ev=app.harbor.getHarbor().events.find(e=>e.deliveryId==='too-big');
  assert.equal(ev.httpStatus,413);assert.equal(ev.hmac,'unverified');assert.equal(ev.event,'issue_comment');
  assert.match(ev.summary,/integration 77/);
  const rec=app.history.listDeliveries({}).items.find(d=>d.deliveryId==='too-big');
  assert.ok(rec,'delivery history record');assert.equal(rec.httpStatus,413);assert.match(rec.reason,/payload too large/);
  assert.equal(app.harbor.getHarbor().jobs.length,0);
  // A redelivery after the cap is raised is not treated as a duplicate (only 202s are).
  const again=await post(app,'issue_comment',JSON.stringify(comment('@ashlar-bot review')),'too-big');
  assert.equal(again.status,202);assert.equal(again.queued,true);
});
