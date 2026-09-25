import test from 'node:test';
import assert from 'node:assert/strict';
import {background,storage,flush,until} from './helpers.mjs';

const response=id=>JSON.stringify({findings:[],keep:[id],merge_recommendation:'APPROVE'});
const request=(id,providers=['chatgpt'])=>({jobId:id,providers,provider:providers[0],prompt:'review '+id,leaseId:'lease-'+id});
function pending(id,tabId,providers=['chatgpt']) {
  return {...request(id,providers),origin:'http://bridge',states:Object.fromEntries(providers.map((p,i)=>[p,{tabId:tabId+i,started:true,runId:id+'-'+p}]))};
}
function fixture(initial=[],queue=[],options={}) {
  const waiting=[...queue],done=new Set(),tabs=new Map();
  for(const j of initial)for(const [p,s] of Object.entries(j.states))if(s.tabId)tabs.set(s.tabId,{id:s.tabId,url:p==='grok'?'https://grok.com/':'https://chatgpt.com/c/'+j.jobId,status:'complete'});
  const b=background({tabs,local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:Object.fromEntries(initial.map(j=>[j.jobId,j])),...options}),
    api:async(_path,body)=>{
      if(body?.action==='take') {
        const i=waiting.findIndex(j=>!body.excludeJobIds?.includes(j.jobId));
        return {ok:true,job:i<0?null:waiting.splice(i,1)[0]};
      }
      if(body?.action==='claim')return {ok:true,leaseId:'lease-'+body.jobId};
      return {ok:true,active:true,accepted:true,prompt:'fixture'};
    },handler:(_id,msg)=>done.has(msg.jobId+':'+msg.provider)||done.has(msg.jobId)?{ok:true,raw:response(msg.jobId)}:{ok:false,code:'busy'}});
  let run=0;b.context.crypto.randomUUID=()=>`run-${++run}`;
  return {...b,waiting,done};
}
async function reached(check,message) {
  for(let i=0;i<100;i++){if(check())return;await flush();}
  assert.ok(check(),message);
}
function gate(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('parallel: running A does not prevent B admission with free slots',async()=>{
  const b=fixture([pending('A',10)],[request('B')]);await b.tick();
  assert.ok(b.messages.some(m=>m.jobId==='B'&&m.type==='ashlar-run'),'B must start before A completes');
  assert.equal(b.calls.filter(c=>c.action==='take').length,1);
  assert.ok(b.calls.find(c=>c.action==='take').excludeJobIds.includes('A'));
  assert.ok(b.local.state.pendingReviewJobs.A);assert.ok(b.local.state.pendingReviewJobs.B);
  assert.equal(b.closedTabs.length,0);
});

// Tab operations run one at a time (the tab queue, #85): a page that never answers costs the others
// at most its reply window (here expiring at once), then it is backed off. It never holds them.
const expiresAtOnce=()=>({promise:new Promise((_resolve,reject)=>setImmediate(()=>reject(new Error('the page did not answer in time')))),cancel(){}});
test('parallel: blocked A transport delays B completion and the next C admission by its reply window at most, never holds them',async()=>{
  const b=fixture([pending('A',10)],[request('B'),request('C')]);
  b.context.pageReplyDeadline=expiresAtOnce;
  const send=b.chrome.tabs.sendMessage,held=[];b.chrome.tabs.sendMessage=(id,msg,cb)=>msg.jobId==='A'||id===10?held.push(()=>send(id,msg,cb)):send(id,msg,cb);
  const first=b.tick();let second;
  try {
    assert.ok(await until(()=>b.messages.some(m=>m.jobId==='B'&&m.type==='ashlar-run')),'A transport held up B admission');
    b.done.add('B');second=b.tick();
    assert.ok(await until(()=>b.calls.some(c=>c.action==='complete'&&c.jobId==='B')),'B completion waited for A');
    assert.ok(await until(()=>b.messages.some(m=>m.jobId==='C'&&m.type==='ashlar-run')),'C admission waited for A');
    assert.ok(b.tabs.has(10));assert.equal(b.calls.some(c=>c.action==='failure'),false);
  } finally {b.chrome.tabs.sendMessage=send;for(const release of held)release();await Promise.all([first,second]);}
});

test('parallel: a stalled A heartbeat cannot hold another job or admission',async()=>{
  const b=fixture([pending('A',10),pending('B',20)],[request('C')]);b.done.add('B');
  const api=b.context.api,hold=gate();b.context.api=(path,body,...args)=>body?.jobId==='A'?hold.promise.then(()=>api(path,body,...args)):api(path,body,...args);
  const running=b.tick();try {
    await reached(()=>b.calls.some(c=>c.jobId==='B'&&c.action==='complete'),'A heartbeat blocked B');
    await reached(()=>b.messages.some(m=>m.jobId==='C'&&m.type==='ashlar-run'),'A heartbeat blocked C');
  } finally {hold.resolve();await running;}
});

test('parallel: overlapping wakeups do not double take, start, or overwrite jobs',async()=>{
  const b=fixture([],[request('A'),request('B')]);
  await Promise.all(Array.from({length:8},()=>b.tick()));
  assert.equal(b.calls.filter(c=>c.action==='take').length,1);
  assert.equal(b.messages.filter(m=>m.jobId==='A'&&m.type==='ashlar-run').length,1);
  await Promise.all(Array.from({length:8},()=>b.tick()));
  assert.equal(b.messages.filter(m=>m.jobId==='B'&&m.type==='ashlar-run').length,1);
  assert.deepEqual(Object.keys(b.local.state.pendingReviewJobs).sort(),['A','B']);
});

test('parallel: four physical tabs cap six pending PRs without cancelling generation',async()=>{
  const b=fixture([],['A','B','C','D','E','F'].map(id=>request(id)));
  for(let i=0;i<8;i++)await b.tick();
  assert.equal(b.tabs.size,4);assert.equal(b.waiting.length,2);
  b.done.add('B');await b.tick();await b.tick();
  assert.ok(b.messages.some(m=>m.jobId==='E'&&m.type==='ashlar-run'));
  assert.equal(b.tabs.size,4);assert.ok(b.local.state.pendingReviewJobs.A);
  assert.equal(b.calls.some(c=>c.action==='failure'),false);
});

test('parallel: simultaneous multi-provider allocation never exceeds the tab cap',async()=>{
  const b=fixture([pending('A',10)],['B','C','D'].map(id=>request(id,['chatgpt','grok'])),{maxReviewTabs:3});
  const create=b.chrome.tabs.create;let peak=1;
  b.chrome.tabs.create=async properties=>{await flush();const tab=await create(properties);peak=Math.max(peak,b.tabs.size);return tab;};
  for(let i=0;i<5;i++)await Promise.all([b.tick(),b.tick()]);
  assert.equal(peak,3);assert.equal(b.waiting.length,2);
  assert.equal(b.messages.filter(m=>m.type==='ashlar-run').length,2);
});

test('parallel: one free slot stages the second provider instead of over-creating',async()=>{
  const b=fixture([],[request('A',['chatgpt','grok']),request('B')],{maxReviewTabs:1});
  await b.tick();assert.equal(b.tabs.size,1);assert.equal(b.waiting.length,1);
  b.done.add('A:chatgpt');await b.tick();await b.tick();
  assert.equal(b.tabs.size,1);assert.ok(b.messages.some(m=>m.provider==='grok'&&m.type==='ashlar-run'));
  assert.equal(b.messages.some(m=>m.jobId==='B'),false);
});

test('parallel: a restart retains A/B runs and admits C without duplicate generation',async()=>{
  const b=fixture([],[request('A'),request('B'),request('C')]);await b.tick();await b.tick();
  const r=background({local:b.local,session:b.session,tabs:b.tabs,api:b.context.api,handler:()=>({ok:false,code:'busy'})});
  await r.tick();
  assert.equal(r.messages.filter(m=>['A','B'].includes(m.jobId)&&m.type==='ashlar-run').length,0);
  assert.equal(r.messages.filter(m=>m.jobId==='C'&&m.type==='ashlar-run').length,1);
  assert.deepEqual(Object.keys(r.local.state.pendingReviewJobs).sort(),['A','B','C']);
});

test('parallel: later B response is posted only to B and only B tab closes',async()=>{
  const b=fixture([pending('A',10)],[request('B')]);await b.tick();b.done.add('B');await b.tick();
  const sent=b.calls.filter(c=>c.action==='complete');assert.equal(sent.length,1);
  assert.equal(sent[0].jobId,'B');assert.equal(JSON.parse(sent[0].raw).keep[0],'B');
  assert.ok(b.tabs.has(10));assert.equal(b.closedTabs.length,1);assert.notEqual(b.closedTabs[0],10);
});

test('parallel: cleanup failure occupies its real slot but not every free slot',async()=>{
  const a=pending('A',10);Object.assign(a.states.chatgpt,{delivered:true,outcome:{ok:true,raw:response('A')}});
  const b=fixture([a],[request('B')]);b.done.add('A');b.chrome.tabs.remove=async()=>{throw Error('tab dragging');};
  await b.tick();assert.ok(b.messages.some(m=>m.jobId==='B'&&m.type==='ashlar-run'));
  assert.ok(b.local.state.pendingReviewJobs.A.states.chatgpt.cleanupPending);
});

test('parallel: absent old tab IDs are not four occupied physical slots',async()=>{
  const old=['A','B','C','D'].map((id,i)=>pending(id,10+i));const b=fixture(old,[request('E')]);b.tabs.clear();
  const api=b.context.api;b.context.api=(path,body,...args)=>old.some(j=>j.jobId===body?.jobId)?Promise.resolve({ok:true,accepted:false,active:false,status:'missing'}):api(path,body,...args);
  await b.tick();assert.ok(b.messages.some(m=>m.jobId==='E'&&m.type==='ashlar-run'));
  for(const j of old)assert.ok(b.local.state.pendingReviewJobs[j.jobId]);
});

test('parallel: delayed persistence never drops another job outbox',async()=>{
  const b=fixture([pending('A',10),pending('B',20)]);b.done.add('A');b.done.add('B');
  const set=b.local.set;let active=0,peak=0;
  b.local.set=async values=>{
    if(!('pendingReviewJobs'in values))return set(values);
    active++;peak=Math.max(peak,active);await flush();await flush();await set(values);active--;
  };
  const api=b.context.api;b.context.api=(path,body,...args)=>body?.action==='complete'?Promise.reject(Error('keep outboxes')):api(path,body,...args);
  await Promise.all([b.tick(),b.tick()]);
  assert.equal(peak,1,'whole-map snapshots must be ordered');
  for(const id of ['A','B'])assert.equal(b.local.state.pendingReviewJobs[id].states.chatgpt.outcome.raw,response(id));
  assert.equal(b.closedTabs.length,0);
});

test('parallel: server ignoring exclusions cannot replace an existing job identity',async()=>{
  const a=pending('A',10);const b=fixture([a]);const api=b.context.api;
  b.context.api=(path,body,...args)=>body?.action==='take'?Promise.resolve({ok:true,job:{...request('A'),prompt:'WRONG'}}):api(path,body,...args);
  await b.tick();assert.equal(b.local.state.pendingReviewJobs.A.prompt,a.prompt);
  assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.runId,'A-chatgpt');assert.equal(b.tabs.size,1);
});

