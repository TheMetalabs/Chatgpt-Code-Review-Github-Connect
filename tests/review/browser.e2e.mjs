import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source,json} from './load-source.mjs';
import {background,storage} from './helpers.mjs';
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
test('real DOM: even completed-looking prose is not converted to empty after a poll count',async t=>{
 const page=await fixture(t,user+answer('still thinking'));await startWait(page);await page.clock.fastForward(24*3600_000);
 assert.equal((await page.evaluate(()=>waitResult)).pending,true);
 await page.setContent(user+answer('done, but no JSON',true));await page.clock.runFor(6400);
 assert.equal((await page.evaluate(()=>waitResult)).pending,true);
});

test('real DOM: only a completed owned run without a new user draft may be closed',async t=>{
 const page=await fixture(t,user+answer(json,true)+'<textarea id="prompt-textarea"></textarea>');
 await page.addScriptTag({content:source('extension/content-chatgpt.js')});
 await page.evaluate(()=>{
   composer=()=>document.querySelector('textarea');
   runPrompt=async()=>'{"findings":[]}';
   handler({type:'ashlar-run',jobId:'A',provider:'chatgpt',runId:'run-A'},null,()=>{});
 });
 const inspect=()=>page.evaluate(()=>new Promise(resolve=>handler({type:'ashlar-can-close',jobId:'A',provider:'chatgpt',runId:'run-A'},null,resolve)));
 assert.equal((await inspect()).canClose,true);
 await page.locator('textarea').fill('my unsent personal question');
 assert.equal((await inspect()).canClose,false);
 await page.locator('textarea').fill('');
 await page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='personal follow-up';document.body.append(u);});
 assert.equal((await inspect()).reason,'repurposed');
 const wrong=await page.evaluate(()=>new Promise(resolve=>handler({type:'ashlar-can-close',jobId:'A',provider:'chatgpt',runId:'run-B'},null,resolve)));
 assert.equal(wrong.code,'job_mismatch');
});

test('real DOM: simultaneous final responses are extracted without touching the shared clipboard',async t=>{
 const rawA=JSON.stringify({findings:[],keep:['PR A']}),rawB=JSON.stringify({findings:[],keep:['PR B']});
 const pages=await Promise.all([fixture(t,user+answer(rawA,true)),fixture(t,user+answer(rawB,true))]);
 for(const page of pages){
  await page.evaluate(()=>{
    window.clipboardReads=0;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:()=>{window.clipboardReads++;throw Error('cross-tab clipboard read');},writeText:()=>{throw Error('clipboard overwrite');}}});
  });
  await startWait(page);
 }
 await Promise.all(pages.map(page=>page.clock.runFor(3200)));
 assert.deepEqual(await Promise.all(pages.map(page=>page.evaluate(()=>waitResult.raw))),[rawA,rawB]);
 assert.deepEqual(await Promise.all(pages.map(page=>page.evaluate(()=>clipboardReads))),[0,0]);
});

test('regression: blank current response with toolbar waits more than six hours, then returns JSON',async t=>{
 const page=await fixture(t,user+answer('',true));await startWait(page);await page.clock.runFor(8000);
 assert.equal((await page.evaluate(()=>waitResult)).pending,true);
 await page.clock.fastForward(8*3600_000);assert.equal((await page.evaluate(()=>waitResult)).pending,true);
 await page.evaluate(text=>document.querySelector('.markdown').textContent=text,json);await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>waitResult)).raw,json);
});
test('regression: an evolving or stable non-JSON UI fragment is not a timer-based terminal failure',async t=>{
 const page=await fixture(t,user+answer('fragment 0',true));await startWait(page);
 for(let i=1;i<=9;i++){await page.evaluate(i=>document.querySelector('.markdown').textContent='fragment '+i,i);await page.clock.runFor(800);}
 await page.clock.fastForward(8*3600_000);assert.equal((await page.evaluate(()=>waitResult)).pending,true);
 await page.evaluate(text=>document.querySelector('.markdown').textContent=text,json);await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>waitResult)).raw,json);
});
test('regression: JSON in a second markdown block is harvested, not marked empty',async t=>{
 const page=await fixture(t,user+`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown">Analysis complete</div><div class="markdown"><pre><code>${json}</code></pre></div></div>${toolbar}</section>`);
 await startWait(page);await page.clock.runFor(6400);assert.equal((await page.evaluate(()=>waitResult)).raw,json);
});
test('regression: hidden duplicate DOM text cannot corrupt visible JSON',async t=>{
 const page=await fixture(t,user+answer('{<span hidden>hidden duplicate</span>"findings":[],"keep":["checked"]}',true));await startWait(page);await page.clock.runFor(6400);
 assert.equal((await page.evaluate(()=>waitResult)).raw,'{"findings":[],"keep":["checked"]}');
});

