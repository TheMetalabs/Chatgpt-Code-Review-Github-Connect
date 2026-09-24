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
 const page=await fixPage(t,`<p>I guarded the null path.</p><pre><code>${fixAnswer}</code></pre>`,undefined,{done:false});
 await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>window.fixOut)).pending,true,'Stop is visible: still generating');
 await page.evaluate(toolbar=>{document.querySelector('[data-testid="stop-button"]').remove();document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('beforeend',toolbar);},toolbar);
 await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>window.fixOut)).raw,fixAnswer);
});
test('real DOM: a cancelled fix tab is Ashlar-owned only until the user takes it over',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent('<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown">answer</div></div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div><button data-testid="send-button" aria-label="Send prompt">Send</button></form>');
 await page.evaluate(()=>{
  // conversation: the identity pinned when the sent turn was first proven exact (this page)
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A'],['ashlar:submission:fix-A:run-A',JSON.stringify({phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A',conversation:location.href})]]);
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
 const sentTurn=text=>page.evaluate(t=>{document.querySelector('[data-message-id="user-A"]').textContent=t;},text);
 await sentTurn('fix prompt and my own words');
 assert.equal((await cancel()).owned,false,'a sent turn the user edited to prompt + suffix is the user\'s');
 await sentTurn('my note: fix prompt');
 assert.equal((await cancel()).owned,false,'a sent turn the user edited to prefix + prompt is the user\'s');
 await sentTurn('fix prompt');
 // One proof for every fix decision (fixOwnershipProof): an edited sent turn is the user's for good,
 // even when the edit is undone (the collector has always treated it so; cancel now agrees).
 assert.equal((await cancel()).owned,false,'an edited turn stays the user\'s after the edit is undone');
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
 const presend=await cancel();
 assert.equal(presend.owned,true,'only Ashlar\'s own half-sent prompt is in the tab');
 assert.equal(presend.blank,true,'owned only because nothing is on the page: the worker also checks the page');
 const draft=text=>page.locator('#prompt-textarea').evaluate((el,t)=>{el.textContent=t;},text);
 await draft('my own question');
 assert.equal((await cancel()).owned,false,'no turn yet, but the composer holds the user\'s own text');
 await draft('fix prompt\nmy own private suffix');
 assert.equal((await cancel()).owned,false,'Ashlar\'s prompt plus user text is the user\'s: only the exact prompt is owned');
 await draft('my note: fix prompt');
 assert.equal((await cancel()).owned,false,'a user prefix is the user\'s too');
 await draft('fix prompt');
 await page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='fix prompt';document.querySelector('main').append(u);});
 const clicked=await cancel();
 assert.equal(clicked.owned,true,'the just-clicked, not yet confirmed turn is Ashlar\'s');
 assert.equal(clicked.blank,false,'Ashlar\'s exact prompt on the page proves ownership by content');
 assert.equal(clicked.unsent,true,'but not which page shows it (no bound conversation yet): the worker also checks the page');
 await draft('my own question');
 assert.equal((await cancel()).owned,false,'Ashlar\'s turn, but a user draft in the composer');
 await draft('');
 await page.evaluate(()=>{document.querySelector('[data-message-author-role="user"]').textContent='fix prompt and my own words';});
 assert.equal((await cancel()).owned,false,'a just-clicked turn with more than Ashlar\'s prompt preserves the tab');
 await page.evaluate(()=>{document.querySelector('[data-message-author-role="user"]').textContent='someone else asked this';});
 assert.equal((await cancel()).owned,false,'a turn that is not Ashlar\'s prompt preserves the tab');
});

/** A provider page served at a real chatgpt.com URL (so the SPA can move with history.pushState
 * while the old DOM stays rendered): this run's exact sent turn and a still-generating response,
 * its sent submission journal (no conversation pinned yet), and `kind`'s collector running. */