test('parallel: independent heartbeat renews the actual jobs during slow DOM work',async()=>{
  const b=fixture([pending('A',10),pending('B',20)]);const send=b.chrome.tabs.sendMessage,held=[];
  b.chrome.tabs.sendMessage=(id,msg,cb)=>held.push(Object.assign(()=>send(id,msg,cb),{message:msg}));
  // (One page message at a time is in flight: the tab queue. The heartbeat is a bridge lane, outside it.)
  const running=b.tick();try {
    await reached(()=>held.length>=1,'the DOM work is under way');
    assert.equal(typeof b.context.heartbeatTick,'function');const before=b.calls.length;
    await b.context.heartbeatTick();
    const pings=b.calls.slice(before).filter(c=>c.action==='ping'&&c.jobId);
    assert.deepEqual(pings.map(c=>c.jobId).sort(),['A','B']);
    assert.ok(pings.every(c=>c.generating.chatgpt===true&&c.leaseId==='lease-'+c.jobId));
  } finally {b.chrome.tabs.sendMessage=send;for(const release of held)release();await running;}
});

test('parallel: failed pre-create persistence retries safely instead of stranding allocation',async()=>{
  const b=fixture([],[request('A')]);const set=b.local.set;let fail=true;
  b.local.set=async values=>{
    if(fail&&values.pendingReviewJobs?.A?.states.chatgpt.allocating){fail=false;throw Error('transient storage failure before create');}
    return set(values);
  };
  await b.tick();assert.equal(b.tabs.size,0);await b.tick();
  assert.equal(b.tabs.size,1);assert.equal(b.messages.filter(m=>m.jobId==='A'&&m.type==='ashlar-run').length,1);
});

