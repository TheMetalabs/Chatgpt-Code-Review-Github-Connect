import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {background,storage,flush,source} from './helpers.mjs';
import {appFixture,eventually} from './app-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;before(async()=>browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']}));after(async()=>browser?.close());
const valid=JSON.stringify({findings:[],investigated_safe:['a.ts checked "literal"'],merge_recommendation:'COMMENT'});
const invalid=valid.replace(/\\"/g,'"');
async function makePage(t,jobId,{text=invalid,runId='run-A',start=true}={}){
 const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',route=>route.abort());const page=await context.newPage();
 await page.setContent('<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">owned prompt</div></section><section id="answer" data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"></div></div><button aria-label="Copy response" data-testid="copy-turn-action-button">Copy</button></section></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div><button data-testid="send-button" aria-label="Send prompt" disabled>Send</button></form>');
 await page.clock.install();await page.evaluate(({jobId,runId,text})=>{
  const values=new Map([['ashlar:job',jobId],['ashlar:run',runId],[`ashlar:submission:${jobId}:${runId}`,JSON.stringify({phase:'sent',expected:'owned prompt',baseline:0,submittedUsers:1,messageId:'user-A'})]]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
  window.chrome={runtime:{onMessage:{addListener:fn=>window.receiver=fn,removeListener(){}}}};document.querySelector('.markdown').textContent=text;
  window.clicks=0;document.querySelector('form').onsubmit=ev=>{ev.preventDefault();window.clicks++;};
 },{jobId,runId,text});
 for(const name of ['composer','quota','model','json','content-chatgpt'])await page.addScriptTag({content:source(`extension/${name}.js`)});
 await page.evaluate(({jobId,runId})=>{window.message=(type,extra={})=>new Promise(resolve=>{const wait=receiver({type,jobId,runId,provider:'chatgpt',...extra},null,resolve);if(wait!==true)queueMicrotask(()=>resolve({ok:false,code:'unhandled'}));});},{jobId,runId});
 if(start)await page.evaluate(()=>message('ashlar-run',{resume:true,prompt:'owned prompt'}));await page.clock.runFor(2400);
 return page;
}
async function fixture(t,{fallback=true,text=invalid}={}){
 const app=await appFixture({reviewLocal:false,localJsonRepairEnabled:fallback});t.after(()=>app.close());
 const started=app.mention('first');await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===started.jobId)?.status==='awaiting_chat','not ready');
 const api=async(path,body)=>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},...(body?{body:JSON.stringify(body)}:{})});const out=await res.json();if(!res.ok||!out.ok)throw Object.assign(Error(out.error),{status:res.status,code:out.code});return out;};
 const {job}=await api('/api/bridge',{action:'take',clientId:'fixture-client'});job.origin=app.origin;job.states={chatgpt:{tabId:10,runId:'run-A',started:true}};
 const page=await makePage(t,job.jobId,{text});
 const worker=background({local:storage({origin:app.origin,token:'fixture-token',maxReviewTabs:1,pendingReviewJobs:{[job.jobId]:job}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),api});
 worker.context.crypto=webcrypto;worker.context.TextEncoder=TextEncoder;
 worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  worker.messages.push({id,...msg});
  if(id!==10){cb({ok:false,code:'busy',jobId:msg.jobId,runId:msg.runId,provider:msg.provider});return;}
  page.evaluate(msg=>new Promise(resolve=>{const async=receiver(msg,null,resolve);if(async!==true)queueMicrotask(()=>resolve({ok:false,code:'unhandled'}));}),msg).then(out=>cb({...out,...(out.url!==undefined?{url:'https://chatgpt.com/c/A'}:{}),...(out.conversation!==undefined?{conversation:'https://chatgpt.com/c/A'}:{})}),error=>{worker.chrome.runtime.lastError={message:error.message};cb();worker.chrome.runtime.lastError=null;});
 };
 const cycle=async()=>{await worker.tick();await flush();await page.clock.runFor(1000);};
 return {app,job,page,worker,cycle,api};
}

