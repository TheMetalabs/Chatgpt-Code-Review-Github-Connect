import {test} from 'node:test';
import assert from 'node:assert/strict';
import {background, storage, raw, content, flush, source} from './helpers.mjs';

function work(id='A',providers=['chatgpt'], offset=10) {
  return {jobId:id,origin:'http://bridge',leaseId:'lease-'+id,prompt:'review '+id,providers,
    states:Object.fromEntries(providers.map((p,i)=>[p,{tabId:offset+i,started:true,runId:id+'-'+p}]))};
}
function scenario(jobs=[work()], overrides={}) {
  const tabs = new Map(), binding = new Map();
  for(const job of jobs) for(const p of job.providers) {
    const s=job.states[p]; if(!s.tabId) continue;
    tabs.set(s.tabId,{id:s.tabId,url:p==='grok'?'https://grok.com/c/'+job.jobId:'https://chatgpt.com/c/'+job.jobId,status:'complete'});
    binding.set(s.tabId,{jobId:job.jobId,provider:p,runId:s.runId});
  }
  const api = async (_p,b) => b?.action==='ping'?{ok:true,active:true,accepted:true,status:'awaiting_chat'}:{ok:true,prompt:'p',job:null};
  const handler=(id,msg)=> ({...binding.get(id),...(msg.type==='ashlar-can-close'?{ok:true,canClose:true,url:tabs.get(id).url}:{ok:true,raw})});
  return background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:Object.fromEntries(jobs.map(j=>[j.jobId,j]))}),tabs,api,handler,...overrides});
}