test('parallel: new wakeups do not accumulate waiters behind an already running lane',async()=>{
  const b=fixture([pending('A',10)]);const send=b.chrome.tabs.sendMessage,held=[];
  b.chrome.tabs.sendMessage=(id,msg,cb)=>held.push(Object.assign(()=>send(id,msg,cb),{message:msg}));
  const first=b.tick();let later;
  try {
    // (The first held message may be the inventory's probe: one tab operation at a time.)
    await reached(()=>held.length>=1,'A did not start');let done=false;
    later=b.tick().then(()=>{done=true;});await reached(()=>done,'later wakeup joined a blocked old lane');
    assert.ok(held.filter(r=>r.message.type!=='ashlar-tab-status').length<=1,'no second waiter on A\'s lane');
    assert.ok(held.filter(r=>r.message.type==='ashlar-tab-status').length<=1,'inventory probes also stay single-flight');
  } finally {b.chrome.tabs.sendMessage=send;for(const release of held)release();await Promise.all([first,later]);}
});

test('parallel: unknown create intent after restart never dispatches a duplicate tab',async()=>{
  const a=pending('A',10);a.states.chatgpt={runId:'A-chatgpt',allocating:true};const b=fixture([a],[request('B')]);
  await b.tick();assert.equal(b.messages.some(m=>m.jobId==='A'&&m.type==='ashlar-run'),false);
  assert.equal(b.messages.filter(m=>m.jobId==='B'&&m.type==='ashlar-run').length,1);
  assert.ok(b.local.state.pendingReviewJobs.A.states.chatgpt.allocating);
});

