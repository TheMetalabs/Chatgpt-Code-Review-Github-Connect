// Signed HTTP webhook -> production parser/ingress/worker -> bridge queue.
// Only GitHub I/O, settings persistence and watcher cadence are fixture adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {appFixture,eventually} from './app-fixture.mjs';

const comment=()=>({action:'created',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
  issue:{number:1957,pull_request:{},title:'Draft review'},comment:{id:42,body:'@ashlar-bot review'}});
const pr=(action='opened',body='@ashlar-bot review',extra={})=>({action,installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
  pull_request:{number:1957,title:'Draft review',body,draft:true,head:{sha:'abc123',repo:{fork:false}},base:{sha:'def456'},user:{login:'author'}},...extra});
async function deliver(app,event,payload,id='delivery',valid=true) {
  const body=JSON.stringify(payload);
  const signature='sha256='+createHmac('sha256',valid?'fixture-webhook-secret':'incorrect-fixture-secret').update(body).digest('hex');
  const res=await fetch(app.origin+'/api/webhook',{method:'POST',headers:{'content-type':'application/json',
    'x-github-event':event,'x-github-delivery':id,'x-hub-signature-256':signature},body});
  return {status:res.status,...await res.json()};
}
async function settled(app,id) {
  await eventually(()=>['awaiting_chat','skipped','dlq'].includes(app.harbor.getHarbor().jobs.find(j=>j.id===id)?.status),'worker did not resolve snapshot admission');
  return app.harbor.getHarbor().jobs.find(j=>j.id===id);
}
async function fixture(t,githubOptions={}) {
  const app=await appFixture({skipDrafts:true,skipForks:true,reviewLocal:false},githubOptions);t.after(()=>app.close());return app;
}

test('signed comment on a fetched draft reaches the Chrome queue; eyes is after policy admission',async t=>{
  const app=await fixture(t,{pull:{draft:true}});
  const out=await deliver(app,'issue_comment',comment());
  assert.equal(out.status,202);assert.equal(out.queued,true);
  const job=await settled(app,out.jobId);
  assert.equal(job.isDraft,true);assert.equal(job.status,'awaiting_chat');
  assert.equal(app.bridge.nextBridgeJob('fixture-client').jobId,job.id);
  assert.ok(app.githubCalls.timeline.indexOf('head')<app.githubCalls.timeline.indexOf('reaction:eyes'));
  assert.ok(app.ops.some(body=>body.includes(job.id)),'status comment links the request to its job');
  assert.equal(app.localRequests.length,0);
});
test('signed PR-opened body mention creates a draft job and acknowledges the PR, not a nonexistent comment',async t=>{
  const app=await fixture(t);const out=await deliver(app,'pull_request',pr());
  assert.equal(out.queued,true);const job=await settled(app,out.jobId);
  assert.equal(job.status,'awaiting_chat');assert.equal(job.trigger,'pull_request.body_mention');
  const claim=app.bridge.takeNextBridgeJob('fixture-client');assert.equal(claim.jobId,job.id);
  assert.equal(app.githubCalls.reactions.find(r=>r.content==='eyes').thread.commentId,0);
});
test('new body mention edit queues once; retained mention and a redelivery never supersede its job',async t=>{
  const app=await fixture(t);
  const payload=pr('edited','Updated\n@ashlar-bot review',{changes:{body:{from:'Description'}}});
  const first=await deliver(app,'pull_request',payload,'body-added');assert.equal(first.queued,true);
  assert.equal((await settled(app,first.jobId)).status,'awaiting_chat');
  const duplicate=await deliver(app,'pull_request',payload,'body-added');assert.equal(duplicate.queued,false);
  const edit=await deliver(app,'pull_request',pr('edited','More changes\n@ashlar-bot review',{changes:{body:{from:'Updated\n@ashlar-bot review'}}}),'body-edited');
  assert.equal(edit.queued,false);
  assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===first.jobId).status,'awaiting_chat');
  assert.equal(app.githubCalls.snapshot,1);
});
test('fork policy discovered from a comment is checked before snapshot or eyes and explains the skip',async t=>{
  const app=await fixture(t,{pull:{draft:true,fork:true}});
  const out=await deliver(app,'issue_comment',comment());const job=await settled(app,out.jobId);
  assert.equal(job.status,'skipped');assert.match(job.skipReason,/fork/);
  assert.equal(app.githubCalls.snapshot,0);assert.equal(app.githubCalls.reactions.some(r=>r.content==='eyes'),false);
  await eventually(()=>app.ops.some(body=>body.includes(job.id)&&/fork/.test(body)),'missing policy-skip status');
});
test('a real snapshot failure remains visible as failed, not an unexplained eyes-only acknowledgement',async t=>{
  const app=await fixture(t,{snapshotError:new Error('fixture snapshot failed')});
  const out=await deliver(app,'issue_comment',comment());const job=await settled(app,out.jobId);
  assert.match(job.githubError,/fixture snapshot failed/);
  await eventually(()=>app.ops.some(body=>body.includes(job.id)&&/Status:\*\* failed/.test(body)),'missing failure status with job ID');
});
test('invalid signature and unmentioned PR creation never start model work',async t=>{
  const app=await fixture(t);
  assert.equal((await deliver(app,'issue_comment',comment(),'bad-signature',false)).status,403);
  assert.equal(app.harbor.getHarbor().jobs.length,0);
  const out=await deliver(app,'pull_request',pr('opened','No request'),'unmentioned');assert.equal(out.queued,false);
  assert.equal(app.githubCalls.head,0);assert.equal(app.githubCalls.snapshot,0);assert.equal(app.githubCalls.reactions.length,0);
  assert.equal(app.localRequests.length,0);
});