test('completed malformed source frees the only tab slot before Local finishes, then repairs without a tab',async t=>{
 const f=await fixture(t);const next=f.app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'next-pr',event:'issue_comment',payload:{action:'created',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},issue:{number:2,pull_request:{},title:'second PR'},comment:{id:43,body:'@ashlar-bot review'}}});await eventually(()=>f.app.harbor.getHarbor().jobs.find(j=>j.id===next.jobId)?.status==='awaiting_chat','next not ready');
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.includes(10);},'completed source held a tab while Local is pending');
 await eventually(async()=>{await f.cycle();return f.app.localRequests.length===1;},'archived source did not start Local repair after releasing the tab');
 assert.equal(f.app.reviews.length,0);assert.equal(f.app.localRequests.length,1);assert.equal(await f.page.evaluate(()=>clicks),0);
 assert.equal(f.app.history.getJob(f.job.jobId,true).captures[0].text,invalid);
 assert.equal(f.worker.local.state.pendingReviewJobs[f.job.jobId].prompt,undefined,'browserless backlog must not retain full review prompts');
 assert.equal(f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt.sourceCapture.text,invalid,'unresolved archived repair must retain an exact local fallback until final acknowledgement');
 assert.equal(f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt.delivered,undefined,'archive must not claim final result');
 await eventually(async()=>{await f.cycle();return Boolean(f.worker.local.state.pendingReviewJobs[next.jobId]);},'new job not admitted after cleanup');
 assert.equal(f.worker.tabs.size,1,'hard managed-tab limit must remain in force');
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:valid}}]}));
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'archived source could not finish formatting');
 const completedState=f.worker.local.state.pendingReviewJobs[f.job.jobId]?.states?.chatgpt;
 if(completedState)assert.equal(completedState.sourceCapture?.text,undefined,'final result acknowledgement may compact the local fallback');
 assert.equal(f.app.localRequests.length,1);assert.equal(f.worker.messages.some(m=>m.id===10&&m.type==='ashlar-run'),false);
});

test('fallback OFF salvages the completed original into a posted review and releases capacity',async t=>{
 const f=await fixture(t,{fallback:false});
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'disabled formatter did not salvage the captured original into a review');
 assert.equal(f.app.localRequests.length,0,'salvage must not call the repair formatter');
 assert.ok(f.worker.closedTabs.includes(10),'completed tab must be released after salvage');
 assert.equal(f.app.harbor.getHarbor().jobs.find(j=>j.id===f.job.jobId).status,'posted');
 assert.match(f.app.reviews[0].body,/not parseable JSON/i,'posted body carries the verbatim salvaged reply');
 assert.equal(f.worker.tabs.size,0);assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false);
});

test('full source archive failure retains tab and blocks admission until recovery, not by elapsed time',async t=>{
 const f=await fixture(t);const put=f.app.history.putCapture?.bind(f.app.history);f.app.history.putCapture=()=>{throw Error('disk failure');};
 await f.cycle();await f.cycle();await f.page.clock.fastForward(24*3600_000);await f.cycle();
 assert.equal(f.worker.closedTabs.length,0);assert.equal(f.app.localRequests.length,0);
 assert.equal(f.worker.local.state.bridgeWorkerStatus.admissionPhase,'tab_capacity');
 assert.equal(typeof put,'function');f.app.history.putCapture=put;
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'storage recovery did not release source');
});

test('a full pool of genuinely generating tabs stays pending without capture or forced eviction',async t=>{
 const f=await fixture(t);await f.page.evaluate(()=>{const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.querySelector('form').append(stop);});await f.page.clock.runFor(1000);
 await f.cycle();await f.page.clock.fastForward(365*24*3600_000);await f.cycle();
 assert.equal(f.worker.closedTabs.length,0);assert.equal(f.worker.calls.some(c=>c.action==='capture'),false);assert.equal(f.app.localRequests.length,0);
});

