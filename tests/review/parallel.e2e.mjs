// Real signed HTTP ingress/bridge and production state machines; Chrome/model/GitHub I/O are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {appFixture,eventually} from './app-fixture.mjs';
import {background,storage} from './helpers.mjs';

async function mention(app,pr) {
  const payload=JSON.stringify({action:'created',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
    issue:{number:pr,pull_request:{},title:'PR '+pr},comment:{id:pr,body:'@ashlar-bot review'}});
  const signature='sha256='+createHmac('sha256','fixture-webhook-secret').update(payload).digest('hex');
  const res=await fetch(app.origin+'/api/webhook',{method:'POST',headers:{'content-type':'application/json','x-github-event':'issue_comment',
    'x-github-delivery':'parallel-'+pr,'x-hub-signature-256':signature},body:payload});
  assert.equal(res.status,202);const out=await res.json();assert.equal(out.queued,true);
  await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId)?.status==='awaiting_chat','snapshot not ready');
  return out.jobId;
}
function worker(app,extra={}) {
  const ready=new Set(),calls=[];
  const api=async(path,body)=>{
    calls.push({path,...body});
    const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},
      body:body?JSON.stringify(body):undefined});
    const out=await res.json();if(!res.ok||!out.ok)throw Object.assign(Error(out.error||'bridge rejected'),{status:res.status});return out;
  };
  const handler=(_id,msg)=>ready.has(msg.jobId)?{ok:true,raw:JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['Only '+msg.jobId]})}:{ok:false,code:'busy'};
  return {...background({local:storage({origin:app.origin,token:'fixture-token'}),api,handler,...extra}),ready,requests:calls};
}

test('parallel HTTP: A keeps generating as B starts, posts to its own PR and closes first',async t=>{
  const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
  const a=await mention(app,101),b=worker(app);await b.tick();
  const tabA=b.local.state.pendingReviewJobs[a].states.chatgpt.tabId;
  app.clock.now+=365*24*3600_000;
  const idB=await mention(app,202);await b.tick();
  assert.ok(b.messages.some(m=>m.type==='ashlar-run'&&m.jobId===idB));
  b.ready.add(idB);await b.tick();
  await eventually(()=>app.reviews.length===1,'B did not post while A was waiting');
  assert.equal(app.reviews[0].pr,202);
  assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===a).status,'awaiting_chat');
  assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===a).storedLegs.length,0);
  assert.ok(b.tabs.has(tabA));assert.equal(b.closedTabs.length,1);
  const c=await mention(app,303);await b.tick();assert.ok(b.messages.some(m=>m.jobId===c&&m.type==='ashlar-run'));
  b.ready.add(a);await b.tick();await eventually(()=>app.reviews.length===2,'A did not finish independently');
  assert.deepEqual(app.reviews.map(r=>r.pr),[202,101]);
  assert.ok(app.harbor.getHarbor().jobs.find(j=>j.id===a).storedLegs[0].raw.includes(a));
  assert.ok(app.harbor.getHarbor().jobs.find(j=>j.id===idB).storedLegs[0].raw.includes(idB));
});

test('parallel HTTP: worker restart retains A/B ownership and resumes the right replies',async t=>{
  const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
  const a=await mention(app,101),first=worker(app);await first.tick();const b=await mention(app,202);await first.tick();
  const restarted=worker(app,{local:first.local,session:first.session,tabs:first.tabs});
  app.clock.now+=365*24*3600_000;await restarted.tick();
  assert.equal(restarted.messages.some(m=>m.type==='ashlar-run'),false);
  restarted.ready.add(b);await restarted.tick();await eventually(()=>app.reviews.length===1,'restarted B not posted');
  assert.equal(app.reviews[0].pr,202);assert.ok(restarted.local.state.pendingReviewJobs[a]);
  assert.ok(restarted.requests.filter(c=>c.action==='take').every(c=>c.excludeJobIds.includes(a)));
});

test('parallel HTTP: lost B ACK is replayed once logically, A continues receiving heartbeats',async t=>{
  const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
  const a=await mention(app,101),b=worker(app);await b.tick();const idB=await mention(app,202);await b.tick();
  const api=b.context.api;let lose=true;
  b.context.api=async(path,body,...args)=>{const out=await api(path,body,...args);if(body?.action==='complete'&&body.jobId===idB&&lose){lose=false;throw Error('ACK lost after save');}return out;};
  b.ready.add(idB);await b.tick();assert.ok(b.local.state.pendingReviewJobs[idB].states.chatgpt.outcome.raw);
  assert.equal(b.closedTabs.length,0);await b.context.heartbeatTick();await b.tick();
  await eventually(()=>app.reviews.length===1,'B review not posted');assert.equal(app.reviews[0].pr,202);
  assert.equal(b.closedTabs.length,1);assert.ok(b.local.state.pendingReviewJobs[a]);
  assert.equal(b.messages.filter(m=>m.type==='ashlar-run'&&m.jobId===idB).length,1);
  assert.ok(b.requests.some(c=>c.action==='ping'&&c.jobId===a&&c.generating.chatgpt));
});