for (const state of [
  {name:'open',draft:false,state:'open',merged:false},
  {name:'draft',draft:true,state:'open',merged:false},
  {name:'closed',draft:false,state:'closed',merged:false},
  {name:'merged',draft:false,state:'closed',merged:true},
]) {
  test(`explicit comment on ${state.name} PR reaches bridge and posts a review without changing the PR state`,async t=>{
    const app=await fixture(t,{pull:state});
    const out=await deliver(app,'issue_comment',comment(),'state-'+state.name);
    assert.equal(out.queued,true);
    const job=await settled(app,out.jobId);assert.equal(job.status,'awaiting_chat');
    const claim=app.bridge.takeNextBridgeJob('fixture-client');assert.equal(claim.jobId,job.id);
    const raw=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts reviewed: no failure']});
    const res=await fetch(app.origin+'/api/bridge',{method:'POST',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},
      body:JSON.stringify({action:'complete',jobId:job.id,leaseId:claim.leaseId,raw,results:[{provider:'chatgpt',raw}]})});
    assert.equal(res.status,200);
    await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===job.id)?.status==='posted','explicit review was not posted');
    assert.equal(app.reviews.length,1);
  });
}
for (const status of ['posted','skipped','dlq','cancelled']) {
  test(`a new explicit request after a ${status} job creates a new review, not a suppressed same-head retry`,async t=>{
    const app=await fixture(t);
    const first=await deliver(app,'issue_comment',comment(),'first-'+status);
    const old=await settled(app,first.jobId);
    app.harbor.patchHarborJob(old.id,j=>({...j,status}));
    const second=await deliver(app,'issue_comment',{...comment(),comment:{id:43,body:'@ashlar-bot review'}},'again-'+status);
    assert.equal(second.queued,true);assert.notEqual(second.jobId,old.id);
    assert.equal((await settled(app,second.jobId)).status,'awaiting_chat');
    assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===old.id).status,status);
  });
}

test('new explicit command supersedes running work but retained PR-body text never does',async t=>{
  const app=await fixture(t,{pull:{draft:true}});
  const first=await deliver(app,'issue_comment',comment(),'in-flight');
  assert.equal((await settled(app,first.jobId)).status,'awaiting_chat');
  const push=await deliver(app,'pull_request',pr('synchronize','@ashlar-bot review'),'push');
  assert.equal(push.queued,false);
  assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===first.jobId).status,'awaiting_chat');
  const second=await deliver(app,'issue_comment',{...comment(),comment:{id:43,body:'@ashlar-bot review'}},'new-request');
  assert.equal((await settled(app,second.jobId)).status,'awaiting_chat');
  assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===first.jobId).status,'cancelled');
  assert.notEqual(first.jobId,second.jobId);
  await eventually(()=>app.ops.some(b=>b.includes(first.jobId)&&/Superseded by a newer review request/.test(b)),'superseded job ops comment marked terminal, not left running');
});

