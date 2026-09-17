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
async function pageFixture(t,{jobId='A',text=original,streaming=false}={}) {
 const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',r=>r.abort());const page=await context.newPage();
 await page.setContent('<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">owned review prompt</div></section><section id="answer" data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"></div></div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div><button data-testid="send-button" aria-label="Send prompt" disabled>Send</button></form>');
 await page.clock.install();await page.evaluate(({jobId,text,streaming})=>{
  const saved=new Map([['ashlar:job',jobId],['ashlar:run','run-A'],[`ashlar:submission:${jobId}:run-A`,JSON.stringify({phase:'sent',expected:'owned review prompt',baseline:0,submittedUsers:1,messageId:'user-A'})]]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  document.querySelector('.markdown').textContent=text;window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
  if(streaming){const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop generating';document.querySelector('form').append(stop);}
 },{jobId,text,streaming});
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 await page.evaluate(jobId=>{window.message=(type,extra={})=>{let out;receiver({type,jobId,runId:'run-A',provider:'chatgpt',...extra},null,value=>out=value);return out || {ok:false,code:'unhandled'};};},jobId);
 await page.evaluate(()=>message('ashlar-run',{resume:true,prompt:'owned review prompt'}));await page.clock.runFor(2400);return page;
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
async function workerFixture(t,{enabled=true,text=original}={}) {
 const app=await appFixture({reviewLocal:false,localJsonRepairEnabled:enabled});t.after(()=>app.close());const mention=app.mention();await eventually(()=>app.harbor.getHarbor().jobs.find(j=>j.id===mention.jobId)?.status==='awaiting_chat','not ready');
 const send=async(path,body)=>{
  const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-ashlar-bridge-token':'fixture-token'},...(body?{body:JSON.stringify(body)}:{})});const value=await res.json();
  if(!res.ok || !value.ok){const error=Object.assign(Error(value.error||'request failed'),{status:res.status,code:value.code});throw error;}return value;
 };
 const {job}=await send('/api/bridge',{action:'take',clientId:'worker-fixture'});job.origin=app.origin;job.states={chatgpt:{runId:'run-A',tabId:10,started:true}};
 const page=await pageFixture(t,{jobId:job.jobId,text});
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
test('worker/HTTP: disabled fallback never requests a repair or emits empty/failure',async t=>{
 const f=await workerFixture(t,{enabled:false});await f.cycle();await f.cycle();
 assert.equal(f.app.localRequests.length,0);assert.equal(f.worker.calls.some(x=>x.action==='repair'||x.action==='failure'),false);assert.equal(f.worker.closedTabs.length,0);
 assert.equal(f.app.harbor.getHarbor().jobs.find(j=>j.id===f.job.jobId).status,'awaiting_chat');
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
