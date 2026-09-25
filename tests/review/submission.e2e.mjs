import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {background,storage} from './helpers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const src=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
async function fixture(t,{disabled=false,hidden=false}={}) {
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent(`<main><div id="turns"></div><form><textarea id="prompt-textarea" style="width:300px;height:100px">owned review prompt</textarea>${hidden?'<button hidden data-testid="send-button">hidden</button>':''}<button id="composer-submit-button" aria-label="Send prompt" ${disabled?'disabled':''}>send</button></form></main>`);
 await page.clock.install();
 // DOM fixture only. Browser navigation is policy-blocked locally; no policy changes.
 await page.evaluate(()=>{const saved=new Map();Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});});
 await page.evaluate(()=>{window.clicks=0;document.querySelector('form').addEventListener('submit',e=>e.preventDefault());document.querySelector('#composer-submit-button').addEventListener('click',()=>window.clicks++);window.chrome={runtime:{onMessage:{addListener(){}}}};window.__ashlarRunnerState={jobId:'A',runId:'run-A',provider:'chatgpt',running:true};});
 await page.addScriptTag({content:src('extension/composer.js')});return page;
}
async function start(page) {await page.evaluate(()=>{window.result={pending:true};clickSend(()=>document.querySelector('#composer-submit-button'),()=>document.querySelector('textarea'),'owned review prompt').then(()=>window.result={submitted:true},e=>window.result={error:e.message});});}
async function acknowledge(page,text='owned review prompt') {await page.evaluate(text=>{const el=document.createElement('div');el.dataset.messageAuthorRole='user';el.textContent=text;document.querySelector('#turns').append(el);document.querySelector('textarea').value='';},text);}

test('submission: disabled upload/send controls may wait for days without falling through',async t=>{
 const page=await fixture(t,{disabled:true});await start(page);await page.clock.fastForward(3*24*3600_000);
 assert.equal((await page.evaluate(()=>result)).pending,true,'disabled send must not become response-waiting');assert.equal(await page.evaluate(()=>clicks),0);
 await page.evaluate(()=>document.querySelector('#composer-submit-button').disabled=false);await page.clock.runFor(500);
 assert.equal(await page.evaluate(()=>clicks),1);assert.equal((await page.evaluate(()=>result)).pending,true);
 await acknowledge(page);await page.clock.runFor(500);assert.equal((await page.evaluate(()=>result)).submitted,true);
});

test('submission: a no-op click is not confirmation, and a delayed ACK within the window never resends',async t=>{
 const page=await fixture(t);await start(page);await page.clock.runFor(500);
 assert.equal((await page.evaluate(()=>result)).pending,true,'click is only an attempt, not provider receipt');
 await page.clock.runFor(45_000);assert.equal(await page.evaluate(()=>clicks),1);
 await acknowledge(page);await page.clock.runFor(500);assert.equal((await page.evaluate(()=>result)).submitted,true);assert.equal(await page.evaluate(()=>clicks),1);
});

// The live 1.1.29 run sat in send_unconfirmed for 10+ minutes after a click ChatGPT dropped.
test('submission: a click whose turn never renders ends as send_unconfirmed after 60 s and is never resent',async t=>{
 const page=await fixture(t);await start(page);await page.clock.runFor(59_000);
 assert.equal((await page.evaluate(()=>result)).pending,true);
 await page.clock.runFor(2_000);
 assert.match((await page.evaluate(()=>result)).error||'',/no sent turn appeared within 60 seconds/);
 assert.equal(await page.evaluate(()=>clicks),1);
});

test('submission: a cleared composer or a different user turn is not the owned request',async t=>{
 const page=await fixture(t);await start(page);await acknowledge(page,'personal message');await page.clock.runFor(1000);
 assert.equal((await page.evaluate(()=>result)).pending,true);assert.equal(await page.evaluate(()=>clicks),1);
});

test('submission: a rendered but disabled Send stops the search; a looser selector never finds another button',async t=>{
 const page=await fixture(t,{disabled:true});
 await page.evaluate(()=>{document.querySelector('form').insertAdjacentHTML('beforeend','<button type="submit" id="other" style="width:40px;height:20px">x</button>');window.composer=()=>document.querySelector('textarea');});
 assert.equal(await page.evaluate(()=>findEligibleSendButton(['#composer-submit-button','button[type="submit"]'])?.id??null),null);
 await page.evaluate(()=>{document.querySelector('#composer-submit-button').disabled=false;});
 assert.equal(await page.evaluate(()=>findEligibleSendButton(['#composer-submit-button','button[type="submit"]']).id),'composer-submit-button');
});