for (const event of ['pull_request', 'pull_request_review_comment']) {
  for (const headRepo of ['null', 'omitted']) {
    for (const fork of [true, null, false]) {
      test(`${event}: ${headRepo} head repo resolves provenance=${fork} before snapshot despite populated SHAs`, async t => {
        const app = await fixture(t, { pull: { fork, headSha: 'newer-head', baseSha: 'newer-base' } });
        const raw = pr('edited', '@ashlar-bot review', {
          changes: { body: { from: 'Description' } }, comment: { id: 44, body: '@ashlar-bot review' },
        });
        raw.repository.fork = false;
        if (headRepo === 'null') raw.pull_request.head.repo = null;
        else delete raw.pull_request.head.repo;
        const out = await deliver(app, event, raw);
        const job = await settled(app, out.jobId);
        assert.equal(app.githubCalls.head, 1, 'unknown provenance must resolve even with both SHAs');
        assert.equal(job.isFork, fork);
        assert.equal(job.headSha, 'abc123', 'metadata-only resolution must keep the requested revision');
        assert.equal(job.baseSha, 'def456');
        if (fork === false) {
          assert.equal(job.status, 'awaiting_chat');
          assert.equal(app.githubCalls.snapshot, 1);
          assert.ok(app.githubCalls.timeline.indexOf('head') < app.githubCalls.timeline.indexOf('snapshot'));
          assert.equal(app.bridge.takeNextBridgeJob('fixture-client').jobId, job.id);
        } else {
          assert.equal(job.status, 'skipped');
          assert.match(job.skipReason, fork === null ? /fork.*unknown/i : /fork/);
          assert.equal(app.githubCalls.snapshot, 0);
          assert.equal(job.chatPrompt, undefined);
          assert.equal(app.bridge.takeNextBridgeJob('fixture-client'), null);
          assert.equal(app.githubCalls.reactions.some(r => r.content === 'eyes'), false);
          await eventually(() => app.ops.some(body => body.includes(job.id) && /fork/.test(body)), 'missing fork policy explanation');
        }
        assert.equal(app.localRequests.length, 0);
      });
    }
  }
}
test('unknown head provenance remains reviewable when the operator explicitly disables fork filtering', async t => {
  const app = await appFixture({ skipForks: false, reviewLocal: false }, { pull: { fork: null } });
  t.after(() => app.close());
  const raw = pr(); raw.pull_request.head.repo = null;
  const out = await deliver(app, 'pull_request', raw);
  const job = await settled(app, out.jobId);
  assert.equal(job.isFork, null);
  assert.equal(job.status, 'awaiting_chat');
  assert.equal(app.githubCalls.head, 1);
  assert.equal(app.githubCalls.snapshot, 1);
});
test('pending head provenance does not expose a prompt or bridge job before metadata returns', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { beforeHead: () => waiting, pull: { fork: false } });
  t.after(() => release());
  const raw = pr(); raw.pull_request.head.repo = null;
  const out = await deliver(app, 'pull_request', raw);
  assert.equal(out.queued, true);
  await eventually(() => app.githubCalls.head === 1, 'metadata resolution did not start');
  const pending = app.harbor.getHarbor().jobs.find(j => j.id === out.jobId);
  assert.equal(pending.status, 'snapshot');
  assert.equal(pending.isFork, null);
  assert.equal(pending.chatPrompt, undefined);
  assert.equal(app.githubCalls.snapshot, 0);
  assert.equal(app.bridge.takeNextBridgeJob('fixture-client'), null);
  assert.equal(app.githubCalls.reactions.length, 0);
  assert.equal(app.localRequests.length, 0);
  release();
  assert.equal((await settled(app, out.jobId)).status, 'awaiting_chat');
});
test('failed head provenance lookup never falls through to snapshot or model work', async t => {
  const app = await fixture(t, { headError: new Error('head metadata unavailable') });
  const raw = pr(); delete raw.pull_request.head.repo;
  const out = await deliver(app, 'pull_request', raw);
  const job = await settled(app, out.jobId);
  assert.equal(job.status, 'skipped');
  assert.match(job.githubError, /head metadata unavailable/);
  assert.equal(app.githubCalls.snapshot, 0);
  assert.equal(app.bridge.takeNextBridgeJob('fixture-client'), null);
  assert.equal(app.githubCalls.reactions.some(r => r.content === 'eyes'), false);
  await eventually(() => app.ops.some(body => body.includes(job.id) && /Status:\*\* failed/.test(body)), 'missing metadata failure explanation');
});
test('a comment on a fork destination resolves the actual head instead of being rejected prematurely', async t => {
  const app = await fixture(t, { pull: { fork: false } });
  const raw = comment(); raw.repository.fork = true;
  const out = await deliver(app, 'issue_comment', raw);
  assert.equal(out.queued, true);
  assert.equal((await settled(app, out.jobId)).status, 'awaiting_chat');
  assert.equal(app.githubCalls.head, 1);
});

