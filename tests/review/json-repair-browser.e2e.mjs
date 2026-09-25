// Real Chromium/page runner + worker adapter + production HTTP modules.
// Provider responses are fixtures; no live model call or private capture is published.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {source,background,storage,flush} from './helpers.mjs';
import {appFixture,eventually} from './app-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;before(async()=>browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']}));after(async()=>browser?.close());
const raw=JSON.stringify({findings:[],investigated_safe:['a.ts: checked "condition"'],merge_recommendation:'COMMENT'});
const original=raw.replace(/\\"/g,'"');
async function pageFixture(t,{jobId='A',text=original,streaming=false,manual=false,lateId=false,legacy=false}={}) {
 const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',r=>r.abort());const page=await context.newPage();
 await page.setContent('<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">owned review prompt</div></section><section id="answer" data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"></div></div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div><button data-testid="send-button" aria-label="Send prompt" disabled>Send</button></form>');
 await page.clock.install();await page.evaluate(({jobId,text,streaming})=>{
  const saved=new Map([['ashlar:job',jobId],['ashlar:run','run-A'],[`ashlar:submission:${jobId}:run-A`,JSON.stringify({phase:'sent',expected:'owned review prompt',baseline:0,submittedUsers:1,messageId:'user-A'})]]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  document.querySelector('.markdown').textContent=text;window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
  if(streaming){const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop generating';document.querySelector('form').append(stop);}
 },{jobId,text,streaming});
 for(const file of ['composer.js','quota.js','model.js','json.js'])await page.addScriptTag({content:source('extension/'+file)});
 if(legacy)await page.addScriptTag({content:source('tests/review/fixtures/legacy-collector-v2.js')});
 await page.addScriptTag({content:source('extension/content-chatgpt.js')});
 await page.evaluate(jobId=>{window.message=(type,extra={})=>{let out;receiver({type,jobId,runId:'run-A',provider:'chatgpt',...extra},null,value=>out=value);return out || {ok:false,code:'unhandled'};};},jobId);
 if(lateId)await page.locator('[data-message-author-role="assistant"]').evaluate(el=>el.removeAttribute('data-message-id'));
 if(manual)await page.evaluate(()=>{
  window.observationWaiters=[];
  window.waitForPageChange=()=>new Promise(resolve=>observationWaiters.push(resolve));
  window.resumeObservation=()=>observationWaiters.shift()?.();
 });
 await page.evaluate(()=>message('ashlar-run',{resume:true,prompt:'owned review prompt'}));
 if(!manual)await page.clock.runFor(2400);return page;
}
test('page offers only a full, stable, bound completed source; invalid JSON is not terminal',async t=>{
 const page=await pageFixture(t);const out=await page.evaluate(()=>message('ashlar-repair-source'));
 assert.equal(out.ok,true);assert.equal(out.source.text,original);assert.equal(out.source.responseId,'response-A');assert.equal(out.source.truncated,false);
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).code,'busy');
});
test('page rejects repair from generation, changed response, or another run',async t=>{
 const page=await pageFixture(t,{streaming:true});await page.clock.fastForward(365*24*3600_000);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 await page.locator('[data-testid="stop-button"]').evaluate(el=>el.remove());await page.clock.runFor(2000);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source',{runId:'foreign'}))).code,'job_mismatch');
 await page.locator('.markdown').evaluate(el=>el.textContent='new fragment');
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
});
test('page source is not the truncated 128k diagnostic snapshot',async t=>{
 const long='not valid JSON '+ 'a'.repeat(140000);const page=await pageFixture(t,{text:long});
 const out=await page.evaluate(()=>message('ashlar-repair-source'));assert.equal(out.source.text.length,long.length);
 const observation=(await page.evaluate(()=>message('ashlar-harvest'))).observation;assert.equal(observation.truncated,true);assert.equal(observation.text.length,128000);
});
test('only a matching committed repair receipt resolves the page runner; no prompt click',async t=>{
 const page=await pageFixture(t);
 const bad=await page.evaluate(({original,raw})=>message('ashlar-repair-accepted',{committed:true,repairId:'fixture-repair',responseId:'foreign',text:original,raw}),{original,raw});assert.equal(bad.ok,false);
 const good=await page.evaluate(({original,raw})=>message('ashlar-repair-accepted',{committed:true,repairId:'fixture-repair',responseId:'response-A',text:original,raw}),{original,raw});assert.equal(good.ok,true);
 await page.clock.runFor(1600);assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
 assert.equal((await page.evaluate(()=>message('ashlar-can-close'))).canClose,true);
});
async function workerFixture(t,{enabled=true,text=original,pageOptions={}}={}) {
 const app=await appFixture({reviewLocal:false,localJsonRepairEnabled:enabled});t.after(()=>app.close());const mention=app.mention();await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===mention.jobId)?.status==='awaiting_chat','not ready');
 const send=async(path,body)=>{
  const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},...(body?{body:JSON.stringify(body)}:{})});const value=await res.json();
  if(!res.ok || !value.ok){const error=Object.assign(Error(value.error||'request failed'),{status:res.status,code:value.code});throw error;}
  // Preserve the 1.1.20.2 server contract in these repair-receipt regressions.
  // The new archive-before-format path is exercised with an unmodified server
  // and the same worker/page in capacity-browser.e2e.mjs.
  if(value.bridge)delete value.bridge.captureProtocol;
  return value;
 };
 const {job}=await send('/api/bridge',{action:'take',clientId:'worker-fixture'});job.origin=app.origin;job.states={chatgpt:{runId:'run-A',tabId:10,started:true}};
 const page=await pageFixture(t,{jobId:job.jobId,text,...pageOptions});
 const worker=background({local:storage({origin:app.origin,token:'fixture-token',pendingReviewJobs:{[job.jobId]:job}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/fixture',status:'complete'}]]),api:send});
 worker.context.crypto=webcrypto;worker.context.TextEncoder=TextEncoder;
 worker.chrome.tabs.sendMessage=(id,msg,cb)=>{worker.messages.push({id,...msg});page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),msg).then(out=>cb({...out,...(out.url!==undefined?{url:'https://chatgpt.com/c/fixture'}:{})}),error=>{worker.chrome.runtime.lastError={message:error.message};cb();worker.chrome.runtime.lastError=null;});};
 async function cycle(){await worker.tick();await flush();await page.clock.runFor(1000);}
 return {app,job,page,worker,cycle};
}
test('worker/HTTP: malformed original repaired once, committed as ChatGPT, safely closed after receipt',async t=>{
 const f=await workerFixture(t);await f.cycle();await eventually(()=>f.app.localRequests.length===1,'worker did not start repair');
 assert.equal(f.worker.closedTabs.length,0);assert.equal(f.app.reviews.length,0);
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:raw}}]}));
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'repair receipt did not close tab');
 assert.equal(f.app.localRequests.length,1);assert.equal(f.app.reviews.length,1);assert.deepEqual(f.worker.closedTabs,[10]);
 assert.equal(f.worker.calls.filter(x=>x.action==='repair-commit').length,1);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'&&!m.resume),false);
});
test('worker/HTTP: disabled fallback salvages the reply into a posted review, without repair or failure',async t=>{
 const f=await workerFixture(t,{enabled:false});
 await eventually(async()=>{await f.cycle();return f.app.reviews.length===1;},'disabled fallback did not salvage the reply into a review');
 assert.equal(f.app.localRequests.length,0,'salvage must not call the repair formatter');
 assert.equal(f.worker.calls.some(x=>x.action==='repair'||x.action==='failure'),false,'salvage is a complete, never a repair or failure');
 assert.equal(f.app.harbor.getHarbor().jobs.find(j=>j.id===f.job.jobId).status,'posted');
 assert.match(f.app.reviews[0].body,/not valid review JSON/i,'posted body carries the verbatim salvaged reply');
});
test('worker/HTTP: current valid JSON wins over a pending repair without a duplicate post',async t=>{
 const f=await workerFixture(t);await f.cycle();await eventually(()=>f.app.localRequests.length===1,'repair not started');
 await f.page.locator('.markdown').evaluate((el,text)=>el.textContent=text,raw);await f.page.clock.runFor(2400);await f.cycle();
 await eventually(()=>f.app.reviews.length===1,'valid native response not posted');
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:raw}}]}));await f.cycle();
 assert.equal(f.app.reviews.length,1);assert.equal(f.worker.calls.some(x=>x.action==='repair-commit'),false);
});