test('native result cleanup can rehydrate an ACKed page without restarting its collector',async t=>{
 const f=await fixture(t,{text:valid});let reset=false;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(!reset&&msg.type==='ashlar-can-close'){reset=true;void f.page.evaluate(()=>{__ashlarRunnerState.result=null;__ashlarRunnerState.running=false;__ashlarRunnerState.finishedContext=undefined;__ashlarRunnerState.nativeCompletion=undefined;}).then(()=>send(id,msg,cb));return;}
  return send(id,msg,cb);
 };
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'ACKed reloaded page never regained cleanup proof');
 assert.equal(f.app.reviews.length,1);assert.equal(f.worker.calls.filter(c=>c.action==='complete').length,1);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false);
});

test('captured-source cleanup restores a freshly reloaded page from the saved receipt, without inference replay',async t=>{
 const f=await fixture(t,{fallback:false});let reloaded;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-can-close' && !reloaded) {
   reloaded=makePage(t,f.job.jobId,{start:false});
  }
  if(!reloaded)return send(id,msg,cb);
  void reloaded.then(page=>page.evaluate(msg=>new Promise(resolve=>{const pending=receiver(msg,null,resolve);if(pending!==true)queueMicrotask(()=>resolve({ok:false,code:'unhandled'}));}),msg))
   .then(out=>cb({...out,...(out.url!==undefined?{url:'https://chatgpt.com/c/A'}:{})}));
 };
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'capture ACK lost its cleanup state across page reload');
 assert.ok(reloaded);assert.equal(f.app.localRequests.length,0);assert.equal(f.app.reviews.length,1,'salvage posts the captured original after the reload-restored cleanup');
 assert.equal(f.worker.calls.filter(c=>c.action==='capture').length,1);assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false);
});

for(const change of ['followup','draft'])test(`source receipt releases managed ownership but preserves a user's ${change}`,async t=>{
 const f=await fixture(t,{fallback:false});let changed=false;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-capture-accepted' && !changed) {
   changed=true;void f.page.evaluate(change=>{
    if(change==='draft')document.querySelector('#prompt-textarea').textContent='personal unsent question';
    else {const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.dataset.messageId='personal';user.textContent='personal followup';document.querySelector('main').append(user);}
   },change).then(()=>send(id,msg,cb));return;
  }
  send(id,msg,cb);
 };
 await eventually(async()=>{await f.cycle();return f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt.cleanupDone;},'user-owned tab did not release managed capacity');
 assert.equal(f.worker.closedTabs.length,0);assert.equal(f.worker.tabs.size,1);
 const status=await f.page.evaluate(()=>message('ashlar-tab-status'));assert.equal(status.released,true);
 await f.cycle();assert.equal(f.worker.local.state.bridgeWorkerStatus.capacity.used,0);
 assert.equal(f.app.history.getJob(f.job.jobId,true).captures[0].text,invalid);assert.equal(f.app.localRequests.length,0);
});



// The original is durably archived (secured): the provider changing its answer afterwards is not the
// user's activity, so the tab closes (#82) while the archived original, not the page, is salvaged.
test('source change after durable archive keeps the archived original, closes the secured tab, and salvages that original',async t=>{
 const f=await fixture(t,{fallback:false});let changed=false;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-capture-accepted' && !changed) {
   changed=true;void f.page.evaluate(()=>{document.querySelector('.markdown').textContent='personal replacement response';}).then(()=>send(id,msg,cb));return;
  }
  send(id,msg,cb);
 };
 await eventually(async()=>{await f.cycle();return f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt.cleanupDone;},'changed source did not release the managed slot');
 const state=f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt;
 assert.equal(state.sourceCapture?.archiveDurable,true);assert.notEqual(state.sourceCapture?.cleanupProofConfirmed,true);assert.ok(state.sourceCapture?.id);
 assert.equal(state.sourceCapture.text,invalid,'unresolved repair must retain the exact local archived-source fallback');
 assert.deepEqual(f.worker.closedTabs,[10],'a changed answer is not a user takeover: the secured tab closes');
 await f.cycle();assert.equal(f.worker.local.state.bridgeWorkerStatus.capacity.used,0);
 assert.equal(f.worker.calls.filter(c=>c.action==='capture').length,1,'replacement DOM must not be archived as the original run');
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'archived original was not salvaged into a review with repair off');
 assert.equal(f.app.localRequests.length,0,'repair off: salvage must not call the formatter');
 assert.match(f.app.reviews[0].body,/not parseable JSON/i,'salvaged body carries the archived original, not the replacement DOM');
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false,'source change must not trigger another model generation');
 assert.equal(f.worker.calls.filter(c=>c.action==='capture').length,1);
});