// Structural regression derived from the operator's pasted response HTML. Paths,
// file IDs and prose are synthetic; the private example itself is not published.
function citedParagraphExample(){
 const citation='<span class="contents" data-content-reference-start="10" data-content-reference-end="20"><span data-file-citation-group-identity="[[&quot;fixture&quot;]]" aria-haspopup="dialog"><button type="button"><svg aria-hidden="true"></svg><p class="not-prose">PRIVATE-CITATION-LABEL +1</p></button></span></span><span class="contents" data-content-reference-start="21"></span>';
 return `<p dir="auto" data-is-last-node="" data-is-only-node="">{<br>
"merge_recommendation": "REQUEST_CHANGES",<br>
"investigated_safe": ["src/<strong data-start="1" data-end="2">tests</strong>/fixture.test.ts: inspected. ${citation}"],<br>
"findings": [<br>
{"severity":"P1","file":"src/first.ts","line":4,"side":"RIGHT","title":"First fixture","evidence":"return x =&gt; ({value: x}); ${citation}"},<br>
{"severity":"P2","file":"src/second.ts","line":8,"side":"RIGHT","title":"Second fixture","evidence":"Array.isArray(payload) ? payload : [] ${citation}"}<br>
]<br>
}</p>`;
}
for(const leadingProse of [false,true])test(`operator example structure: paragraph/br JSON, nested citation UI, emphasis and entities (${leadingProse?'later markdown':'single markdown'})`,async t=>{
 const html=citedParagraphExample();
 const body=user+`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant">${leadingProse?'<div class="markdown"><p>The final review follows.</p></div>':''}<div class="markdown">${html}</div></div>${toolbar}</section>`;
 const page=await fixture(t,body);await startWait(page);await page.clock.runFor(3200);
 const result=await page.evaluate(()=>waitResult);
 const parsed=JSON.parse(result.raw);
 assert.equal(parsed.merge_recommendation,'REQUEST_CHANGES');assert.equal(parsed.findings.length,2);
 assert.equal(parsed.investigated_safe[0],'src/tests/fixture.test.ts: inspected. ');
 assert.equal(parsed.findings[0].evidence,'return x => ({value: x}); ');
 assert.equal(parsed.findings[1].file,'src/second.ts');
 assert.doesNotMatch(result.raw,/PRIVATE-CITATION-LABEL|data-content-reference|<strong|&gt;/);
});

test('real DOM recovery: missing job resumes its bound observer without a new prompt',async t=>{
 const page=await fixture(t,user+answer(json,true));
 // PR39 also restores the accepted-submission journal before its real collector.
 await page.addScriptTag({content:source('extension/composer.js')});
 await page.evaluate(()=>{
  const saved=new Map([['ashlar:submission:A:run-A',JSON.stringify({phase:'sent',expected:'review me',baseline:0,submittedUsers:1,messageId:''})]]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)}});
 });
 await page.addScriptTag({content:source('extension/content-chatgpt.js')});
 await page.evaluate(()=>{
  Object.assign(__ashlarRunnerState,{jobId:'A',runId:'run-A',running:false,result:null});
  window.freshSends=0;
  fillComposer=()=>{window.freshSends++;throw Error('observer must not submit a prompt');};
 });
 const job={jobId:'A',provider:'chatgpt',providers:['chatgpt'],origin:'http://bridge',prompt:'original prompt',leaseId:'lease-A',
  states:{chatgpt:{tabId:10,started:true,runId:'run-A'}}};
 const b=background({local:storage({origin:'http://bridge',token:'fixture-token',pendingReviewJobs:{A:job}}),
  tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A',status:'complete'}]]),
  api:async(_path,body)=>body?.jobId?{ok:true,active:false,accepted:false,status:'missing'}:{ok:true,job:null}});
 b.chrome.tabs.sendMessage=(id,msg,callback)=>{
  b.messages.push({id,...msg});
  page.evaluate(msg=>new Promise(resolve=>handler(msg,null,resolve)),msg).then(callback,error=>{
   b.chrome.runtime.lastError={message:error.message};callback();b.chrome.runtime.lastError=null;
  });
 };
 await b.tick();await page.clock.runFor(2400);await b.tick();
 assert.equal(b.local.state.pendingReviewJobs.A.states.chatgpt.outcome?.raw,json);
 assert.equal(await page.evaluate(()=>freshSends),0);
 assert.equal(b.messages.filter(m=>m.type==='ashlar-run').length,1);
 assert.ok(b.messages.filter(m=>m.type==='ashlar-run').every(m=>m.resume===true&&!m.prompt&&!m.adoptLegacy));
 assert.equal(b.calls.some(c=>c.action==='complete'||c.action==='failure'),false);
 assert.equal(b.closedTabs.length,0);
});