test('submission: hidden matching controls are skipped in favor of the visible owned form button',async t=>{
 const page=await fixture(t,{hidden:true});
 await page.evaluate(()=>{window.composer=()=>document.querySelector('textarea');});
 assert.equal(await page.evaluate(()=>findEligibleSendButton(['[data-testid="send-button"]','#composer-submit-button']).id),'composer-submit-button');
});

test('submission: a prepared journal resumes after reload, an attempted journal never clicks again',async t=>{
 const page=await fixture(t,{disabled:true});await start(page);await page.clock.runFor(500);
 const stored=await page.evaluate(()=>sessionStorage.getItem(submissionKey()));
 const resumed=await fixture(t);await resumed.evaluate(value=>sessionStorage.setItem(submissionKey(),value),stored);await start(resumed);await resumed.clock.runFor(500);
 assert.equal(await resumed.evaluate(()=>clicks),1);
 const attempted=await resumed.evaluate(()=>sessionStorage.getItem(submissionKey()));
 const restarted=await fixture(t);await restarted.evaluate(value=>sessionStorage.setItem(submissionKey(),value),attempted);await start(restarted);await restarted.clock.runFor(1000);
 assert.equal(await restarted.evaluate(()=>clicks),0);assert.equal((await restarted.evaluate(()=>result)).pending,true);
 await acknowledge(restarted);await restarted.clock.runFor(500);assert.equal((await restarted.evaluate(()=>result)).submitted,true);
});

test('submission: unreadable or corrupt journal cannot authorize a new click',async t=>{
 const page=await fixture(t);await page.evaluate(()=>sessionStorage.setItem(submissionKey(),'corrupt'));await start(page);await page.clock.runFor(500);
 assert.equal(await page.evaluate(()=>clicks),0,'unknown previous send intent must never be replaced');
 assert.equal((await page.evaluate(()=>result)).pending,true,'corrupt local intent is not proof of provider failure');
});