test('worker/HTTP: a new completed original supersedes an old pending formatter, without rerunning ChatGPT',async t=>{
 const f=await workerFixture(t);await f.cycle();await eventually(()=>f.app.localRequests.length===1,'initial repair not started');
 const next=JSON.stringify({findings:[],investigated_safe:['a.ts: checked "new condition"'],merge_recommendation:'COMMENT'}).replace(/\\"/g,'"');
 await f.page.locator('.markdown').evaluate((el,text)=>el.textContent=text,next);await f.page.clock.runFor(2400);
 await eventually(async()=>{await f.cycle();return f.app.localRequests.length===2;},'new completed source stayed blocked behind obsolete inference');
 assert.equal(JSON.parse(f.app.localRequests[1].messages[1].content).original,next);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'&&!m.resume),false);assert.equal(f.worker.closedTabs.length,0);
});

test('worker/HTTP: schema-invalid JSON is reformatted before any finding can be silently dropped',async t=>{
 const finding={severity:'P1',file:'a.ts',line:1,side:'RIGHT',title:'Missing check',failure_scenario:'A duplicate request writes twice',root_cause:'No guard',evidence:'a.ts:1: no guard',recommended_fix:'Check the key',recommended_test:'Assert one write'};
 const valid=JSON.stringify({findings:[finding],merge_recommendation:'REQUEST_CHANGES'});
 const invalid=JSON.stringify({findings:[{...finding,line:'1'}],merge_recommendation:'REQUEST_CHANGES'});
 const f=await workerFixture(t,{text:invalid});await f.cycle();await eventually(()=>f.app.localRequests.length===1,'schema error did not reach repair');
 assert.equal(f.app.reviews.length,0);assert.equal(f.worker.closedTabs.length,0);
 assert.equal(JSON.parse(f.app.localRequests[0].messages[1].content).original,invalid);
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:valid}}]}));
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'schema recovery failed to finish');
 assert.equal(f.app.reviews.length,1);assert.equal(f.app.reviews[0].comments.length,1);assert.equal(f.app.localRequests.length,1);
});