// Review-loop FIX items: plain-text answers (no review JSON), and the ownership proof a cancelled
// fix tab must give before the worker may force-close it.
test('real DOM: a fix item harvests its fenced JSON (no review JSON) only after completion',async t=>{
 const fixAnswer='{"summary":"guard","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}';
 const page=await fixture(t,user+answer(`<p>I guarded the null path.</p><pre><code>${fixAnswer}</code></pre>`)+stop);
 await page.evaluate(()=>{window.__ashlarRunnerState={kind:'fix'};});
 await startWait(page);await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>waitResult)).pending,true,'Stop is visible: still generating');
 await page.evaluate(toolbar=>{document.querySelector('[data-testid="stop-button"]').remove();document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('beforeend',toolbar);},toolbar);
 await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>waitResult)).raw,fixAnswer);
});
test('real DOM: a cancelled fix tab is Ashlar-owned only until the user takes it over',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent('<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown">answer</div></div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div><button data-testid="send-button" aria-label="Send prompt">Send</button></form>');
 await page.evaluate(()=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A'],['ashlar:submission:fix-A:run-A',JSON.stringify({phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A'})]]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
 });
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 const cancel=(extra={})=>page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type:'ashlar-fix-cancel',jobId:'fix-A',runId:'run-A',provider:'chatgpt',kind:'fix',...extra});
 assert.equal((await cancel({jobId:'fix-B'})).code,'job_mismatch');
 assert.equal((await cancel()).owned,true,'the bound answer with no user activity is Ashlar-owned');
 await page.locator('#prompt-textarea').evaluate(el=>{el.textContent='my own question';});
 assert.equal((await cancel()).owned,false,'an unsent user draft preserves the tab');
 await page.locator('#prompt-textarea').evaluate(el=>{el.textContent='';});
 assert.equal((await cancel()).owned,true);
 await page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='personal follow-up';document.querySelector('main').append(u);});
 assert.equal((await cancel()).owned,false,'a follow-up turn preserves the tab');
});
test('real DOM: before its send is confirmed, a fix tab is owned only with no turn or just its own prompt',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent('<main></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px">fix prompt</div></form>');
 await page.evaluate(()=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A'],['ashlar:submission:fix-A:run-A',JSON.stringify({phase:'attempted',expected:'fix prompt',baseline:0})]]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
 });
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 const cancel=()=>page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type:'ashlar-fix-cancel',jobId:'fix-A',runId:'run-A',provider:'chatgpt',kind:'fix'});
 assert.equal((await cancel()).owned,true,'only Ashlar\'s own half-sent prompt is in the tab');
 const draft=text=>page.locator('#prompt-textarea').evaluate((el,t)=>{el.textContent=t;},text);
 await draft('my own question');
 assert.equal((await cancel()).owned,false,'no turn yet, but the composer holds the user\'s own text');
 await draft('fix prompt\nmy own private suffix');
 assert.equal((await cancel()).owned,false,'Ashlar\'s prompt plus user text is the user\'s: only the exact prompt is owned');
 await draft('my note: fix prompt');
 assert.equal((await cancel()).owned,false,'a user prefix is the user\'s too');
 await draft('fix prompt');
 await page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='fix prompt';document.querySelector('main').append(u);});
 assert.equal((await cancel()).owned,true,'the just-clicked, not yet confirmed turn is Ashlar\'s');
 await draft('my own question');
 assert.equal((await cancel()).owned,false,'Ashlar\'s turn, but a user draft in the composer');
 await draft('');
 await page.evaluate(()=>{document.querySelector('[data-message-author-role="user"]').textContent='fix prompt and my own words';});
 assert.equal((await cancel()).owned,false,'a just-clicked turn with more than Ashlar\'s prompt preserves the tab');
 await page.evaluate(()=>{document.querySelector('[data-message-author-role="user"]').textContent='someone else asked this';});
 assert.equal((await cancel()).owned,false,'a turn that is not Ashlar\'s prompt preserves the tab');
});