// CONV_URL: a conversation URL; TEMP_URL: the page a fix tab opens on (ChatGPT's temporary chat keeps
// this URL for its whole life, so it is the conversation's identity); NEW_URL: a bare new-chat page
// that names no conversation until the provider assigns one.
const CONV_URL='https://chatgpt.com/c/fix-conv',OTHER_URL='https://chatgpt.com/c/users-own-conv';
const TEMP_URL='https://chatgpt.com/?temporary-chat=true',NEW_URL='https://chatgpt.com/';
async function conversationPage(t,kind,{url=CONV_URL,jobId=kind==='fix'?'fix-A':'job-A',body=`<p>Here.</p><pre><code>${'{"findings":[],"merge_recommendation":"COMMENT","investigated_safe":["x"],"summary":"s","files":[]}'}</code></pre>`}={}){
 const page=await browser.newPage();t.after(()=>page.close());
 const html=`<html><body><main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown">${body}</div></div></section></main>${stop}<form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form></body></html>`;
 await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
 await page.clock.install();await page.goto(url);
 await page.evaluate(({jobId})=>{
  sessionStorage.setItem('ashlar:job',jobId);sessionStorage.setItem('ashlar:run','run-A');
  sessionStorage.setItem(`ashlar:submission:${jobId}:run-A`,JSON.stringify({phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A'}));
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
 },{jobId});
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type,jobId,runId:'run-A',provider:'chatgpt',...(kind==='fix'?{kind}:{}),...extra});
 await send('ashlar-run',{resume:true,prompt:'fix prompt'});
 await page.clock.runFor(1600); // generating: the collector observes its exact sent turn
 const journal=()=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),`ashlar:submission:${jobId}:run-A`);
 const move=async url=>{await page.evaluate(url=>history.pushState({},'',url),url);};
 const complete=()=>page.evaluate(toolbar=>{document.querySelector('[data-testid="stop-button"]').remove();document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('beforeend',toolbar);},toolbar);
 return {page,send,journal,move,complete,harvest:()=>send('ashlar-harvest')};
}
/** The real worker wired to that page over the message protocol: the fix job is started in tab 10. */
function wiredWorker(page,serverStatus){
 const job={jobId:'fix-A',kind:'fix',origin:'http://bridge',leaseId:'lease-A',prompt:'fix prompt',providers:['chatgpt'],reasoning:{chatgpt:'pro',grok:'heavy'},
  states:{chatgpt:{tabId:10,started:true,runId:'run-A'}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{'fix-A':job}}),
  tabs:new Map([[10,{id:10,url:page.url(),status:'complete'}]]),
  api:async(_path,body)=>body?.action==='ping'?{ok:true,active:serverStatus.value==='awaiting_chat',accepted:serverStatus.value==='awaiting_chat',status:serverStatus.value,bridge:{captureProtocol:1,localJsonRepairEnabled:false}}:{ok:true,job:null}});
 b.chrome.tabs.sendMessage=(id,msg,callback)=>{
  b.messages.push({id,...msg});
  page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),msg).then(callback,error=>{
   b.chrome.runtime.lastError={message:error.message};callback();b.chrome.runtime.lastError=null;
  });
 };
 // The tab's URL follows the page (an in-page pushState is a tab URL update in Chrome).
 const sync=()=>{b.tabs.get(10).url=page.url();};
 return {b,sync,state:()=>b.local.state.pendingReviewJobs['fix-A']?.states.chatgpt};
}
for(const url of [CONV_URL,TEMP_URL]){
test(`real DOM: a cancelled fix whose tab moved in-page from ${url} to another conversation (old DOM still rendered) is preserved, never closed`,async t=>{
 const {page,send,journal,move}=await conversationPage(t,'fix',{url});
 const server={value:'awaiting_chat'};
 const {b,sync,state}=wiredWorker(page,server);
 await b.tick();
 const pinned={page:(await journal()).conversation,worker:state().conversation};
 // The user clicks another conversation: the SPA URL changes, the fix's DOM is still on screen.
 await move(OTHER_URL);sync();
 const direct=await send('ashlar-fix-cancel');
 assert.equal(direct.owned,false,'the content still proves the fix, but not in this conversation');
 assert.equal(direct.ownership,'unknown');assert.equal(direct.identity,'changed');
 assert.equal(direct.url,OTHER_URL);assert.equal(direct.conversation,url);
 server.value='cancelled';
 await b.tick();
 assert.deepEqual(b.closedTabs,[],'the user\'s conversation is never closed');
 assert.equal(state(),undefined,'the cancelled fix retired');
 assert.equal((await send('ashlar-tab-status')).released,true,'the preserved tab frees its managed slot');
 assert.ok(b.messages.some(m=>m.type==='ashlar-fix-cancel'&&m.preserve===true),'the page was told it is preserved');
 assert.deepEqual(pinned,{page:url,worker:url},'the exact sent turn pinned its conversation (page journal) and the worker kept it');
});
test(`real DOM: a cancelled fix still in its bound conversation ${url} is closed (control)`,async t=>{
 const {page,journal}=await conversationPage(t,'fix',{url});
 assert.equal((await journal()).conversation,url);
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(page,server);
 await b.tick();
 server.value='cancelled';
 await b.tick();
 assert.deepEqual(b.closedTabs,[10],'identity unchanged: the fix tab is closed');
 assert.equal(state(),undefined);
});
}
test('real DOM: a fix whose tab moved away and back to its bound conversation is Ashlar\'s again; the pin is never replaced',async t=>{
 const {page,send,journal,move}=await conversationPage(t,'fix');
 await move(OTHER_URL);await page.clock.runFor(1600); // the collector keeps seeing the exact turn there
 assert.equal((await journal()).conversation,CONV_URL,'a conversation URL is never re-pinned');
 assert.equal((await send('ashlar-fix-cancel')).identity,'changed');
 await move(CONV_URL);
 const back=await send('ashlar-fix-cancel');
 assert.equal(back.owned,true);assert.equal(back.conversation,CONV_URL);
 assert.equal((await journal()).conversation,CONV_URL,'pinned once, never replaced');
});