test('durable archive repairs after original tab disappears before cleanup proof',async t=>{
 const f=await fixture(t,{fallback:true});let removed=false;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-capture-accepted') {
   if(!removed) {
    removed=true;
    void f.worker.closeTab(id).then(()=>{
      f.worker.chrome.runtime.lastError={message:`No tab with id: ${id}.`};cb();f.worker.chrome.runtime.lastError=null;
    });
    return;
   }
   f.worker.chrome.runtime.lastError={message:`No tab with id: ${id}.`};cb();f.worker.chrome.runtime.lastError=null;
   return;
  }
  send(id,msg,cb);
 };
 await eventually(async()=>{await f.cycle();return f.app.localRequests.length===1;},'durable archive was stranded after tab loss');
 const state=f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt;
 assert.equal(state.sourceCapture?.archiveDurable,true);
 assert.notEqual(state.sourceCapture?.cleanupProofConfirmed,true,'closed tab cannot grant cleanup proof');
 assert.equal(state.cleanupDone,true,'absent original tab should release managed ownership after archive durability');
 assert.equal(f.worker.tabs.size,0);assert.equal(f.worker.closedTabs.includes(10),false,'user/external tab loss is not our close action');
 assert.equal(f.worker.calls.some(c=>c.action==='capture-read'),true,'repair must consume the immutable server archive');
 assert.equal(JSON.parse(f.app.localRequests[0].messages[1].content).original,invalid);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false,'tab loss must not trigger another model generation');
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:valid}}]}));
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'tabless archived repair did not finalize');
 assert.equal(f.app.localRequests.length,1);
});

test('durable archive survives navigation before cleanup proof without closing replacement page',async t=>{
 const f=await fixture(t,{fallback:true});let changed=false;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-capture-accepted') {
   if(!changed) {
    changed=true;
    const tab=f.worker.tabs.get(id);tab.url='https://chatgpt.com/c/personal-replacement';
   }
   cb({ok:false,code:'capture_source_changed',jobId:msg.jobId,provider:msg.provider,runId:msg.runId});
   return;
  }
  send(id,msg,cb);
 };
 await eventually(async()=>{await f.cycle();return f.app.localRequests.length===1;},'navigated durable archive did not reach formatter');
 const state=f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt;
 assert.equal(state.sourceCapture?.archiveDurable,true);
 assert.notEqual(state.sourceCapture?.cleanupProofConfirmed,true);
 assert.equal(state.cleanupDone,true);assert.equal(f.worker.closedTabs.length,0);
 assert.equal(f.worker.tabs.get(10).url,'https://chatgpt.com/c/personal-replacement');
 assert.equal(f.worker.calls.filter(c=>c.action==='capture').length,1);
 assert.equal(f.worker.calls.some(c=>c.action==='capture-read'),true);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false);
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:valid}}]}));
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'navigated archived repair did not finalize');
 assert.equal(f.worker.closedTabs.length,0,'replacement user page must stay open');
});



test('capture-read failure after tab loss falls back to the durable local source copy',async t=>{
 const f=await fixture(t,{fallback:true});
 const originalApi=f.worker.context.api;let readFailures=0,removed=false;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.context.api=async(path,body,...args)=>{
  if(body?.action==='capture-read'){readFailures++;throw Error('archive read temporarily unavailable');}
  return originalApi(path,body,...args);
 };
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-capture-accepted') {
   if(!removed) {
    removed=true;
    void f.worker.closeTab(id).then(()=>{
      f.worker.chrome.runtime.lastError={message:`No tab with id: ${id}.`};cb();f.worker.chrome.runtime.lastError=null;
    });
    return;
   }
   f.worker.chrome.runtime.lastError={message:`No tab with id: ${id}.`};cb();f.worker.chrome.runtime.lastError=null;
   return;
  }
  send(id,msg,cb);
 };
 await eventually(async()=>{await f.cycle();return f.app.localRequests.length===1;},'local fallback did not recover a failed capture-read');
 const pending=f.worker.local.state.pendingReviewJobs[f.job.jobId].states.chatgpt;
 assert.ok(readFailures>0,'repair should prefer the immutable server archive first');
 assert.equal(pending.sourceCapture?.archiveDurable,true);
 assert.equal(pending.sourceCapture?.text,invalid,'local fallback must remain until final repair acknowledgement');
 assert.equal(JSON.parse(f.app.localRequests[0].messages[1].content).original,invalid);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false,'fallback must not regenerate the provider response');
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:valid}}]}));
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'local archived-source fallback did not finalize');
 const finalState=f.worker.local.state.pendingReviewJobs[f.job.jobId]?.states?.chatgpt;
 if(finalState) assert.equal(finalState.sourceCapture?.text,undefined,'final ACK + cleanup may compact the local fallback');
 assert.equal(f.app.localRequests.length,1);
});