test('real DOM: a fix is read from its fenced code block literally, never from rendered prose',async t=>{
 // What ChatGPT renders for the same JSON: unfenced it is markdown (the escaped \\n loses a
 // backslash, *x* becomes emphasis, __init__ bold) yet still parses; fenced it is literal code.
 const literal='{"summary":"s","files":[{"path":"a.py","content":"print(\\"a\\\\nb\\") # *x* __init__"}]}';
 const prose='{"summary":"s","files":[{"path":"a.py","content":"print(\\"a\\nb\\") # <em>x</em> <strong>init</strong>"}]}';
 const code=`<pre><div>json</div><button>Copy code</button><div><code class="language-json">${literal.replace(/</g,'&lt;')}</code></div></pre>`;
 const page=await fixture(t,user+answer(`<p>Here is the fix.</p>${code}`,true));
 assert.deepEqual(await page.evaluate(()=>assistantCodeBlocks()),[literal]);
 const unfenced=await fixture(t,user+answer(`<p>${prose}</p>`,true));
 assert.deepEqual(await unfenced.evaluate(()=>assistantCodeBlocks()),[],'rendered prose is never read as a fix');
 await unfenced.evaluate(()=>{window.__ashlarRunnerState={kind:'fix',running:true,jobId:'fix-A',runId:'run-A'};window.fixResult={pending:true};waitUntilFixOrQuota('ChatGPT').then(raw=>window.fixResult={raw},e=>window.fixResult={error:e.message});});
 await unfenced.clock.runFor(3200);
 const out=await unfenced.evaluate(()=>window.fixResult);
 assert.match(out.raw,/no fenced code block/);assert.ok(!out.raw.includes('{'),'no JSON reaches the fix parser');
});

test('real DOM: a hidden or stale code block the renderer kept is never part of a fix answer',async t=>{
 const visible='{"summary":"new","files":[]}';
 const page=await fixture(t,user+answer(`<pre hidden><code>{"summary":"stale-hidden"}</code></pre><div style="display:none"><pre><code>{"summary":"stale-none"}</code></pre></div><pre style="opacity:0"><code>{"summary":"stale-transparent"}</code></pre><pre><code>${visible}</code></pre>`,true));
 assert.deepEqual(await page.evaluate(()=>assistantCodeBlocks()),[visible]);
});

test('real DOM: a completed fix with prose around its fence still proves its own tab (can close)',async t=>{
 const code='{"summary":"s","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}';
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 await page.setContent(`<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><p>Here is the fix.</p><pre><code>${code}</code></pre></div></div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form>`);
 await page.evaluate(()=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A'],['ashlar:submission:fix-A:run-A',JSON.stringify({phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A'})]]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
 });
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 await page.evaluate(()=>{const s=__ashlarRunnerState;s.kind='fix';s.running=true;window.fixOut={pending:true};
  waitUntilFixOrQuota('ChatGPT').then(raw=>{window.fixOut={raw};s.running=false;s.result={ok:true,raw,responseText:raw};},e=>{window.fixOut={error:e.message};});});
 await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>window.fixOut)).raw,code,'the fenced JSON only');
 assert.ok(await page.evaluate(()=>__ashlarRunnerState.nativeCompletion?.responseId==='response-A'),'the bound response proves the answer');
 const out=await page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type:'ashlar-can-close',jobId:'fix-A',runId:'run-A',provider:'chatgpt',kind:'fix'});
 assert.equal(out.canClose,true,out.reason);
});

test('real popup: a running review and tab-capacity blocker are shown together',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent(source('extension/popup.html').replace('<script src="popup.js"></script>',''));
 await page.evaluate(()=>{
  window.popupState={origin:'http://bridge',enabled:true,bridgeWorkerStatus:{origin:'http://bridge',phase:'reviewing',
   admissionPhase:'tab_capacity',activeJobs:1,recoveringJobs:0,pendingCleanup:0,savedReplies:0,checkedAt:1,admissionCheckedAt:1}};
  window.chrome={runtime:{getManifest:()=>({version:'1.1.17'})},storage:{local:{get:async()=>popupState},onChanged:{addListener(){}}}};
 });
 await page.addScriptTag({content:source('extension/popup.js')});
 await page.evaluate(()=>refreshDiagnostics());
 assert.match(await page.locator('#worker').textContent(),/Current review in progress/);
 assert.match(await page.locator('#worker').textContent(),/New requests: New tabs paused: review-tab capacity reached/);
 await page.evaluate(()=>{popupState.bridgeWorkerStatus.admissionPhase='idle';return refreshDiagnostics();});
 assert.match(await page.locator('#worker').textContent(),/Current review in progress/);
 assert.doesNotMatch(await page.locator('#worker').textContent(),/capacity reached/);
});