// Ashlar 4096068011: a fix pinned on a bare new-chat page is never re-pinned by a location. The user
// can open another existing conversation before the provider assigns one (the old DOM stays on
// screen), and nothing in either provider's DOM ties a conversation id to the sent turn or its
// response, so a later URL is unknown: never harvested, never closed, preserved on cancel.
test('real DOM: a fix pinned on a bare new-chat page that moves to another conversation is never re-pinned, harvested or closed',async t=>{
 const {page,send,journal,move,complete,harvest}=await conversationPage(t,'fix',{url:NEW_URL});
 assert.equal((await journal()).conversation,NEW_URL,'bound on a page that names no conversation yet');
 const server={value:'awaiting_chat'};
 const {b,sync,state}=wiredWorker(page,server);
 await b.tick();
 assert.equal(state().conversation,NEW_URL);
 // the user opens one of their own conversations before any provider-assigned URL was observed
 await move(OTHER_URL);sync();await page.clock.runFor(1600);
 assert.equal((await journal()).conversation,NEW_URL,'never pinned to the conversation the user moved to');
 await complete();await page.clock.runFor(3200); // the lingering DOM completes there
 assert.notEqual((await harvest()).ok,true,'not harvested outside its pinned conversation');
 const closing=await send('ashlar-can-close');
 assert.equal(closing.canClose,false);
 await b.tick();
 assert.equal(state().conversation,NEW_URL,'the worker never follows a location either');
 assert.equal(b.calls.some(c=>c.action==='complete'),false,'no answer is delivered');
 assert.deepEqual(b.closedTabs,[],'the tab stays open');
 server.value='cancelled';await b.tick();
 assert.deepEqual(b.closedTabs,[],'cancelled: preserved, never closed');
 assert.equal(state(),undefined,'the cancelled fix retired');
 assert.equal((await send('ashlar-tab-status')).released,true,'the preserved tab frees its managed slot');
});