test('closes each provider only after final payload ACK and durable cleanup intent',async()=>{
  const b=scenario([work('A',['chatgpt','grok'])]);
  const remove=b.chrome.tabs.remove;
  b.chrome.tabs.remove=async id=>{
    const p=id===10?'chatgpt':'grok', saved=b.local.state.pendingReviewJobs.A.states[p];
    assert.equal(saved.delivered,true);assert.equal(saved.cleanupPending,true);
    assert.ok(b.calls.some(c=>c.action==='complete'&&c.jobId==='A'&&c.results[0].provider===p));
    return remove(id);
  };
  await b.tick();assert.deepEqual(b.closedTabs,[10,11]);assert.deepEqual(b.local.state.pendingReviewJobs,{});
});
test('one completed provider closes while its other provider continues indefinitely',async()=>{
  const b=scenario([work('A',['chatgpt','grok'])]);const handler=b.chrome.tabs.sendMessage;
  b.chrome.tabs.sendMessage=(id,msg,cb)=>id===11?cb({jobId:'A',runId:'A-grok',provider:'grok',ok:false,code:'busy'}):handler(id,msg,cb);
  await b.tick();assert.deepEqual(b.closedTabs,[10]);assert.ok(b.tabs.has(11));
  assert.equal(b.local.state.pendingReviewJobs.A.states.grok.delivered,undefined);
});
test('network failures retain exact raw and tab until server acknowledgement',async()=>{
  let offline=true;const b=scenario([work()],{api:async(_p,body)=>{if(body?.action==='complete'&&offline)throw Error('offline');return {ok:true,active:true,accepted:true};}});
  await b.tick();assert.equal(b.closedTabs.length,0);assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome.raw,raw);
  offline=false;await b.tick();assert.deepEqual(b.closedTabs,[10]);
});
test('failed tab removal remains retryable after worker restart, without another completion',async()=>{
  const b=scenario();b.chrome.tabs.remove=async()=>{throw Error('tab is being dragged');};
  await b.tick();assert.ok(b.local.state.pendingReviewJobs.A?.states.chatgpt.cleanupPending);
  const r=scenario([],{local:b.local,tabs:b.tabs,handler:(id,msg)=>({jobId:'A',provider:'chatgpt',runId:'A-chatgpt',ok:true,canClose:true,url:'https://chatgpt.com/c/A'})});
  await r.tick();assert.deepEqual(r.closedTabs,[10]);assert.equal(r.calls.some(c=>c.action==='complete'),false);assert.deepEqual(r.local.state.pendingReviewJobs,{});
});
test('two recovered PRs receive their own JSON and cleanup never closes the other PR',async()=>{
  const b=scenario([work('A',['chatgpt'],10),work('B',['chatgpt'],20)]);
  const orig=b.chrome.tabs.sendMessage;
  b.chrome.tabs.sendMessage=(id,msg,cb)=>orig(id,msg,r=>cb({...r,raw:JSON.stringify({findings:[],keep:[id===10?'A':'B']})}));
  await b.tick();const sent=b.calls.filter(c=>c.action==='complete');
  assert.deepEqual(sent.map(c=>[c.jobId,JSON.parse(c.raw).keep[0]]),[['A','A'],['B','B']]);assert.deepEqual(b.closedTabs,[10,20]);
});
test('wrong job or run identity can never be stored under the requested PR',async()=>{
  for(const mismatch of [{jobId:'B'},{runId:'another-run'},{provider:'grok'}]){
    const b=scenario([work()],{handler:()=>({ok:true,raw,jobId:'A',provider:'chatgpt',runId:'A-chatgpt',...mismatch})});
    await b.tick();assert.equal(b.calls.some(c=>c.action==='complete'),false);assert.equal(b.closedTabs.length,0);assert.ok(b.local.state.pendingReviewJobs.A);
  }
});
test('unknown 404 is not cancellation and does not discard a tab or outbox',async()=>{
  const b=scenario([work()],{api:async(_p,body)=>{if(!body)throw Object.assign(Error('no prompt'),{status:404});return {ok:true,active:false,status:'missing',accepted:false};}});
  await b.tick();assert.equal(b.closedTabs.length,0);assert.ok(b.local.state.pendingReviewJobs.A);
});
test('active=false in validator is not permission to close an unacknowledged generation',async()=>{
  const b=scenario([work()],{api:async()=>({ok:true,active:false,status:'validator',accepted:false}),handler:()=>({ok:false,code:'busy',jobId:'A',provider:'chatgpt',runId:'A-chatgpt'})});
  await b.tick();assert.ok(b.local.state.pendingReviewJobs.A);assert.equal(b.closedTabs.length,0);assert.equal(b.messages.some(m=>m.type==='ashlar-run'),false);
});
test('explicit cancellation closes a tab its page proves Ashlar\'s, even unfinished; an unproven page is asked again, never closed on a guess',async()=>{
  const cancelled=async()=>({ok:true,active:false,status:'cancelled',accepted:false});
  const url='https://chatgpt.com/c/A',page={jobId:'A',runId:'A-chatgpt',provider:'chatgpt'};
  const b=scenario([work()],{api:cancelled,handler:(_id,msg)=>msg.type==='ashlar-fix-cancel'
    ?{...page,ok:true,ownership:'owned',conversation:url,running:true,url}:{...page,ok:false,code:'busy'}});
  await b.tick();assert.deepEqual(b.closedTabs,[10]);assert.equal(b.calls.some(c=>c.action==='complete'),false);
  assert.deepEqual(b.local.state.pendingReviewJobs,{});
  const r=scenario([work()],{api:cancelled,handler:()=>({...page,ok:true,ownership:'unknown',running:true,url})});
  await r.tick();assert.equal(r.closedTabs.length,0);assert.ok(r.local.state.pendingReviewJobs.A,'asked again next tick');
});
test('navigate-away and reused numeric tab IDs are never auto-closed',async()=>{
  for(const mode of ['url','identity','repurposed']){
    const j=work();Object.assign(j.states.chatgpt,{delivered:true,cleanupPending:true,outcome:{ok:true,raw}});
    const b=scenario([j],{handler:()=>mode==='identity'?{ok:false,code:'job_mismatch',jobId:'B',runId:'B-chatgpt',provider:'chatgpt'}:{ok:true,jobId:'A',runId:'A-chatgpt',provider:'chatgpt',canClose:false,reason:'repurposed'}});
    if(mode==='url')b.tabs.get(10).url='https://example.com/personal';
    await b.tick();assert.equal(b.closedTabs.length,0,mode);
  }
});
test('a review leg that stalled under a stuck Stop keeps its tab and retires (#87)',async()=>{
  const j=work();Object.assign(j.states.chatgpt,{delivered:true,cleanupPending:true,outcome:{ok:false,code:'stalled',error:'ChatGPT answer unchanged for 15 min without completion controls'}});
  let released=false;
  const b=scenario([j],{handler:(id,msg)=>{
    if(msg.type==='ashlar-can-close'){released=true;return {ok:true,jobId:'A',runId:'A-chatgpt',provider:'chatgpt',canClose:false,reason:'stalled',url:'https://chatgpt.com/c/A'};}
    return {ok:true,ownershipProtocol:1,jobId:'A',runId:'A-chatgpt',provider:'chatgpt',released,url:'https://chatgpt.com/c/A'};
  }});
  await b.tick();
  assert.equal(b.closedTabs.length,0,'never closed while Stop is visible');assert.ok(b.tabs.has(10));
  assert.equal(b.local.state.pendingReviewJobs.A,undefined,'the leg retires instead of waiting forever for a close');
  assert.equal((await b.context.tabCapacityReport({})).managedTabs,0,'the kept tab holds no tab capacity');
});
test('manual close tracking ignores unrelated tabs and completed auto-cleanup leaves no markers',async()=>{
  const b=scenario();for(let i=1000;i<1100;i++)await b.closeTab(i);
  assert.equal(Object.keys(b.local.state).filter(k=>k.startsWith('ashlar:closed:')).length,0);
  await b.tick();assert.equal(Object.keys(b.session.state).filter(k=>k.startsWith('ashlar:')).length,0);
});
test('one PR transport error cannot starve result collection for another recovered PR',async()=>{
  const b=scenario([work('A',['chatgpt'],10),work('B',['chatgpt'],20)],{api:async(p,body)=>{
    if(body?.jobId==='A'||p.includes('jobId=A'))throw Error('A transport unavailable');return {ok:true,active:true,accepted:true};
  }});
  await b.tick();assert.ok(b.calls.some(c=>c.action==='complete'&&c.jobId==='B'));assert.ok(b.tabs.has(10));assert.ok(!b.tabs.has(20));
});
test('tab admission limit delays creation without cancelling or timing out existing reviews',async()=>{
  const jobs=[work('A',['chatgpt'],10),work('B',['chatgpt'],20),work('C',['chatgpt'],30),work('D',['chatgpt'],40),work('E',['chatgpt'],50)];
  jobs[4].states.chatgpt={};
  const b=scenario(jobs,{handler:()=>({ok:false,code:'busy'})});
  await b.tick();assert.equal(b.tabs.size,4);assert.ok(b.local.state.pendingReviewJobs.E);assert.equal(b.calls.some(c=>c.action==='failure'),false);
});
test('automatic output extraction never reads a shared system clipboard',async()=>{
  // Run the actual extractor with a completed non-JSON DOM and a different PR in clipboard.
  const c=content();let reads=0;
  c.context.navigator={clipboard:{writeText:async()=>{},readText:async()=>{reads++;return raw;}}};
  c.context.currentAssistantRoot=()=>({querySelectorAll:()=>[{getAttribute:()=> 'Copy response',click(){}}]});
  c.context.harvestJson=()=>null;c.context.stopButtonVisible=()=>false;c.context.replyDoneVisible=()=>true;c.context.sleep=async()=>{};
  const stop = new Error('test cancellation'); let polls = 0;
  c.context.sleep=async()=>{if(++polls===20)throw stop;};
  await assert.rejects(c.context.waitUntilReviewOrQuota('ChatGPT'),e=>e===stop);assert.equal(reads,0);
});
test('runner close permission rejects a fresh user turn and a wrong run; a busy page is not user activity',async()=>{
  // The run starts on the new chat its tab opened (X2, #85); its send moves the page to /c/A.
  const c=content();const users=[];
  c.context.composer=()=>null;
  c.context.document={querySelectorAll:()=>users,querySelector:()=>users[0]||null};
  c.context.runPrompt=async()=>{users.push({textContent:'review A',getAttribute:()=>null});c.context.location={href:'https://chatgpt.com/c/A'};return raw;};
  c.context.stopButtonVisible=()=>false;
  c.message({type:'ashlar-run',jobId:'A',runId:'run-A',provider:'chatgpt',prompt:'review'});await flush();
  const msg={type:'ashlar-can-close',jobId:'A',runId:'run-A',provider:'chatgpt'};
  assert.equal(c.message(msg)?.canClose,true);
  // The provider redrawing its own answer (or a Stop control) after the result is secured does not keep the tab.
  c.context.stopButtonVisible=()=>true;assert.equal(c.message(msg)?.canClose,true);
  users.push({textContent:'personal follow-up',getAttribute:()=>null});
  const followup=c.message(msg);
  assert.equal(followup?.canClose,false);assert.equal(followup?.reason,'repurposed');assert.equal(followup?.cause,'user_turn');
  assert.equal(c.message({...msg,runId:'run-B'})?.code,'job_mismatch');
});