test('failed local source-receipt persistence cannot authorize tab cleanup',async t=>{
 const f=await fixture(t,{fallback:false}), originalSet=f.worker.local.set;
 let rejected=0;
 f.worker.local.set=async values=>{
  if(Object.values(values.pendingReviewJobs || {}).some(j=>j.states.chatgpt?.sourceCapture?.id && !j.states.chatgpt.sourceCapture.confirmed)) {rejected++;throw Error('local quota');}
  return originalSet(values);
 };
 await f.cycle();await f.cycle();await flush();assert.ok(rejected>0);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-capture-accepted'),false);assert.equal(f.worker.closedTabs.length,0);
 f.worker.local.set=originalSet;
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'local storage recovery did not resume same receipt');
 assert.equal(f.app.history.getJob(f.job.jobId,true).captures.length,1);assert.equal(f.app.localRequests.length,0);
});

test('lost server source ACK retries the same archive, then salvages it without a second model generation',async t=>{
 const f=await fixture(t,{fallback:false}), api=f.worker.context.api;let dropped=false;
 f.worker.context.api=async(path,body,...args)=>{
  const out=await api(path,body,...args);
  if(body?.action==='capture' && !dropped){dropped=true;throw Error('response lost after archive write');}
  return out;
 };
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'idempotent source ACK retry did not finish');
 assert.ok(dropped);assert.equal(f.app.history.getJob(f.job.jobId,true).captures.length,1);
 assert.equal(f.app.localRequests.length,0);assert.equal(f.app.reviews.length,1,'archive is salvaged into a review with repair off');
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false);
});

test('salvage posts the archived original once; a worker restart never re-posts it',async t=>{
 const f=await fixture(t,{fallback:false});
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'first worker did not salvage the archived source');
 assert.equal(f.app.localRequests.length,0);assert.ok(f.worker.closedTabs.includes(10));
 // A restarted worker inheriting the same storage must not salvage or post a second time.
 const local=storage(structuredClone(f.worker.local.state));
 const resumed=background({local,tabs:new Map(),api:f.api});resumed.context.crypto=webcrypto;resumed.context.TextEncoder=TextEncoder;
 await resumed.tick();await flush();await resumed.tick();await flush();
 assert.equal(f.app.reviews.length,1,'restart must not duplicate the salvaged review');
 assert.equal(resumed.messages.some(m=>m.type==='ashlar-run'),false);
});

test('orphaned registry is recovered at full capacity only for the same client/run, without new tabs',async t=>{
 const f=await fixture(t,{fallback:false});
 await f.api('/api/bridge',{action:'progress',jobId:f.job.jobId,leaseId:f.job.leaseId,progress:{chatgpt:{runId:'run-A',events:[{source:'page',sequence:1,stage:'response_completed_json_invalid',at:Date.now()}]}}});
 f.worker.local.state.pendingReviewJobs={};f.worker.local.state['ashlar:client']='fixture-client';
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'existing bound run could not recover while no new tab capacity existed');
 assert.equal(f.worker.calls.some(c=>c.action==='recover'),true);assert.equal(f.worker.tabs.size,0);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false);assert.equal(f.app.localRequests.length,0);
 assert.equal(f.app.history.getJob(f.job.jobId,true).captures[0].text,invalid);
});