// Full submission -> page runner -> DOM collector path; no real model request.
const originalJson=JSON.stringify({findings:[],keep:['original review A']});
const followupJson=JSON.stringify({findings:[],keep:['unrelated follow-up B']});
async function installCollector(page,provider='ChatGPT') {
 await page.evaluate(()=>{
  window.__ashlarRunnerState.running=false;
  window.chrome.runtime.onMessage={addListener:fn=>window.runnerMessage=fn,removeListener(){}};
 });
 for(const file of ['quota.js','model.js','json.js'])await page.addScriptTag({content:src('extension/'+file)});
 await page.evaluate(provider=>{
  window.composer=()=>document.querySelector('textarea');
  installReviewRunner(provider,async()=>{
   await clickSend(()=>document.querySelector('#composer-submit-button'),composer,'owned review prompt');
   return waitUntilReviewOrQuota(provider);
  });
  window.message=(type='ashlar-harvest')=>new Promise(resolve=>runnerMessage({type,jobId:'A',runId:'run-A',provider:provider.toLowerCase(),prompt:'owned review prompt'},null,resolve));
 },provider);
 await page.evaluate(()=>message('ashlar-run'));await page.clock.runFor(500);
}
async function confirmWithId(page) {
 await acknowledge(page);
 await page.evaluate(()=>{document.querySelector('[data-message-author-role="user"]').dataset.messageId='user-A';document.querySelector('textarea').defaultValue='';});
 await page.clock.runFor(500);
}
async function appendAnswer(page,raw,id='reply-A') {
 await page.evaluate(({raw,id})=>{
  const turn=document.createElement('section');turn.dataset.testid='conversation-turn-'+id;
  const msg=document.createElement('div');msg.dataset.messageAuthorRole='assistant';msg.dataset.messageId=id;
  const md=document.createElement('div');md.className='markdown';md.textContent=raw;msg.append(md);
  const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.ariaLabel='Copy response';copy.textContent='copy';
  turn.append(msg,copy);document.querySelector('#turns').append(turn);
 },{raw,id});
}
async function appendFollowup(page,{samePrompt=false}={}) {
 await page.evaluate(samePrompt=>{
  const turn=document.createElement('section');turn.dataset.testid='conversation-turn-user-B';
  const msg=document.createElement('div');msg.dataset.messageAuthorRole='user';msg.dataset.messageId='user-B';
  msg.textContent=samePrompt?'owned review prompt':'personal follow-up';turn.append(msg);document.querySelector('#turns').append(turn);
 },samePrompt);
}
async function rejectSentWrites(page) {
 await page.evaluate(()=>{
  window.rejectSent=true;window.sentWrites=0;const set=sessionStorage.setItem.bind(sessionStorage);
  sessionStorage.setItem=(key,value)=>{
   if(key.startsWith('ashlar:submission:')&&JSON.parse(value).phase==='sent'){
    window.sentWrites++;if(window.rejectSent)throw new DOMException('fixture quota exceeded','QuotaExceededError');
   }
   return set(key,value);
  };
 });
}
for(const provider of ['ChatGPT','Grok']) {
 test(`${provider}: accepted send survives failed sent-journal write and resumes persistence, not generation`,async t=>{
  const page=await fixture(t);await rejectSentWrites(page);await installCollector(page,provider);await confirmWithId(page);
  let result=await page.evaluate(()=>message());assert.equal(result.code,'busy','bookkeeping failure became cached terminal error');
  assert.equal(result.progress.persistenceError,true);
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem(submissionKey())).phase),'attempted');
  await page.clock.fastForward(8*3600_000);assert.equal((await page.evaluate(()=>message())).code,'busy');assert.equal(await page.evaluate(()=>clicks),1);
  await page.evaluate(()=>window.rejectSent=false);await appendAnswer(page,originalJson);await page.clock.runFor(2400);
  result=await page.evaluate(()=>message());assert.equal(result.raw,originalJson);assert.equal(result.progress.persistenceError,false);
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem(submissionKey())).messageId),'user-A');
  assert.equal(await page.evaluate(()=>clicks),1);
 });
}

test('a collected result stays available and may close its tab even while the confirmed journal write keeps failing',async t=>{
 // The confirmed identity is held in memory; a pending local write is not the user's activity and
 // must not hold a secured tab (it could hold it forever).
 const page=await fixture(t);await rejectSentWrites(page);await installCollector(page);await confirmWithId(page);
 await appendAnswer(page,originalJson);await page.clock.runFor(2400);
 assert.equal((await page.evaluate(()=>message())).raw,originalJson);
 assert.equal((await page.evaluate(()=>message('ashlar-can-close'))).canClose,true);
 await page.evaluate(()=>window.rejectSent=false);
 assert.equal((await page.evaluate(()=>message('ashlar-can-close'))).canClose,true);
 assert.equal(await page.evaluate(()=>clicks),1);
});

test('page-context restart from the durable attempted record recovers the accepted turn without a second click',async t=>{
 const page=await fixture(t);await rejectSentWrites(page);await installCollector(page);await confirmWithId(page);
 const attempted=await page.evaluate(()=>sessionStorage.getItem(submissionKey()));assert.equal(JSON.parse(attempted).phase,'attempted');
 const restored=await fixture(t);await restored.evaluate(value=>sessionStorage.setItem(submissionKey(),value),attempted);
 await acknowledge(restored);await restored.evaluate(()=>document.querySelector('[data-message-author-role="user"]').dataset.messageId='user-A');
 await appendAnswer(restored,originalJson);await installCollector(restored);await restored.clock.runFor(2400);
 assert.equal((await restored.evaluate(()=>message())).raw,originalJson);assert.equal(await restored.evaluate(()=>clicks),0);
});