test('a lost completion ACK is replayed after server moves to posted, then the tab closes',async()=>{
  let stored=false,posts=0;
  const b=scenario([work()],{api:async(_p,body)=>{
    if(body?.action==='ping')return {ok:true,accepted:!stored,active:!stored,status:stored?'posted':'awaiting_chat'};
    if(body?.action==='complete'){
      posts++;if(!stored){stored=true;throw Error('ACK lost after server persisted payload');}
      assert.equal(body.raw,raw);return {ok:true};
    }
    return {ok:true};
  }});
  await b.tick();assert.equal(b.closedTabs.length,0);assert.ok(b.local.state.pendingReviewJobs.A);
  await b.tick();assert.equal(posts,2);assert.deepEqual(b.closedTabs,[10]);assert.deepEqual(b.local.state.pendingReviewJobs,{});
  assert.equal(b.messages.some(m=>m.type==='ashlar-run'),false);
});

test('repeated acknowledged reviews do not accumulate tabs or cleanup metadata',async()=>{
  let n=0;
  const b=background({api:async(_p,body)=>body?.action==='take'?{ok:true,job:{jobId:'PR-'+(++n),providers:['chatgpt'],prompt:'review'}}:{ok:true,active:true,accepted:true},
    handler:(_id,msg)=>({ok:true,raw:JSON.stringify({findings:[],keep:[msg.jobId]})})});
  for(let i=0;i<100;i++){
    await b.tick();assert.equal(b.tabs.size,0);assert.deepEqual(b.local.state.pendingReviewJobs,{});
    assert.equal(Object.keys(b.session.state).filter(k=>k.startsWith('ashlar:')).length,0);
  }
  assert.equal(b.closedTabs.length,100);
  assert.equal(b.calls.filter(c=>c.action==='complete').length,100);
});