// Review regressions: explicitly control the observation boundary, not a timing guess.
async function observeAgain(page) {
 await page.evaluate(async()=>{resumeObservation();for(let i=0;i<12;i++)await Promise.resolve();});
}
for (const followup of [false,true])test(`repair receipt preserves validated context when suspended collector resumes (follow-up=${followup})`,async t=>{
 const page=await pageFixture(t,{manual:true});await observeAgain(page);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,true);
 const receipt={committed:true,repairId:'repair-A',responseId:'response-A',text:original,raw};
 const before=await page.evaluate(()=>reviewPageContext());
 assert.equal((await page.evaluate(receipt=>message('ashlar-repair-accepted',receipt),receipt)).accepted,true);
 if(followup)await page.evaluate(()=>{
  const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.dataset.messageId='follow-up';user.textContent='Personal follow-up';document.querySelector('main').append(user);
 });
 await observeAgain(page);
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,raw,'the acknowledged result must remain available');
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.finishedContext),before,'runner overwrote the receipt context');
 const cleanup=await page.evaluate(()=>message('ashlar-can-close'));
 assert.equal(cleanup.canClose,!followup);assert.equal(cleanup.reason,followup?'repurposed':'complete');
 // Replayed delivery acknowledgement must not replace the original close boundary.
 assert.equal((await page.evaluate(receipt=>message('ashlar-repair-accepted',receipt),receipt)).accepted,true);
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.finishedContext),before);
 assert.equal((await page.evaluate(()=>message('ashlar-can-close'))).canClose,!followup);
});
for (const when of ['second_observation','after_native_collection'])test(`repair source continues identity stability after native collection: ${when}`,async t=>{
 const invalid=JSON.stringify({findings:[],investigated_safe:'a.ts checked'});
 const page=await pageFixture(t,{manual:true,lateId:true,text:invalid});
 const setId=()=>page.locator('[data-message-author-role="assistant"]').evaluate(el=>el.dataset.messageId='response-A');
 if(when==='second_observation')await setId();
 await observeAgain(page);
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,invalid);
 if(when==='after_native_collection'){
  await setId();assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false,'one identified observation cannot authorize repair');
 }
 const out=await page.evaluate(()=>message('ashlar-repair-source'));
 assert.equal(out.ok,true,'repair source remained stuck after native collection stopped');assert.equal(out.source.text,invalid);
 // A new text or identity always needs fresh matching observations.
 await page.locator('.markdown').evaluate(el=>el.textContent+=' ');
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,true,'whitespace stripped by corpus does not change source');
 await page.locator('[data-message-author-role="assistant"]').evaluate(el=>el.dataset.messageId='response-new');
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).source.responseId,'response-new');
 await page.evaluate(()=>{const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.querySelector('form').append(stop);});
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 await page.locator('[data-testid="stop-button"]').evaluate(el=>el.remove());
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false,'positive evidence before Stop must not survive a generation gap');
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,true);
});
test('worker/HTTP: late assistant ID after schema-invalid collection starts exactly one formatting request',async t=>{
 const finding={severity:'P1',file:'a.ts',line:1,side:'RIGHT',title:'Missing check',failure_scenario:'Duplicate writes',root_cause:'No guard',evidence:'a.ts:1: missing guard',recommended_fix:'Add guard',recommended_test:'Check duplicate'};
 const valid=JSON.stringify({findings:[finding],merge_recommendation:'REQUEST_CHANGES'});
 const invalid=JSON.stringify({findings:[{...finding,line:'1'}],merge_recommendation:'REQUEST_CHANGES'});
 const f=await workerFixture(t,{text:invalid,pageOptions:{manual:true,lateId:true}});
 await f.page.locator('[data-message-author-role="assistant"]').evaluate(el=>el.dataset.messageId='response-A');await observeAgain(f.page);
 assert.equal((await f.page.evaluate(()=>message('ashlar-harvest'))).raw,invalid);
 await f.cycle();await f.cycle();
 assert.equal(f.worker.calls.some(c=>c.action==='complete'),true,'schema-invalid native reply did not reach server validation');
 await eventually(()=>f.app.localRequests.length===1,'422 never reached Local repair after late response ID');
 assert.equal(f.app.reviews.length,0);assert.equal(f.worker.closedTabs.length,0);
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:valid}}]}));
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'late-ID repair was not acknowledged');
 assert.equal(f.app.localRequests.length,1);assert.equal(f.app.reviews.length,1);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'&&!m.resume),false);
});
for(const change of ['original_user_removed','response_id_changed'])test(`accepted repair does not close changed context: ${change}`,async t=>{
 const page=await pageFixture(t,{manual:true});await observeAgain(page);
 const receipt={committed:true,repairId:'repair-A',responseId:'response-A',text:original,raw};
 assert.equal((await page.evaluate(receipt=>message('ashlar-repair-accepted',receipt),receipt)).accepted,true);
 await page.evaluate(change=>{
  if(change==='original_user_removed')document.querySelector('[data-message-author-role="user"]').remove();
  else document.querySelector('[data-message-author-role="assistant"]').dataset.messageId='different-response';
 },change);
 await observeAgain(page);
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
 const out=await page.evaluate(()=>message('ashlar-can-close'));assert.equal(out.canClose,false);assert.equal(out.reason,'repurposed');
});


