import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source,json} from './load-source.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const toolbar='<button aria-label="Copy response" data-testid="copy-turn-action-button">copy</button>';
const stop='<button data-testid="stop-button" aria-label="Stop generating">Stop</button>';
const user='<section data-testid="conversation-turn-1"><div data-message-author-role="user">review me</div></section>';
function answer(content='',done=false){return `<section data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown">${content}</div></div>${done?toolbar:''}</section>`;}
async function fixture(t,html){
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();await page.setContent(html);
 await page.evaluate(()=>{window.chrome={runtime:{onMessage:{addListener(fn){window.handler=fn;}}}};window.sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));window.findingsJsonTooThin=()=>false;});
 for(const path of ['extension/quota.js','extension/json.js'])await page.addScriptTag({content:source(path)});
 return page;
}
async function startWait(page){await page.evaluate(()=>{window.waitResult={pending:true};waitUntilReviewOrQuota('ChatGPT').then(raw=>window.waitResult={raw},e=>window.waitResult={code:e.code,error:e.message});});}
test('real DOM: visible Stop wins even if response actions are visible',async t=>{
 const page=await fixture(t,user+answer(json,true)+stop);
 assert.equal(await page.evaluate(()=>chatGenerationFinished({stopVisible:stopButtonVisible(),replyActionsVisible:replyDoneVisible()})),false);
});
test('real DOM: previous answer toolbar is not completion of newly queued request',async t=>{
 const page=await fixture(t,answer(json,true)+user);assert.equal(await page.evaluate(()=>replyDoneVisible()),false);
});
test('real DOM: quoted quota text in review source is not a quota banner',async t=>{
 const page=await fixture(t,user+answer('<span>usage limit reached</span>'));assert.equal(await page.evaluate(()=>quotaHit()),false);
});
test('real DOM: hidden quota alerts do not abort generation',async t=>{
 const page=await fixture(t,user+'<div hidden role="alert">usage limit reached</div>');assert.equal(await page.evaluate(()=>quotaHit()),false);
});
test('real DOM: actual visible quota banner is a terminal error',async t=>{
 const page=await fixture(t,user+'<div role="alert">usage limit reached</div>');await startWait(page);
 await page.clock.runFor(1600);assert.equal((await page.evaluate(()=>waitResult)).code,'quota');
});
test('real DOM: stop flicker and complete-looking intermediate JSON do not complete review',async t=>{
 const page=await fixture(t,user+answer(json)+stop);await startWait(page);await page.clock.runFor(1000);
 await page.evaluate(()=>document.querySelector('[data-testid="stop-button"]').remove());
 await page.clock.runFor(2400);assert.equal((await page.evaluate(()=>waitResult)).pending,true);
});
test('real DOM: 365 days queued + generation is still pending until current answer completes',async t=>{
 const page=await fixture(t,user);await startWait(page);
 await page.clock.fastForward(365*24*3600_000);assert.equal((await page.evaluate(()=>waitResult)).pending,true);
 await page.setContent(user+answer(json)+stop);await page.clock.fastForward(24*3600_000);assert.equal((await page.evaluate(()=>waitResult)).pending,true);
 await page.setContent(user+answer(json,true));await page.clock.runFor(3200);assert.equal((await page.evaluate(()=>waitResult)).raw,json);
});
test('real DOM: markdown br and escaped source code are recovered from final response',async t=>{
 const raw=JSON.stringify({findings:[],keep:['return "}"; const path = "C:\\tmp";']},null,2);
 const html=raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>');
 const page=await fixture(t,user+answer(`<p>${html}</p>`,true));await startWait(page);await page.clock.runFor(3200);
 assert.deepEqual(JSON.parse((await page.evaluate(()=>waitResult)).raw),JSON.parse(raw));
});
test('real DOM: harvest does not expose provisional JSON while the runner is busy',async t=>{
 const page=await fixture(t,user+answer(json)+stop);await page.addScriptTag({content:source('extension/content-chatgpt.js')});
 await page.evaluate(()=>{runPrompt=async()=>new Promise(()=>{});handler({type:'ashlar-run',jobId:'j',prompt:'p'},null,()=>{});});
 const result=await page.evaluate(()=>new Promise(resolve=>handler({type:'ashlar-harvest',jobId:'j'},null,resolve)));
 assert.equal(result.ok,false);assert.equal(result.code,'busy');
});
test('real DOM: finished without JSON is detected only after positive completion controls',async t=>{
 const page=await fixture(t,user+answer('still thinking'));await startWait(page);await page.clock.fastForward(24*3600_000);
 assert.equal((await page.evaluate(()=>waitResult)).pending,true);
 await page.setContent(user+answer('done, but no JSON',true));await page.clock.runFor(6400);
 assert.equal((await page.evaluate(()=>waitResult)).code,'empty');
});