// Ashlar 4096068000: a completed fix whose sent turn the user edits after collection is never
// handed out or closed; its tab is released and preserved (fixOwnershipProof "complete").
for(const edit of ['fix prompt and my own words','my note: fix prompt']){
test(`real DOM: a fix collected, then its sent turn edited to "${edit}": never delivered or closed, slot released, tab preserved`,async t=>{
 const {page,send,complete}=await conversationPage(t,'fix');
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(page,server);
 await b.tick();
 await complete();await page.clock.runFor(3200); // the page collected the answer (generation done)
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.result?.ok),true,'collected by the page');
 await page.evaluate(t=>{document.querySelector('[data-message-id="user-A"]').textContent=t;},edit);
 await b.tick();
 assert.equal(b.calls.some(c=>c.action==='complete'),false,'the answer is not handed out from the edited tab');
 const closing=await send('ashlar-can-close');
 assert.equal(closing.canClose,false);assert.equal(closing.reason,'repurposed');
 assert.equal((await send('ashlar-tab-status')).released,true,'the slot is released');
 server.value='cancelled';await b.tick();
 assert.deepEqual(b.closedTabs,[],'the worker never removes the tab');
 assert.equal(state(),undefined,'the fix retired with its tab preserved');
});
test(`real DOM: a fix delivered, then its sent turn edited to "${edit}": can-close refuses, the worker preserves the tab`,async t=>{
 const {page,send,complete}=await conversationPage(t,'fix');
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(page,server);
 // the worker takes the answer and delivers it, but its cleanup is held until after the edit
 const cleanup=b.context.cleanupProvider;b.context.cleanupProvider=async()=>{};
 await complete();await page.clock.runFor(3200);await b.tick();
 assert.equal(b.calls.some(c=>c.action==='complete'),true,'delivered while the proof held');
 await page.evaluate(t=>{document.querySelector('[data-message-id="user-A"]').textContent=t;},edit);
 b.context.cleanupProvider=cleanup;
 await b.tick();
 assert.deepEqual(b.closedTabs,[],'never closed');
 assert.equal(state(),undefined,'the delivered fix retired with its tab preserved');
 assert.equal((await send('ashlar-tab-status')).released,true);
});
}

// ── The fix ownership proof at EVERY page decision point (conformance rows P19-P23): the same
// violations of the full proof (fixOwnershipProof) against each decision, with a control. A cell
// is `true` when the decision acts for Ashlar (collects, hands out, closes, restores, force-closes).
const PROOF_VIOLATIONS={
 none:null,
 editedSuffix:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='fix prompt and my own words';}),
 editedPrefix:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='my note: fix prompt';}),
 followup:({page})=>page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='personal follow-up';document.querySelector('main').append(u);}),
 draft:({page})=>page.locator('#prompt-textarea').evaluate(el=>{el.textContent='my own question';}),
 moved:({move})=>move(OTHER_URL),
 responseChanged:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="response-A"] code').textContent='{"summary":"regenerated","files":[]}';}),
};
const PROOF_DECISIONS={
 // P19 collect: the violation is present when the answer completes
 collect:async ctx=>{await PROOF_VIOLATIONS[ctx.violation]?.(ctx);await ctx.complete();await ctx.page.clock.runFor(3200);return (await ctx.harvest()).ok===true;},
 // P20 hand out a collected answer (ashlar-harvest / ashlar-run reply)
 handOut:async ctx=>{await ctx.complete();await ctx.page.clock.runFor(3200);await PROOF_VIOLATIONS[ctx.violation]?.(ctx);return (await ctx.harvest()).ok===true;},
 // P21 close after completion (can-close)
 canClose:async ctx=>{await ctx.complete();await ctx.page.clock.runFor(3200);await ctx.harvest();await PROOF_VIOLATIONS[ctx.violation]?.(ctx);return (await ctx.send('ashlar-can-close')).canClose===true;},
 // P22 restore a completion proof after a reload (ashlar-result-saved)
 restore:async ctx=>{
  await ctx.complete();await ctx.page.clock.runFor(3200);const out=await ctx.harvest();
  await ctx.page.evaluate(()=>{const s=__ashlarRunnerState;s.result=null;s.nativeCompletion=undefined;s.restoredCompletion=false;});
  await PROOF_VIOLATIONS[ctx.violation]?.(ctx);
  return (await ctx.send('ashlar-result-saved',{committed:true,raw:out.raw,text:out.responseText,completion:out.completion})).accepted===true;
 },
 // P23 force-close on cancel (ashlar-fix-cancel)
 cancel:async ctx=>{await PROOF_VIOLATIONS[ctx.violation]?.(ctx);return (await ctx.send('ashlar-fix-cancel')).owned===true;},
};
// A changed response is a violation only once a completion is stored; the collector and the
// cancel proof have none to compare with.
const PROOF_NA={collect:['responseChanged'],cancel:['responseChanged']};
for(const [decision,act] of Object.entries(PROOF_DECISIONS)){
 test(`real DOM fix ownership proof at ${decision}: only the full proof acts, every violation is refused`,async t=>{
  const got={},want={};
  for(const violation of Object.keys(PROOF_VIOLATIONS)){
   if(PROOF_NA[decision]?.includes(violation))continue;
   const ctx=await conversationPage(t,'fix');
   got[violation]=await act({...ctx,violation});
   want[violation]=violation==='none';
  }
  assert.deepEqual(got,want);
 });
}

