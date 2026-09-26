// Minimal synthetic counterparts of operator-provided HTML, never private captures.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});
const valid=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['fixture checked'],highest_risk:'if (value === "quoted")'});
async function pageFor(t,html=''){
 const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',r=>r.abort());
 const page=await context.newPage();await page.setContent(`<main id="turns">${html}</main><form data-type="unified-composer"><input type="file" multiple><div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px"></div><button id="composer-submit-button" data-testid="send-button" aria-label="프롬프트 보내기" style="width:36px;height:36px">send</button></form>`);
 await page.clock.install();await page.evaluate(()=>{
  const saved=new Map();Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.__ashlarRunnerState={jobId:'A',runId:'run-A',provider:'chatgpt',running:true};
  window.chrome={runtime:{onMessage:{addListener(){},removeListener(){}}}};
  window.clicks=0;document.querySelector('form').onsubmit=e=>e.preventDefault();document.querySelector('#composer-submit-button').onclick=()=>window.clicks++;
 });
 for(const file of ['turns.js','composer.js','quota.js','model.js','json.js'])await page.addScriptTag({content:source('extension/'+file)});
 await page.evaluate(()=>{window.composer=()=>document.querySelector('#prompt-textarea');});return page;
}
const user='<section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user" data-message-id="user-A"><div data-testid="collapsible-user-message-content"><div class="rich-text-user-turn markdown"><p>Review fixture.<br>Head: abc123</p><p>Only inspect changed files.</p></div></div></div><button data-testid="copy-turn-action-button" aria-label="메시지 복사">user copy</button></section>';
const actions='<div aria-label="응답 작업" role="group"><button data-testid="copy-turn-action-button" aria-label="응답 복사" style="width:32px;height:32px">copy</button></div>';
function answer(text,{streaming=false}={}){return `<section data-testid="conversation-turn-2" data-turn="assistant">${streaming?'<div data-streaming-response-status>작업 중</div>':''}<div data-message-author-role="assistant" data-message-id="answer-A"><div class="markdown">${text}</div></div>${actions}</section>`;}
async function bind(page){await page.evaluate(()=>{
 saveSubmission({phase:'sent',expected:'Review fixture. Head: abc123 Only inspect changed files.',baseline:0,submittedUsers:1,messageId:'user-A'});
 window.received=null;waitUntilReviewOrQuota('ChatGPT').then(raw=>window.received={raw},e=>window.received={error:e.message});
});}
test('rich user paragraphs/br confirm submission without concatenating adjacent words',async t=>{
 const page=await pageFor(t,user);
 assert.equal(await page.evaluate(()=>submissionConfirmed({phase:'attempted',expected:'Review fixture. Head: abc123 Only inspect changed files.',baseline:0})),true);
 assert.equal(await page.evaluate(()=>clicks),0);
});
test('bound response after rich user prompt is collected, escaped code-fence JSON stays literal',async t=>{
 const page=await pageFor(t,user+answer('<pre><code></code></pre>'));
 await page.locator('pre code').evaluate((el,raw)=>el.textContent=raw,valid);await bind(page);await page.clock.runFor(2400);
 assert.equal((await page.evaluate(()=>received))?.raw,valid);
});
test('explicit streaming status blocks completion even during a Stop-control gap',async t=>{
 const page=await pageFor(t,answer('<pre><code></code></pre>',{streaming:true}));await page.locator('pre code').evaluate((el,raw)=>el.textContent=raw,valid);
 await page.evaluate(()=>{window.received=null;waitUntilReviewOrQuota('ChatGPT').then(raw=>window.received=raw);});await page.clock.runFor(2400);
 assert.equal(await page.evaluate(()=>received),null);
 await page.locator('[data-streaming-response-status]').evaluate(el=>el.remove());await page.clock.runFor(2400);
 assert.equal(await page.evaluate(()=>received),valid);
});
test('completed paragraph JSON with lost quote escapes is diagnosed, not endlessly labeled generating or invented',async t=>{
 const malformed='{"findings":[],"highest_risk":"value === "quoted""}';
 const page=await pageFor(t,answer('<p></p>'));await page.locator('.markdown p').evaluate((el,text)=>el.textContent=text,malformed);
 await page.evaluate(()=>{window.received=null;waitUntilReviewOrQuota('ChatGPT').then(raw=>window.received=raw);});await page.clock.runFor(2400);
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.observation.state),'response_completed_json_invalid');
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.observation.text),malformed);assert.equal(await page.evaluate(()=>received),null);
 await page.clock.fastForward(365*24*3600_000);assert.equal(await page.evaluate(()=>received),null);
 // Corrected DOM may still become observable; the first bad fragment is not cached terminal.
 await page.locator('.markdown p').evaluate((el,text)=>el.textContent=text,valid);await page.clock.runFor(2400);assert.equal(await page.evaluate(()=>received),valid);
});
// Staging waits for the file's chip to show (the staging chain stops at the first strategy whose
// chip shows), never for its upload to finish: the chip here keeps its progress ring.
test('attach then fill waits for the chip to show, not for its upload, types into the remounted editor, and never pastes file bodies',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>{
  document.querySelector('input[type=file]').onchange=()=>{window.attached=true;const old=composer();old.replaceWith(old.cloneNode());
   const chip=document.createElement('div');chip.setAttribute('role','group');chip.ariaLabel='diff.patch';chip.innerHTML='diff.patch<span class="animate-spin" style="display:inline-block;width:20px;height:20px">uploading</span>';document.querySelector('form').append(chip);};
  window.filled=null;fillComposer(composer(),'Review fixture\n\n<<<ATTACH:diff.patch>>>\nsecret fixture body\n<<<END_ATTACH>>>').then(text=>window.filled=text,e=>window.filled=e.message);
 });await page.clock.runFor(150);
 assert.equal(await page.evaluate(()=>filled),'Review fixture','body fill waited for fixed attachment sleep or used stale editor');
 assert.equal(await page.evaluate(()=>readComposer(composer())),'Review fixture');
});
test('own attachment confirmation gates Send, old transcript filenames cannot satisfy it',async t=>{
 const page=await pageFor(t,'<div role="group" aria-label="diff.patch">diff.patch</div>');
 await page.evaluate(()=>{
  window.filled=null;fillComposer(composer(),'Review fixture\n\n<<<ATTACH:diff.patch>>>\nfile body\n<<<END_ATTACH>>>').then(text=>{window.filled=text;return clickSend(()=>document.querySelector('#composer-submit-button'),composer,text);});
 });await page.clock.runFor(1200);assert.equal(await page.evaluate(()=>clicks),0);
 // The transcript's chip is not the run's: staging still waits for the composer's own chip.
 assert.equal(await page.evaluate(()=>filled),null);
 await page.evaluate(()=>{const chip=document.createElement('div');chip.setAttribute('role','group');chip.setAttribute('aria-label','diff.patch');chip.textContent='diff.patch';document.querySelector('form').append(chip);});
 await page.clock.runFor(1000);assert.equal(await page.evaluate(()=>filled),'Review fixture');assert.equal(await page.evaluate(()=>clicks),1);
});
test('scoped editor insertion never replaces unrelated selected page text',async t=>{
 const page=await pageFor(t,'<div id="personal">personal text</div>');
 await page.evaluate(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#personal'));getSelection().removeAllRanges();getSelection().addRange(r);window.filled=null;fillComposer(composer(),'Review fixture').then(text=>window.filled=text);});
 await page.clock.runFor(150);assert.equal(await page.locator('#personal').textContent(),'personal text');assert.equal(await page.evaluate(()=>filled),'Review fixture');
});
test('enabled button under an invisible parent is not a send target',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>{
  const hidden=document.createElement('div');hidden.style.opacity='0';hidden.innerHTML='<button data-testid="send-button" aria-label="Send" id="invisible-send">send</button>';document.querySelector('form').prepend(hidden);
 });
 assert.equal(await page.evaluate(()=>findEligibleSendButton(['[data-testid="send-button"]']).id),'composer-submit-button');
});
test('visible attachment progress keeps send pending without delaying prompt entry',async t=>{
 const page=await pageFor(t);await page.evaluate(()=>{
  document.querySelector('input[type=file]').onchange=()=>{const chip=document.createElement('div');chip.setAttribute('role','group');chip.ariaLabel='diff.patch';chip.innerHTML='diff.patch<span class="animate-spin" style="display:inline-block;width:20px;height:20px">uploading</span>';document.querySelector('form').append(chip);};
  window.filled=null;fillComposer(composer(),'Review\n\n<<<ATTACH:diff.patch>>>\nfile body\n<<<END_ATTACH>>>').then(text=>{window.filled=text;return clickSend(()=>document.querySelector('#composer-submit-button'),composer,text);});
 });await page.clock.runFor(100);assert.equal(await page.evaluate(()=>filled),'Review');assert.equal(await page.evaluate(()=>clicks),0);
 // Inside the 3-min upload bound (past it: attachment_failed, tests/review/upload-wait.e2e.mjs).
 await page.clock.runFor(2*60_000);assert.equal(await page.evaluate(()=>clicks),0);
 const stages=await page.evaluate(()=>__ashlarRunnerState.steps.events.map(e=>e.stage));
 assert.equal(stages.filter(s=>s==='attachments_waiting').length,1,'unchanged upload wait must not churn the journal');
 await page.locator('.animate-spin').evaluate(el=>el.style.display='none');await page.clock.runFor(500);assert.equal(await page.evaluate(()=>clicks),1);
});
