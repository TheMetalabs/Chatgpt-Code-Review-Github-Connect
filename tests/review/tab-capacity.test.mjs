import test from 'node:test';
import assert from 'node:assert/strict';
import {background,storage,flush,raw} from './helpers.mjs';
const makeJob=(id,tabId)=>({jobId:id,origin:'http://bridge',leaseId:'lease-'+id,prompt:'review',providers:['chatgpt'],states:{chatgpt:{started:true,runId:'run-'+id,tabId}}});

test('capacity distinguishes seven personal tabs from four missing restoration bindings',async()=>{
 const jobs=Object.fromEntries(['A','B','C','D'].map((id,i)=>[id,makeJob(id,10+i)]));
 const tabs=new Map(Array.from({length:7},(_,i)=>[100+i,{id:100+i,url:'https://chatgpt.com/c/personal-'+i,status:'complete'}]));
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:jobs}),tabs,
  handler:(id,msg)=>msg.type==='ashlar-tab-status'?{ok:true,ownershipProtocol:1,jobId:'',runId:'',provider:'chatgpt',url:tabs.get(id).url}:{ok:false,code:'job_mismatch',jobId:'',runId:''},
  api:async()=>({ok:true,active:false,status:'missing',job:null})});
 for(let i=0;i<4;i++){await b.tick();await flush();}
 assert.ok(b.calls.some(c=>c.action==='take'),'proven unbound tabs must not keep missing work at capacity');
 assert.equal(b.closedTabs.length,0);assert.equal(b.tabs.size,7);
 assert.equal(Object.keys(b.local.state.pendingReviewJobs).length,4,'missing work must not be discarded');
 assert.equal(b.local.state.bridgeWorkerStatus.capacity.used,0);
 assert.equal(b.local.state.bridgeWorkerStatus.capacity.providerTabs,7);
});