for(const provider of ['ChatGPT','Grok']) {
 test(`${provider}: a follow-up before the second observation cannot replace the bound review or close its tab`,async t=>{
  const page=await fixture(t);await installCollector(page,provider);await confirmWithId(page);await appendAnswer(page,originalJson);
  // Mutation-driven observation starts immediately; inject the follow-up before
  // the second stability observation, not after the old fixed 800ms poll.
  await page.clock.runFor(1);assert.equal((await page.evaluate(()=>message())).code,'busy');
  await appendFollowup(page);await appendAnswer(page,followupJson,'reply-B');
  await page.evaluate(()=>{const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop generating';document.body.append(stop);});
  await page.clock.runFor(2400);const result=await page.evaluate(()=>message());assert.equal(result.raw,originalJson);
  assert.equal(result.responseText.includes('unrelated follow-up'),false);
  const cleanup=await page.evaluate(()=>message('ashlar-can-close'));assert.equal(cleanup.canClose,false);assert.equal(cleanup.reason,'repurposed');
  assert.equal((await page.evaluate(()=>message())).raw,originalJson);assert.equal(await page.evaluate(()=>clicks),1);
 });
}

test('bound response selection uses message identity even if earlier DOM messages are removed',async t=>{
 const page=await fixture(t);await acknowledge(page,'earlier personal question');await page.locator('textarea').fill('owned review prompt');
 await installCollector(page);await acknowledge(page);await page.evaluate(()=>userTurns().at(-1).dataset.messageId='user-A');await page.clock.runFor(500);
 await appendAnswer(page,originalJson);await page.clock.runFor(800);await appendFollowup(page,{samePrompt:true});await appendAnswer(page,followupJson,'reply-B');
 await page.evaluate(()=>userTurns()[0].remove());await page.clock.runFor(2400);
 assert.equal((await page.evaluate(()=>message())).raw,originalJson);
});

test('missing bound user identity does not fall back to the newest valid JSON or repeat submission',async t=>{
 const page=await fixture(t);await installCollector(page);await confirmWithId(page);await appendAnswer(page,originalJson);
 await page.clock.runFor(1);await page.evaluate(()=>document.querySelector('[data-message-id="user-A"]').remove());
 await appendFollowup(page,{samePrompt:true});await appendAnswer(page,followupJson,'reply-B');await page.clock.fastForward(8*3600_000);
 assert.equal((await page.evaluate(()=>message())).code,'busy');assert.equal(await page.evaluate(()=>clicks),1);
});

test('valid follow-up JSON never substitutes an unparseable original review',async t=>{
 const page=await fixture(t);await installCollector(page);await confirmWithId(page);await appendAnswer(page,'original not JSON');
 await appendFollowup(page);await appendAnswer(page,followupJson,'reply-B');await page.clock.fastForward(8*3600_000);
 const result=await page.evaluate(()=>message());assert.equal(result.code,'busy');assert.equal(result.observation.text.includes('original not JSON'),true);
 assert.equal(result.observation.text.includes('unrelated follow-up'),false);assert.equal(await page.evaluate(()=>clicks),1);
});

for(const phase of ['prepared','attempted'])test(`a failed ${phase} durability barrier prevents all automatic send clicks`,async t=>{
 const page=await fixture(t);await page.evaluate(phase=>{
  const set=sessionStorage.setItem.bind(sessionStorage);
  sessionStorage.setItem=(key,value)=>{
   if(key.startsWith('ashlar:submission:')&&JSON.parse(value).phase===phase)throw Error('fixture intent write failed');
   return set(key,value);
  };
 },phase);
 await installCollector(page);await page.clock.runFor(2000);
 assert.equal(await page.evaluate(()=>clicks),0);
 assert.equal((await page.evaluate(()=>message())).ok,false);
});

test('a provider without user-message IDs uses confirmed position and prompt, not the latest reply',async t=>{
 const page=await fixture(t);await installCollector(page);await acknowledge(page);await page.clock.runFor(500);
 await appendAnswer(page,originalJson);await page.clock.runFor(800);
 await appendFollowup(page,{samePrompt:true});await appendAnswer(page,followupJson,'reply-B');await page.clock.runFor(2400);
 assert.equal((await page.evaluate(()=>message())).raw,originalJson);
 assert.equal((await page.evaluate(()=>message('ashlar-can-close'))).reason,'repurposed');
});

test('a Stop inside the bound response still blocks completion after a user follow-up',async t=>{
 const page=await fixture(t);await installCollector(page);await confirmWithId(page);await appendAnswer(page,originalJson);
 await page.evaluate(()=>{const stop=document.createElement('button');stop.id='original-stop';stop.dataset.testid='stop-button';stop.textContent='Stop generating';document.querySelector('[data-testid="conversation-turn-reply-A"]').append(stop);});
 await appendFollowup(page);await appendAnswer(page,followupJson,'reply-B');await page.clock.runFor(2400);
 assert.equal((await page.evaluate(()=>message())).code,'busy');
 await page.evaluate(()=>document.querySelector('#original-stop').remove());await page.clock.runFor(2400);
 assert.equal((await page.evaluate(()=>message())).raw,originalJson);
});

test('genuine quota after the bound submission is still terminal even before an assistant node exists',async t=>{
 const page=await fixture(t);await installCollector(page);await confirmWithId(page);
 await page.evaluate(()=>{const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='usage limit reached';document.body.append(alert);});
 await page.clock.runFor(1600);assert.equal((await page.evaluate(()=>message())).code,'quota');
});
test('a follow-up quota notice cannot fail the original unparseable review',async t=>{
 const page=await fixture(t);await installCollector(page);await confirmWithId(page);await appendAnswer(page,'original not JSON');await appendFollowup(page);
 await page.evaluate(()=>{const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='usage limit reached';document.body.append(alert);});
 await page.clock.runFor(2400);assert.equal((await page.evaluate(()=>message())).code,'busy');
});

function connectWorker(page) {
 const received=[];
 const job={jobId:'A',origin:'http://bridge',providers:['chatgpt'],prompt:'owned review prompt',leaseId:'lease',states:{chatgpt:{tabId:10,started:true,runId:'run-A'}}};
 const worker=background({local:storage({origin:'http://bridge',token:'fixture-token',pendingReviewJobs:{A:job}}),
  tabs:new Map([[10,{id:10,url:'about:blank',status:'complete'}]]),
  api:async(_path,body)=>{
   if(body?.action==='complete')received.push(body);
   if(body?.jobId)return {ok:true,accepted:true,active:!received.length,status:received.length?'posted':'awaiting_chat'};
   return {ok:true,job:null};
  }});
 // Offline pages are about:blank; the adapter presents their logical provider URL
 // consistently to both the production tab guard and the page's close handshake.
 worker.tabs.get(10).url='https://chatgpt.com/c/fixture-A';
 worker.chrome.tabs.sendMessage=(id,msg,callback)=>{
  worker.messages.push({id,...msg});
  page.evaluate(msg=>new Promise(resolve=>runnerMessage(msg,null,resolve)),msg)
   .then(result=>callback({...result,...(result.url!==undefined?{url:'https://chatgpt.com/c/fixture-A'}:{}),...(result.conversation!==undefined?{conversation:'https://chatgpt.com/c/fixture-A'}:{})}),error=>{
    worker.chrome.runtime.lastError={message:error.message};callback();worker.chrome.runtime.lastError=null;
   });
 };
 return {worker,received};
}

test('worker delivers the bound result once and preserves the follow-up tab after server ACK',async t=>{
 const page=await fixture(t);await installCollector(page);await confirmWithId(page);await appendAnswer(page,originalJson);await page.clock.runFor(800);
 await appendFollowup(page);await appendAnswer(page,followupJson,'reply-B');await page.clock.runFor(2400);
 const {worker,received}=connectWorker(page);await worker.tick();await worker.tick();
 assert.deepEqual(received.map(r=>[r.jobId,r.results[0].provider,r.raw]),[['A','chatgpt',originalJson]]);
 assert.equal(worker.closedTabs.length,0);assert.equal(page.isClosed(),false);assert.equal(await page.evaluate(()=>clicks),1);
});

test('worker ACK closes the secured tab even while its sent-journal write keeps failing; nothing is redelivered or re-sent',async t=>{
 const page=await fixture(t);await rejectSentWrites(page);await installCollector(page);await confirmWithId(page);await appendAnswer(page,originalJson);await page.clock.runFor(2400);
 const {worker,received}=connectWorker(page);await worker.tick();
 assert.equal(received.length,1);assert.deepEqual(worker.closedTabs,[10]);
 assert.equal(worker.local.state.pendingReviewJobs.A,undefined,'the delivered leg retired');
 await worker.tick();
 assert.equal(received.length,1);assert.equal(await page.evaluate(()=>clicks),1);
});