test('parallel: recorded allocation is recovered after restart before any new create',async()=>{
  const a=pending('A',10);a.states.chatgpt={runId:'A-chatgpt',allocating:true};const b=fixture([a]);
  b.tabs.set(10,{id:10,url:'https://chatgpt.com/',status:'complete'});
  await b.session.set({'ashlar:tab:10':{jobId:'A',provider:'chatgpt',runId:'A-chatgpt'}});
  await b.tick();assert.equal(b.tabs.size,1);assert.equal(b.messages.find(m=>m.type==='ashlar-run').id,10);
});

test('parallel: restored provider tab with changed numeric ID still reserves capacity',async()=>{
  const a=pending('A',10),b=fixture([a],[],{maxReviewTabs:1});b.tabs.delete(10);
  b.tabs.set(99,{id:99,url:'https://chatgpt.com/c/A',status:'complete'});
  assert.equal(await b.context.tabCapacityAvailable({A:a},true),false);
  assert.equal(b.closedTabs.length,0);
});

test('parallel: one failed cleanup never releases the job lock while its sibling is running',async()=>{
  const a=pending('A',10,['chatgpt','grok']);for(const s of Object.values(a.states)){s.delivered=true;s.outcome={ok:true,raw:response('A')};}
  const b=fixture([a]);b.done.add('A');const set=b.local.set;let fail=true;
  b.local.set=async values=>{if(fail&&values.pendingReviewJobs?.A?.states.chatgpt.cleanupPending){fail=false;throw Error('write failed');}return set(values);};
  const remove=b.chrome.tabs.remove,hold=gate();let removing=false;
  b.chrome.tabs.remove=async id=>{removing=true;await hold.promise;return remove(id);};
  let finished=false;const first=b.tick().then(()=>{finished=true;});
  try {await reached(()=>removing,'sibling cleanup did not start');for(let i=0;i<10;i++)await flush();assert.equal(finished,false,'job lock released before sibling finished');}
  finally {hold.resolve();await first;}
});

test('parallel: merged connection diagnostics remain available without an active-job gate',async()=>{
  const b=fixture([pending('A',10)],[request('B')]);
  assert.equal(typeof b.context.probeBridge,'function','PR35 connection probe was removed');
  assert.equal(await b.context.probeBridge(),true);await b.tick();
  assert.equal(b.local.state.bridgeHealth.ok,true);
  assert.equal(b.local.state.bridgeWorkerStatus.activeJobs,2);
  assert.ok(b.messages.some(m=>m.jobId==='B'&&m.type==='ashlar-run'));
});

test('parallel: missing server job still saves its original final response while admitting B',async()=>{
  const b=fixture([pending('A',10)],[request('B')]);b.done.add('A');const api=b.context.api;
  b.context.api=(path,body,...args)=>body?.jobId==='A'?Promise.resolve({ok:true,active:false,accepted:false,status:'missing'}):api(path,body,...args);
  await b.tick();assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome?.raw,response('A'));
  assert.equal(b.calls.some(c=>c.jobId==='A'&&c.action==='complete'),false);
  assert.ok(b.tabs.has(10));assert.ok(b.messages.some(m=>m.jobId==='B'&&m.type==='ashlar-run'));
});

test('parallel: health diagnostics pin the origin and never persist response credentials',async()=>{
  const b=fixture();assert.equal(typeof b.context.probeBridge,'function');
  b.context.api=async(_path,_body,origin)=>{assert.equal(origin,'http://bridge');return {ok:true,bridge:{pendingJobs:3,token:'must not persist'}};};
  await b.context.probeBridge();assert.equal(b.local.state.bridgeHealth.pendingJobs,3);
  assert.equal('token' in b.local.state.bridgeHealth,false);
});