test('a /review-loop directive on a draft is an explicit request and reaches the queue',async t=>{
  const app=await fixture(t,{pull:{draft:true}});
  const raw=comment(); raw.comment.body='/review-loop';
  const out=await deliver(app,'issue_comment',raw);
  assert.equal(out.status,202);assert.equal(out.queued,true);
  const job=await settled(app,out.jobId);
  assert.equal(job.status,'awaiting_chat','loop start overrides the draft skip like a mention');
  assert.equal(job.thread?.loop?.kind,'start');
  assert.equal(job.thread?.loop?.mode,'suggest');
});
// WHY two stop tests with different outcomes: harbor persists a visible skipped job (for ops
// feedback) ONLY when the full body is a bot mention. A bare '/review-loop stop' is not a
// mention -> silently dropped (no job); '@ashlar-bot review-loop stop' is -> a skipped job.
test('a /review-loop stop directive is recognized but runs no review',async t=>{
  const app=await fixture(t);
  const raw=comment(); raw.comment.body='/review-loop stop';
  const out=await deliver(app,'issue_comment',raw);
  const job=app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  assert.equal(job,undefined,'stop directive does not enqueue a review job');
  assert.equal(out.queued,false);
});

test('an explicit @ashlar-bot review is not suppressed by a trailing /review-loop stop in the same comment',async t=>{
  const app=await fixture(t);
  const raw=comment(); raw.comment.body='@ashlar-bot review — if it flaps, /review-loop stop';
  const out=await deliver(app,'issue_comment',raw);
  assert.equal(out.status,202);assert.equal(out.queued,true);
  assert.equal((await settled(app,out.jobId)).status,'awaiting_chat');
});

test('@ashlar-bot review-loop stop is control-only: recognized as a skip, no reviewer work',async t=>{
  const app=await fixture(t);
  const raw=comment(); raw.comment.body='@ashlar-bot review-loop stop';
  const out=await deliver(app,'issue_comment',raw);
  const job=app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  assert.equal(job?.status,'skipped');
  assert.equal(job?.skipReason,'review-loop stop (control command — handled by the loop engine)');
  assert.equal(app.localRequests.length,0,'no reviewer leg runs for a stop');
});

test('a retained /review-loop in the PR body does not re-trigger on push (synchronize)',async t=>{
  const app=await fixture(t);
  // PR body carries a one-shot /review-loop; a later push (synchronize) with the same body must NOT re-review.
  const out=await deliver(app,'pull_request',pr('synchronize','/review-loop'));
  assert.equal(out.queued,false,'synchronize with a retained loop directive is not a fresh request');
});

test('self-trigger guard is wired end-to-end with the configured App login (ASHLAR_BOT_LOGIN)',async t=>{
  const app=await fixture(t);
  const from=login=>{const raw=comment(); raw.sender={login}; return raw;};
  // default identity: the App's own comment is never a trigger
  const own=await deliver(app,'issue_comment',from('ashlar-bot-review-loop[bot]'),'d-self-default');
  assert.equal(own.queued,false);assert.match(String(own.ignored||own.skip),/bot-authored/);
  // configured identity: the configured App is self; the default login is then just another sender
  app.env.ASHLAR_BOT_LOGIN='my-app[bot]'; // the app realm's env (read live by ashlarBotLogin)
  const custom=await deliver(app,'issue_comment',from('my-app[bot]'),'d-self-custom');
  assert.equal(custom.queued,false);assert.match(String(custom.ignored||custom.skip),/bot-authored/);
  const other=await deliver(app,'issue_comment',from('ashlar-bot-review-loop[bot]'),'d-other-app');
  assert.equal(other.queued,true,'not self under the configured identity');
});

test('a loop stop whose first attempt failed is retried when GitHub redelivers it (the claim is the only guard)',async t=>{
  let reads=0;
  const app=await appFixture({reviewLocal:false,fixAgent:{provider:'local',delivery:'script-apply',mode:'suggest',parallelPrs:3}},
    {api:{fetchPullHeadRef:async()=>{reads++;throw new Error('GitHub API timeout');}}});
  t.after(()=>app.close());
  app.env.ASHLAR_FIX_AGENT='1';
  const at='2026-01-20T00:00:00Z';
  const stop={...comment(),sender:{login:'alice'},comment:{id:77,body:'/review-loop stop',created_at:at,updated_at:at,user:{login:'alice'}}};
  const first=await deliver(app,'issue_comment',stop,'stop-1');
  assert.equal(first.status,202);
  await eventually(()=>reads===1,'the stop never ran');
  // The first attempt failed and released its claim; the same delivery id (GitHub's redelivery)
  // must run the stop again, even though the first delivery left a 202 event behind.
  await eventually(async()=>{await deliver(app,'issue_comment',stop,'stop-1');return reads>=2;},'the redelivered stop was not retried');
});