/** A fix run's page: this run's user turn (user-A) and an assistant response (response-A) with
 * `inner`, plus its submission journal (`journal` null = none yet). */
async function fixPage(t,inner,journal={phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A'},{done=true}={}){
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 await page.setContent(`<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown">${inner}</div></div>${done?'<button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button>':''}</section></main>${done?'':stop}<form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form>`);
 await page.evaluate(journal=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A'],...(journal?[['ashlar:submission:fix-A:run-A',JSON.stringify(journal)]]:[])]);
  window.__saved=saved;
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
 },journal);
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 await page.evaluate(()=>{const s=__ashlarRunnerState;s.kind='fix';s.running=true;window.fixOut={pending:true};
  waitUntilFixOrQuota('ChatGPT').then(raw=>{window.fixOut={raw};},e=>{window.fixOut={error:e.message};});});
 return page;
}

// ── Page conformance: the SAME page scenario for a review run and a fix run (the P rows of the
// review/fix conformance table; W rows: kind-conformance.test.mjs, S rows:
// bridge-lease-conformance.test.mjs). A shared cell asserts one outcome for both kinds; an intended
// difference asserts each kind's documented outcome.
const KIND_ANSWER='{"findings":[],"merge_recommendation":"COMMENT","investigated_safe":["fixture checked"],"summary":"s","files":[]}';
async function kindPage(t,kind,{done=true,journal={phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A'},extra=''}={}){
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 await page.setContent(`<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><p>Here.</p><pre><code>${KIND_ANSWER}</code></pre></div></div>${done?toolbar:''}</section></main>${done?'':stop}${extra}<form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form>`);
 await page.evaluate(journal=>{
  const saved=new Map([['ashlar:job','job-A'],['ashlar:run','run-A'],...(journal?[['ashlar:submission:job-A:run-A',JSON.stringify(journal)]]:[])]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
 },journal);
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type,jobId:'job-A',runId:'run-A',provider:'chatgpt',...(kind==='fix'?{kind}:{}),...extra});
 await send('ashlar-run',{resume:true,prompt:'fix prompt'});
 return {page,send,harvest:()=>send('ashlar-harvest')};
}
for(const kind of ['review','fix']){
 test(`real DOM conformance (${kind}): the bound answer is harvested after completion and its tab may close`,async t=>{
  const {page,harvest,send}=await kindPage(t,kind);
  await page.clock.runFor(3200);
  const out=await harvest();
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.equal(JSON.parse(out.raw).summary,'s','the fenced answer (review: its JSON; fix: its code)');
  assert.equal((await send('ashlar-can-close')).canClose,true);
  // P6: a draft the user typed afterwards hands the tab back to the user, for both kinds
  await page.locator('#prompt-textarea').evaluate(el=>{el.textContent='my own question';});
  const draft=await send('ashlar-can-close');
  assert.equal(draft.canClose,false);assert.equal(draft.reason,'repurposed');
  assert.equal((await page.evaluate(()=>new Promise(resolve=>receiver({type:'ashlar-tab-status'},null,resolve)))).released,true,'the repurposed tab frees its managed slot');
 });
 test(`real DOM conformance (${kind}): a visible quota banner before any answer ends the run as quota`,async t=>{
  const {page,harvest}=await kindPage(t,kind,{done:false,extra:'<div role="alert">usage limit reached</div>'});
  await page.clock.runFor(3200);
  assert.equal((await harvest()).code,'quota');
 });
 test(`real DOM conformance (${kind}): a follow-up turn repurposes the tab; nothing is harvested from it`,async t=>{
  const {page,harvest}=await kindPage(t,kind,{done:false});
  await page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='personal follow-up';document.querySelector('main').append(u);});
  await page.clock.runFor(3200);
  assert.equal((await harvest()).code,'busy','no answer from a repurposed conversation');
  assert.equal(await page.evaluate(()=>__ashlarRunnerState.tabRepurposed),true);
 });
 test(`real DOM conformance (${kind}): harvest acceptance of an unbound page and of an edited sent turn`,async t=>{
  // P3: no sent journal. A review keeps its legacy unbound observation; a fix reads nothing.
  const unbound=await kindPage(t,kind,{journal:null});
  await unbound.page.clock.runFor(3200);
  assert.equal((await unbound.harvest()).ok===true,kind==='review',`${kind}: unbound harvest`);
  // P5: the user edited the sent turn around Ashlar's prompt. Containment still binds it; a review
  // tolerates the edit (intended, see the table), a fix needs the exact prompt and never harvests.
  const edited=await kindPage(t,kind,{done:false});
  await edited.page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='my note: fix prompt';});
  await edited.page.evaluate(toolbar=>{document.querySelector('[data-testid="stop-button"]').remove();document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('beforeend',toolbar);},toolbar);
  await edited.page.clock.runFor(3200);
  assert.equal((await edited.harvest()).ok===true,kind==='review',`${kind}: edited-turn harvest`);
 });
}