test('a pending job transport cannot block acknowledged peer cleanup at the capacity gate',async t=>{
 const a=makeJob('A',10);a.providers.push('grok');a.states.grok={tabId:11,started:true,runId:'run-G'};
 const b=background({local:storage({origin:'http://bridge',token:'token',maxReviewTabs:2,pendingReviewJobs:{A:a}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A'}],[11,{id:11,url:'https://grok.com/c/A'}]]),
  handler:(id)=>({ok:true,canClose:true,raw,url:id===10?'https://chatgpt.com/c/A':'https://grok.com/c/A'})});
 let release;const pending=new Promise(resolve=>release=resolve);t.after(()=>release({ok:true,accepted:true,active:true}));
 b.context.heartbeat=()=>pending;
 const jobs=await b.context.workerJobs('http://bridge');void b.context.progressJob(jobs.A,jobs);await flush();
 // A repair lane can acknowledge G while the main A lane is suspended in transport.
 Object.assign(jobs.A.states.grok,{delivered:true,cleanupPending:true,outcome:{ok:true,raw}});
 void b.tick();for(let i=0;i<8;i++)await flush();
 assert.deepEqual(b.closedTabs,[11],'cleanup must have its own lane independent of progressJob');
});

for(const released of [false,true])test(`positively bound orphan tab is protected and counted unless explicitly released (${released})`,async()=>{
 const tabs=new Map([[10,{id:10,url:'https://chatgpt.com/c/original',status:'complete'}]]);
 const b=background({local:storage({origin:'http://bridge',token:'token',maxReviewTabs:1,pendingReviewJobs:{}}),tabs,
  handler:(_id,msg)=>msg.type==='ashlar-tab-status'?{ok:true,ownershipProtocol:1,jobId:'orphan',provider:'chatgpt',runId:'old-run',released,url:tabs.get(10).url}:{ok:false,code:'job_mismatch'},
  api:async()=>({ok:true,job:null})});
 await b.context.refreshTabInventory();await flush();await flush();
 const out=await b.context.tabCapacityReport({},true);
 assert.equal(out.used,released?0:1);assert.equal(out.orphanTabs,released?0:1);
 assert.equal(b.closedTabs.length,0,'orphan or user-owned tabs cannot be arbitrarily closed');
});

test('unverified existing provider tabs reserve physical space until read-only ownership is established',async()=>{
 const b=background({local:storage({origin:'http://bridge',token:'token',maxReviewTabs:1,pendingReviewJobs:{}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/unknown'}]])});
 const out=await b.context.tabCapacityReport({},true);assert.equal(out.used,1);assert.equal(out.unverifiedTabs,1);
 assert.equal(await b.context.tabCapacityAvailable({},true),false);
});


test('released matching job tab does not consume managed capacity while server-side work remains',async()=>{
 const job=makeJob('A',10);
 const tabs=new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]);
 const b=background({local:storage({origin:'http://bridge',token:'token',maxReviewTabs:1,pendingReviewJobs:{A:job}}),tabs,
  handler:(_id,msg)=>msg.type==='ashlar-tab-status'?{ok:true,ownershipProtocol:1,jobId:'A',provider:'chatgpt',runId:'run-A',released:true,url:tabs.get(10).url}:{ok:false,code:'job_mismatch'}});
 await b.context.refreshTabInventory();await flush();await flush();
 const out=await b.context.tabCapacityReport({A:job},true);
 assert.equal(out.managedTabs,0);assert.equal(out.used,0);
 assert.equal(await b.context.tabCapacityAvailable({A:job},true),true);
 assert.equal(b.closedTabs.length,0,'released user tab must remain open');
});


test('late sibling binding merges into an already recovered job without replacement generation',async()=>{
 const tabs=new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]);
 let recoveries=0;
 const b=background({local:storage({origin:'http://bridge',token:'token','ashlar:client':'client-A',
   bridgeHealth:{origin:'http://bridge',ok:true,recoveryProtocol:1},pendingReviewJobs:{}}),tabs,
  handler:(id,msg)=>{
   const tab=tabs.get(id);
   if(msg.type==='ashlar-tab-status')return {ok:true,ownershipProtocol:1,jobId:'A',provider:id===10?'chatgpt':'grok',
     runId:id===10?'run-chat':'run-grok',released:false,url:tab.url};
   if(msg.type==='ashlar-harvest')return {ok:false,code:'busy',retry:true,observation:{state:'generating_or_queued'}};
   return {ok:false,code:'busy',retry:true};
  },
  api:async(_path,body)=>{
   if(body.action==='recover'){
    recoveries++;
    const bindings=body.bindings.filter(x=>x.jobId==='A');
    const providers=bindings.map(x=>x.provider);
    return {ok:true,job:{jobId:'A',leaseId:'lease-'+recoveries,provider:providers[0],providers,resumeProviders:providers,
      bindings,prompt:'review',reasoning:{chatgpt:'standard',grok:'standard'},title:'A',owner:'o',repo:'r',pr:1}};
   }
   if(body.action==='ping')return {ok:true,accepted:true,active:true,bridge:{captureProtocol:1,localJsonRepairEnabled:false}};
   return {ok:true,active:true,accepted:true};
  }});
 const jobs=await b.context.workerJobs('http://bridge');
 await b.context.refreshTabInventory();for(let i=0;i<4;i++)await flush();
 const first=await b.context.recoverOwnedJob({origin:'http://bridge',token:'token',enabled:true},jobs);
 assert.deepEqual([...first.providers],['chatgpt']);assert.equal(first.states.chatgpt.tabId,10);

 tabs.set(11,{id:11,url:'https://grok.com/c/A',status:'complete'});
 await b.context.refreshTabInventory();for(let i=0;i<4;i++)await flush();
 const second=await b.context.recoverOwnedJob({origin:'http://bridge',token:'token',enabled:true},jobs);
 assert.equal(second,first,'late binding should merge into the existing local job object');
 assert.deepEqual([...second.providers].sort(),['chatgpt','grok']);
 assert.equal(second.states.grok.runId,'run-grok');assert.equal(second.states.grok.tabId,11);
 assert.equal(second.leaseId,'lease-2','all recovered legs must use the renewed server lease');
 assert.equal(recoveries,2);

 await b.context.progressJob(second,jobs);await flush();
 assert.ok(b.messages.some(m=>m.id===10&&m.type==='ashlar-harvest'));
 assert.ok(b.messages.some(m=>m.id===11&&m.type==='ashlar-harvest'));
 assert.equal(b.messages.some(m=>m.type==='ashlar-run'&&!m.resume),false);
 assert.equal(b.tabs.size,2,'recovery must not allocate a replacement tab');
});


test('maintenance lock blocks new admission and tab allocation until released',async()=>{
 const job={jobId:'A',origin:'http://bridge',leaseId:'lease-A',prompt:'review',providers:['chatgpt'],states:{chatgpt:{}}};
 let takes=0;
 const local=storage({origin:'http://bridge',token:'token',maxReviewTabs:1,
   extensionMaintenance:{active:true,id:'maint-1',mode:'update',phase:'locked'},pendingReviewJobs:{A:job}});
 const b=background({local,tabs:new Map(),api:async(_path,body)=>{
   if(body.action==='take'){takes++;return {ok:true,job:{jobId:'NEW',provider:'chatgpt',providers:['chatgpt'],leaseId:'L'}};}
   return {ok:true,active:true,accepted:true,bridge:{captureProtocol:1,localJsonRepairEnabled:false}};
 }});
 const jobs=await b.context.workerJobs('http://bridge');
 assert.equal(await b.context.admitJob({origin:'http://bridge',token:'token',enabled:true},jobs),null);
 await b.context.allocateProviderTab(job,'chatgpt',jobs);
 assert.equal(takes,0);
 assert.equal(b.tabs.size,0);
 assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase,'maintenance');
 await b.local.remove(['extensionMaintenance']);
 await b.context.allocateProviderTab(job,'chatgpt',jobs);
 assert.equal(b.tabs.size,1);
});