test('native saved response recovers cleanup in a different document using only its original journal and DOM',async t=>{
 const f=await fixture(t,{text:valid});let replacement;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type==='ashlar-can-close' && !replacement)replacement=makePage(t,f.job.jobId,{text:valid,start:false});
  if(!replacement)return send(id,msg,cb);
  void replacement.then(page=>page.evaluate(msg=>new Promise(resolve=>{const pending=receiver(msg,null,resolve);if(pending!==true)queueMicrotask(()=>resolve({ok:false,code:'unhandled'}));}),msg))
   .then(out=>cb({...out,...(out.url!==undefined?{url:'https://chatgpt.com/c/A'}:{})}));
 };
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'new document could not restore native cleanup proof');
 assert.ok(replacement);assert.equal(f.app.reviews.length,1);assert.equal(f.worker.calls.filter(c=>c.action==='complete').length,1);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'),false);
});

test('popup displays capacity breakdown and persists only an explicit valid tab limit',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.setContent(source('extension/popup.html').replace('<script src="popup.js"></script>',''));
 await page.evaluate(()=>{
  window.saved={origin:'https://fixture.test',token:'private',enabled:true,maxReviewTabs:4,bridgeWorkerStatus:{origin:'https://fixture.test',checkedAt:1,phase:'reviewing',admissionPhase:'tab_capacity',activeJobs:4,pendingCleanup:2,sourceCaptured:3,
   capacity:{limit:4,used:4,managedTabs:4,providerTabs:7,reserved:0,restorationReserved:0,unknownReserved:0,unverifiedTabs:0,orphanTabs:0,blockers:[{jobId:'A',provider:'chatgpt',reason:'source_archive_pending'}]}}};
  window.writes=0;window.chrome={runtime:{getManifest:()=>({version:'1.1.21'}),sendMessage:async()=>({ok:true})},permissions:{request:async()=>true},storage:{local:{get:async()=>saved,set:async value=>{writes++;Object.assign(saved,value);}},onChanged:{addListener(){}}}};
 });
 await page.addScriptTag({content:source('extension/popup.js')});await page.evaluate(()=>refreshDiagnostics());
 assert.match(await page.locator('#worker').textContent(),/Managed capacity: 4\/4/);assert.match(await page.locator('#worker').textContent(),/Provider-domain tabs: 7/);
 assert.match(await page.locator('#worker').textContent(),/source_archive_pending/);assert.equal(await page.evaluate(()=>writes),0);
 await page.locator('#maxReviewTabs').fill('0');await page.locator('#save').click();assert.equal(await page.evaluate(()=>writes),0);
 await page.locator('#maxReviewTabs').fill('6');await page.locator('#save').click();assert.equal(await page.evaluate(()=>saved.maxReviewTabs),6);
 assert.equal(await page.evaluate(()=>saved.enabled),true);
});