for(const kind of ['review','fix']){
 test(`real DOM conformance (${kind}): after its answer is collected, an in-page move to another conversation hands the tab back`,async t=>{
  const {page,send,move,complete,harvest}=await conversationPage(t,kind);
  await complete();await page.clock.runFor(3200);
  assert.equal((await harvest()).ok,true,'collected in its own conversation');
  assert.equal((await send('ashlar-can-close')).canClose,true);
  await move(OTHER_URL); // the old DOM stays rendered under the user's conversation URL
  const moved=await send('ashlar-can-close');
  assert.equal(moved.canClose,false);assert.equal(moved.reason,'repurposed');
 });
 test(`real DOM conformance (${kind}): an in-page move while generating, then the old DOM completes`,async t=>{
  const {page,send,move,complete,harvest}=await conversationPage(t,kind);
  await move(OTHER_URL);await complete();await page.clock.runFor(3200);
  const out=await harvest();
  const canClose=(await send('ashlar-can-close')).canClose;
  // Intended difference (W/P table row P16): a fix answer is read only in the conversation its run
  // was bound in. FLAG R4 (review, unchanged here): a review still harvests the lingering DOM and
  // records its completion context under the new URL, so its can-close then passes there.
  assert.deepEqual({ok:out.ok===true,canClose},kind==='fix'?{ok:false,canClose:false}:{ok:true,canClose:true});
 });
}