// Second review: the close authorization itself and a genuinely executing old loop.
for(const change of ['unchanged','replaced_response','missing_response','changed_text'])test(`P1: final close guard checks acknowledged assistant after native collection (${change})`,async t=>{
 const invalid=JSON.stringify({findings:[],investigated_safe:'checked'});
 const page=await pageFixture(t,{text:invalid});
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.running),false);
 const receipt={committed:true,repairId:'repair-close',responseId:'response-A',text:invalid,raw};
 assert.equal((await page.evaluate(r=>message('ashlar-repair-accepted',r),receipt)).accepted,true);
 const context=await page.evaluate(()=>reviewPageContext());
 await page.evaluate(change=>{
  const node=document.querySelector('[data-message-author-role="assistant"]');
  if(change==='replaced_response'){const replacement=node.cloneNode(true);replacement.dataset.messageId='response-B';node.replaceWith(replacement);}
  if(change==='missing_response')node.remove();
  if(change==='changed_text')node.querySelector('.markdown').textContent='Another completed response';
 },change);
 assert.equal(await page.evaluate(()=>reviewPageContext()),context,'test must preserve all user-context fields');
 const out=await page.evaluate(()=>message('ashlar-can-close'));
 assert.equal(out.canClose,change==='unchanged');assert.equal(out.reason,change==='unchanged'?'complete':'repurposed');
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
});
async function upgradeLegacy(page) {
 // Mimic a previous listener-only v4 update around the still-executing v2 loop.
 await page.evaluate(()=>{window.legacyState=__ashlarRunnerState;});
 for(let pass=0;pass<2;pass++)for(const file of ['json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
}
test('P2: preserved active v2 collector hands off committed repair without waiting or resending',async t=>{
 const page=await pageFixture(t,{legacy:true,manual:true});await observeAgain(page);
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.running),true);
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.completedSource),undefined);
 await upgradeLegacy(page);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false,'fresh ID observation required');
 const out=await page.evaluate(()=>message('ashlar-repair-source'));assert.equal(out.ok,true);assert.equal(out.source.text,original);
 const receipt={committed:true,repairId:'upgrade-repair',responseId:'response-A',text:original,raw};
 assert.equal((await page.evaluate(r=>message('ashlar-repair-accepted',r),receipt)).accepted,true);
 // The old wait remains suspended: terminal availability must not depend on it.
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
 assert.equal((await page.evaluate(()=>message('ashlar-can-close'))).canClose,true);
 assert.equal((await page.evaluate(()=>message('ashlar-run',{prompt:'DO NOT SEND AGAIN'}))).raw,raw);
 // Drive the real old promise's then/finally after replacing the response. It must
 // not replace the receipt, original text, or receipt-time cleanup boundary.
 const unrelated=JSON.stringify({findings:[],keep:['different response']});
 await page.evaluate(text=>{const n=document.querySelector('[data-message-author-role="assistant"]');n.dataset.messageId='response-B';n.querySelector('.markdown').textContent=text;},unrelated);
 await observeAgain(page);await observeAgain(page);
 assert.equal(await page.evaluate(()=>legacyState.running),false,'legacy invocation must actually have settled in this regression');
 const final=await page.evaluate(()=>message('ashlar-harvest'));assert.equal(final.raw,raw);assert.equal(final.responseText,original);
 const close=await page.evaluate(()=>message('ashlar-can-close'));assert.equal(close.canClose,false);assert.equal(close.reason,'repurposed');
});
test('P2: current tracking collector probes cannot manufacture the second observation',async t=>{
 const page=await pageFixture(t,{manual:true});
 for(let i=0;i<4;i++)assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 await observeAgain(page);assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,true);
});
test('P2: upgraded legacy page still rejects streaming, missing binding and foreign runs',async t=>{
 const page=await pageFixture(t,{legacy:true,manual:true,streaming:true});await upgradeLegacy(page);
 for(let i=0;i<3;i++)assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 await page.locator('[data-testid="stop-button"]').evaluate(n=>n.remove());
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source',{runId:'other-run'}))).code,'job_mismatch');
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,true);
 await page.locator('[data-message-author-role="user"]').evaluate(n=>n.remove());
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
});
test('P2 worker/HTTP: active legacy upgrade repairs once, acknowledges and closes without another generate',async t=>{
 const f=await workerFixture(t,{pageOptions:{legacy:true,manual:true}});await observeAgain(f.page);await upgradeLegacy(f.page);
 await eventually(async()=>{await f.cycle();return f.app.localRequests.length===1;},'legacy collector never offered repair source');
 assert.equal(f.app.reviews.length,0);assert.equal(f.worker.closedTabs.length,0);
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:raw}}]}));
 await eventually(async()=>{await f.cycle();return f.worker.closedTabs.length===1;},'legacy collector blocked receipt/cleanup');
 assert.equal(f.app.reviews.length,1);assert.equal(f.app.localRequests.length,1);assert.deepEqual(f.worker.closedTabs,[10]);
 assert.equal(f.worker.messages.some(m=>m.type==='ashlar-run'&&!m.resume),false);
 assert.equal((await f.page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
});
test('P2: late legacy error/finally and duplicate receipts cannot overwrite the settled handoff',async t=>{
 const page=await pageFixture(t,{legacy:true,manual:true});await observeAgain(page);await upgradeLegacy(page);
 await page.evaluate(()=>message('ashlar-repair-source'));await page.evaluate(()=>message('ashlar-repair-source'));
 const receipt={committed:true,repairId:'legacy-error-repair',responseId:'response-A',text:original,raw};
 assert.equal((await page.evaluate(r=>message('ashlar-repair-accepted',r),receipt)).accepted,true);
 // Trigger the actual old catch/finally, not a manually mocked result assignment.
 await page.evaluate(()=>{const el=document.createElement('div');el.setAttribute('role','alert');el.textContent='usage limit reached';document.body.append(el);});
 await observeAgain(page);
 assert.equal(await page.evaluate(()=>legacyState.result.code),'quota');
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
 const corrupt={...receipt,raw:'{"findings":[],"keep":["wrong"]}'};
 assert.equal((await page.evaluate(r=>message('ashlar-repair-accepted',r),corrupt)).ok,false);
 assert.equal((await page.evaluate(r=>message('ashlar-repair-accepted',r),receipt)).accepted,true);
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).responseText,original);
 await upgradeLegacy(page);
 assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
});
test('P2: legacy probe evidence resets on Stop and is not mixed with older collector writes',async t=>{
 const page=await pageFixture(t,{legacy:true,manual:true});await upgradeLegacy(page);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 await page.evaluate(text=>{__ashlarRunnerState.completionTracking={text,responseId:'response-A',count:2};__ashlarRunnerState.completedSource={text,responseId:'response-A'};},original);
 await page.evaluate(()=>{const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.querySelector('form').append(stop);});
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 await page.locator('[data-testid="stop-button"]').evaluate(n=>n.remove());
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,false);
 assert.equal((await page.evaluate(()=>message('ashlar-repair-source'))).ok,true);
});
test('P1 worker/HTTP: response replacement after server receipt preserves the tab and acknowledged review',async t=>{
 const f=await workerFixture(t);await f.cycle();await eventually(()=>f.app.localRequests.length===1,'repair not started');
 let replacement;const send=f.worker.chrome.tabs.sendMessage;
 f.worker.chrome.tabs.sendMessage=(id,msg,cb)=>{
  if(msg.type!=='ashlar-can-close')return send(id,msg,cb);
  // Both cleanup lanes must observe the replacement *before* asking permission.
  replacement ||= f.page.locator('[data-message-author-role="assistant"]').evaluate(n=>{const next=n.cloneNode(true);next.dataset.messageId='regenerated-response';n.replaceWith(next);});
  void replacement.then(()=>send(id,msg,cb));
 };
 f.app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:raw}}]}));
 await eventually(async()=>{await f.cycle();return !f.worker.local.state.pendingReviewJobs[f.job.jobId];},'acknowledged changed tab did not retire safely');
 assert.ok(replacement);assert.equal(f.worker.closedTabs.length,0);assert.equal(f.app.localRequests.length,1);assert.equal(f.app.reviews.length,1);
 assert.equal((await f.page.evaluate(()=>message('ashlar-harvest'))).raw,raw);
});
test('P1: an unchanged repaired response still streaming cannot authorize cleanup',async t=>{
 const invalid=JSON.stringify({findings:[],investigated_safe:'checked'});const page=await pageFixture(t,{text:invalid});
 const receipt={committed:true,repairId:'streaming-repair',responseId:'response-A',text:invalid,raw};
 assert.equal((await page.evaluate(r=>message('ashlar-repair-accepted',r),receipt)).accepted,true);
 await page.evaluate(()=>{const status=document.createElement('div');status.dataset.streamingResponseStatus='';status.textContent='Generating';document.querySelector('#answer').prepend(status);});
 const out=await page.evaluate(()=>message('ashlar-can-close'));assert.equal(out.canClose,false);assert.equal(out.reason,'pending');
 await page.locator('[data-streaming-response-status]').evaluate(n=>n.remove());assert.equal((await page.evaluate(()=>message('ashlar-can-close'))).canClose,true);
});
