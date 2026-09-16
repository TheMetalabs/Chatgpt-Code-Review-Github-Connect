import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

test('submission: a no-op click is not confirmation, and delayed ACK never resends',async t=>{
 const page=await fixture(t);await start(page);await page.clock.runFor(500);
 assert.equal((await page.evaluate(()=>result)).pending,true,'click is only an attempt, not provider receipt');
 await page.clock.fastForward(365*24*3600_000);assert.equal(await page.evaluate(()=>clicks),1);
 await acknowledge(page);await page.clock.runFor(500);assert.equal((await page.evaluate(()=>result)).submitted,true);assert.equal(await page.evaluate(()=>clicks),1);
});

test('submission: a cleared composer or a different user turn is not the owned request',async t=>{
 const page=await fixture(t);await start(page);await acknowledge(page,'personal message');await page.clock.runFor(1000);
 assert.equal((await page.evaluate(()=>result)).pending,true);assert.equal(await page.evaluate(()=>clicks),1);
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