test('real DOM: a fix is harvested only from the response bound to its own sent prompt',async t=>{
 const code='{"summary":"unrelated","files":[{"path":"a.ts","content":"x"}]}';
 const unrelated=`<p>Earlier answer.</p><pre><code>${code}</code></pre>`;
 for(const journal of [null,{phase:'attempted',expected:'fix prompt',baseline:0}]){
  const page=await fixPage(t,unrelated,journal);
  await page.clock.runFor(6400);
  assert.deepEqual(await page.evaluate(()=>window.fixOut),{pending:true},`no answer without a sent, identified submission (${journal?journal.phase:'no journal'})`);
 }
 // the same page once the journal binds this run's turn: its response is the answer
 const page=await fixPage(t,unrelated,{phase:'attempted',expected:'fix prompt',baseline:0});
 await page.clock.runFor(3200);
 await page.evaluate(()=>window.__saved.set('ashlar:submission:fix-A:run-A',JSON.stringify({phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A'})));
 await page.clock.runFor(3200);
 assert.equal((await page.evaluate(()=>window.fixOut)).raw,code);
});

test('real DOM: a fix is never harvested from a sent turn the user edited around the prompt',async t=>{
 const code='{"summary":"guard","files":[{"path":"a.ts","content":"x"}]}';
 const inner=`<p>Here.</p><pre><code>${code}</code></pre>`;
 for(const edit of ['fix prompt and my own words','my note: fix prompt']){
  const page=await fixPage(t,inner);
  await page.evaluate(t=>{document.querySelector('[data-message-id="user-A"]').textContent=t;},edit);
  await page.clock.runFor(6400);
  assert.deepEqual(await page.evaluate(()=>window.fixOut),{pending:true},`an edited sent turn (${edit}) never yields a fix answer`);
  assert.equal(await page.evaluate(()=>__ashlarRunnerState.tabRepurposed),true,'the edited tab is repurposed');
  await page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='fix prompt';});
  await page.clock.runFor(6400);
  assert.deepEqual(await page.evaluate(()=>window.fixOut),{pending:true},'undoing the edit does not revive the harvest');
 }
 const control=await fixPage(t,inner);
 await control.clock.runFor(3200);
 assert.equal((await control.evaluate(()=>window.fixOut)).raw,code,'the exact sent prompt still harvests');
 assert.notEqual(await control.evaluate(()=>__ashlarRunnerState.tabRepurposed),true);
});

test('real DOM: a fix is read from its fenced code block literally, never from rendered prose',async t=>{
 // What ChatGPT renders for the same JSON: unfenced it is markdown (the escaped \\n loses a
 // backslash, *x* becomes emphasis, __init__ bold) yet still parses; fenced it is literal code.
 const literal='{"summary":"s","files":[{"path":"a.py","content":"print(\\"a\\\\nb\\") # *x* __init__"}]}';
 const prose='{"summary":"s","files":[{"path":"a.py","content":"print(\\"a\\nb\\") # <em>x</em> <strong>init</strong>"}]}';
 const code=`<pre><div>json</div><button>Copy code</button><div><code class="language-json">${literal.replace(/</g,'&lt;')}</code></div></pre>`;
 const page=await fixture(t,user+answer(`<p>Here is the fix.</p>${code}`,true));
 assert.deepEqual(await page.evaluate(()=>assistantCodeBlocks()),[literal]);
 const unfenced=await fixPage(t,`<p>${prose}</p>`);
 assert.deepEqual(await unfenced.evaluate(()=>assistantCodeBlocks()),[],'rendered prose is never read as a fix');
 await unfenced.clock.runFor(3200);
 const out=await unfenced.evaluate(()=>window.fixOut);
 assert.match(out.raw,/no fenced code block/);assert.ok(!out.raw.includes('{'),'no JSON reaches the fix parser');
});

test('real DOM: a hidden or stale code block the renderer kept is never part of a fix answer',async t=>{
 const visible='{"summary":"new","files":[]}';
 const page=await fixture(t,user+answer(`<pre hidden><code>{"summary":"stale-hidden"}</code></pre><div style="display:none"><pre><code>{"summary":"stale-none"}</code></pre></div><pre style="opacity:0"><code>{"summary":"stale-transparent"}</code></pre><pre><code>${visible}</code></pre>`,true));
 assert.deepEqual(await page.evaluate(()=>assistantCodeBlocks()),[visible]);
});

test('real DOM: a stale hidden <code> inside a visible block is never read; the visible one is, with review visibility rules',async t=>{
 const visible='{"summary":"new","files":[]}';
 const page=await fixture(t,user+answer(`<pre><div>json<button>Copy code</button></div><code hidden>{"summary":"stale-hidden"}</code><code aria-hidden="true">{"summary":"stale-aria"}</code><code style="display:none">{"summary":"stale-none"}</code><code>${visible}<span aria-hidden="true">{"stale":"inner"}</span></code></pre>`+
  `<pre><code hidden>{"summary":"all-hidden"}</code></pre><pre>plain pre</pre><pre>  </pre>`,true));
 assert.deepEqual(await page.evaluate(()=>assistantCodeBlocks()),[visible,'plain pre'],'only visible code (and a bare pre); a block whose code is all hidden yields nothing');
 assert.deepEqual(await page.evaluate(()=>assistantCodeBlocks(null)),[]);
 // the review corpus applies the same visibility rule to the same turn
 const corpus=await page.evaluate(()=>assistantCorpus().join('\n'));
 for(const stale of ['stale-hidden','stale-aria','stale-none','"stale":"inner"','all-hidden','Copy code'])assert.ok(!corpus.includes(stale),stale);
 assert.ok(corpus.includes(visible));
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