test('popup updater uses configured port and maintenance lock through reload',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent(source('extension/popup.html').replace('<script src="popup.js"></script>',''));
 await page.evaluate(()=>{
  window.saved={origin:'https://fixture.test',token:'private',enabled:true,maxReviewTabs:4,extensionUpdaterPort:19090,
    bridgeWorkerStatus:{origin:'https://fixture.test',checkedAt:Date.now(),phase:'idle',admissionPhase:'idle',activeJobs:0,pendingCleanup:0,sourceCaptured:0,
      capacity:{limit:4,used:0,managedTabs:0,providerTabs:0,reserved:0,restorationReserved:0,unknownReserved:0,unverifiedTabs:0,orphanTabs:0,blockers:[]}}};
  window.events=[];window.reloads=0;
  window.fetch=async url=>{
    events.push('fetch:'+url);
    const pathname=new URL(url).pathname;
    if(pathname==='/status')return {ok:true,status:200,json:async()=>({ok:true,installedVersion:'1.1.21',availableVersion:'1.1.22',availableCommit:'new-commit',updateAvailable:true,backupAvailable:false})};
    if(pathname==='/update')return {ok:true,status:200,json:async()=>({ok:true,updated:true,fromVersion:'1.1.21',toVersion:'1.1.22',commit:'new-commit'})};
    throw Error('unexpected '+pathname);
  };
  window.chrome={runtime:{getManifest:()=>({version:'1.1.21'}),reload:()=>{events.push('reload');reloads++;},
    sendMessage:async msg=>{events.push('msg:'+msg.type);if(msg.type==='ashlar-maintenance-acquire')return {ok:true,safe:true,capacity:{used:0,limit:4},pendingCleanup:0};if(msg.type==='ashlar-maintenance-commit')return {ok:true,safe:true,committed:true};return {ok:true};}},
    permissions:{request:async()=>true},
    storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:Object.keys(saved)).filter(k=>k in saved).map(k=>[k,saved[k]])),set:async value=>Object.assign(saved,value)},onChanged:{addListener(){}}}};
 });
 await page.addScriptTag({content:source('extension/popup.js')});await page.waitForTimeout(30);
 assert.match(await page.locator('#updateStatus').textContent(),/19090/);
 await page.locator('#applyUpdate').click();await page.waitForTimeout(180);
 const events=await page.evaluate(()=>window.events);
 assert.ok(events.includes('fetch:http://127.0.0.1:19090/update'));
 assert.ok(events.indexOf('msg:ashlar-maintenance-acquire')<events.indexOf('fetch:http://127.0.0.1:19090/update'));
 assert.ok(events.indexOf('msg:ashlar-maintenance-commit')<events.indexOf('reload'));
 assert.equal(await page.evaluate(()=>reloads),1);
});


test('fresh popup recovers an abandoned interrupted maintenance operation without clearing storage manually',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent(source('extension/popup.html').replace('<script src="popup.js"></script>',''));
 await page.evaluate(()=>{
  window.saved={origin:'https://fixture.test',token:'private',enabled:true,maxReviewTabs:4,extensionUpdaterPort:19090,
   extensionMaintenance:{active:true,id:'lost-maint',mode:'update',phase:'locked'},
   bridgeWorkerStatus:{origin:'https://fixture.test',checkedAt:Date.now(),phase:'idle',admissionPhase:'maintenance',activeJobs:0,pendingCleanup:0,sourceCaptured:0,
    capacity:{limit:4,used:0,managedTabs:0,providerTabs:0,reserved:0,restorationReserved:0,unknownReserved:0,unverifiedTabs:0,orphanTabs:0,blockers:[]}}};
  window.events=[];window.reloads=0;
  window.fetch=async url=>{
   events.push('fetch:'+url);
   const parsed=new URL(url);
   if(parsed.pathname==='/operation')return {ok:true,status:200,json:async()=>({ok:true,operation:{id:'lost-maint',mode:'update',phase:'interrupted',ok:false,error:'helper restarted'}})};
   if(parsed.pathname==='/status')return {ok:true,status:200,json:async()=>({ok:true,installedVersion:'1.1.21',availableVersion:'1.1.22',availableCommit:'new-commit',updateAvailable:true,backupAvailable:false})};
   throw Error('unexpected '+parsed.pathname);
  };
  window.chrome={runtime:{id:'abcdefghijklmnopabcdefghijklmnop',getManifest:()=>({version:'1.1.21'}),reload:()=>{reloads++;},
   sendMessage:async msg=>{events.push('msg:'+msg.type);if(msg.type==='ashlar-maintenance-release'){delete saved.extensionMaintenance;return {ok:true};}return {ok:true};}},
   permissions:{request:async()=>true},
   storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:Object.keys(saved)).filter(k=>k in saved).map(k=>[k,saved[k]])),set:async value=>Object.assign(saved,value)},onChanged:{addListener(){}}}};
 });
 await page.addScriptTag({content:source('extension/popup.js')});await page.waitForTimeout(80);
 const state=await page.evaluate(()=>({events,saved,reloads}));
 assert.ok(state.events.some(e=>e.includes('/operation?id=lost-maint')));
 assert.ok(state.events.includes('msg:ashlar-maintenance-release'));
 assert.equal(state.saved.extensionMaintenance,undefined);
 assert.equal(state.reloads,0);
});
