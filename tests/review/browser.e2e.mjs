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
// The page already shows the sent turn: it is bound to the run (a new run is refused there, X2 #85).
const boundTo=(page,jobId,runId='')=>page.evaluate(([jobId,runId])=>{window.__ashlarRunnerState={running:false,jobId,runId,result:null};},[jobId,runId]);
test('real DOM: harvest does not expose provisional JSON while the runner is busy',async t=>{
 const page=await fixture(t,user+answer(json)+stop);await boundTo(page,'j');await page.addScriptTag({content:source('extension/content-chatgpt.js')});
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
 await boundTo(page,'A','run-A');await page.addScriptTag({content:source('extension/content-chatgpt.js')});
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
// Review-loop FIX items: plain-text answers (no review JSON), and a cancel that only releases (a fix
// tab is closed only on the proven-success path).
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
// A cancel never authorises a close: whatever the page shows (Ashlar's untouched answer, a draft, an
// edited turn, a follow-up, a page before its send is confirmed), ashlar-fix-cancel stops the run
// and frees the managed slot, and its reply carries no ownership verdict for the worker to act on.
const CANCEL_PAGES={
 bound:{html:'<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown">answer</div></div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main>',
  journal:{phase:'sent',expected:'fix prompt',exact:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A',conversation:'about:blank'}},
 draft:{html:'<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section></main>',draft:'my own question',
  journal:{phase:'sent',expected:'fix prompt',exact:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A',conversation:'about:blank'}},
 edited:{html:'<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt and my own words</div></section></main>',
  journal:{phase:'sent',expected:'fix prompt',exact:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A',conversation:'about:blank'}},
 unsent:{html:'<main></main>',draft:'fix prompt',journal:{phase:'attempted',expected:'fix prompt',baseline:0}},
 blank:{html:'<main></main>',journal:null},
};
for(const [name,cell] of Object.entries(CANCEL_PAGES)){
test(`real DOM: ashlar-fix-cancel on a ${name} fix page releases the slot and stops the run; it never carries an ownership verdict`,async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent(`${cell.html}<form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px">${cell.draft||''}</div></form>`);
 await page.evaluate(journal=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A'],...(journal?[['ashlar:submission:fix-A:run-A',JSON.stringify(journal)]]:[])]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
 },cell.journal);
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type,jobId:'fix-A',runId:'run-A',provider:'chatgpt',kind:'fix',...extra});
 assert.equal((await send('ashlar-fix-cancel',{jobId:'fix-B'})).code,'job_mismatch','another run is never touched');
 const out=await send('ashlar-fix-cancel',{preserve:true});
 assert.equal(out.ok,true);assert.equal(out.released,true);
 assert.deepEqual(['owned','ownership','blank','unsent','identity'].filter(key=>key in out),[],'no verdict a close could rest on');
 assert.equal((await send('ashlar-tab-status')).released,true,'the managed slot is freed');
 // (#82's stop fence: the run is stopped for good, nothing is sent or collected for it again)
 assert.equal(await page.evaluate(()=>__ashlarRunnerState.runStopped),true,'the collector stops');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('ashlar:stopped:fix-A:run-A')),'true','the stop survives a reload');
});
}

/** A provider page served at a real chatgpt.com URL (so the SPA can move with history.pushState
 * while the old DOM stays rendered), with `kind`'s runner resumed on it. `sent` is how its send
 * came about:
 *  - "click" (default): the composer holds the prompt and the journal is only prepared; the runner's
 *    clickSend clicks Send, the page renders this run's exact sent turn and a still-generating
 *    response, and submissionConfirmed proves the send and records the conversation shown then;
 *  - "legacy": the turn is already rendered and the journal is sent WITHOUT a conversation (a
 *    journal recorded before the send-time identity existed);
 *  - "reload": the turn is already rendered and the journal is only `attempted`: the click belonged
 *    to an earlier page, so this page sees the send confirmed only after a reload.
 * `gated`: the runner waits after the send is confirmed until `openCollect()`, so a test can act
 * between the send proof and the collector's first poll. `userId`: the sent turn's message ID when it
 * renders (null: the renderer has assigned none yet). */
// CONV_URL: a conversation URL; TEMP_URL: the page a fix tab opens on (ChatGPT's temporary chat keeps
// this URL for its whole life, so it is the conversation's identity); NEW_URL: a bare new-chat page
// that names no conversation until the provider assigns one.
const CONV_URL='https://chatgpt.com/c/fix-conv',OTHER_URL='https://chatgpt.com/c/users-own-conv';
const TEMP_URL='https://chatgpt.com/?temporary-chat=true',NEW_URL='https://chatgpt.com/';
async function conversationPage(t,kind,{url=kind==='fix'?TEMP_URL:CONV_URL,jobId=kind==='fix'?'fix-A':'job-A',sent='click',gated=false,userId='user-A',body=`<p>Here.</p><pre><code>${'{"findings":[],"merge_recommendation":"COMMENT","investigated_safe":["x"],"summary":"s","files":[]}'}</code></pre>`}={}){
 const page=await browser.newPage();t.after(()=>page.close());
 const turns=`<section data-testid="conversation-turn-1"><div data-message-author-role="user"${userId?` data-message-id="${userId}"`:''}>fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown">${body}</div></div></section>`;
 const html=sent==='click'
  ?`<html><body><main></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px">fix prompt</div><button data-testid="send-button" aria-label="Send prompt" style="width:60px;height:30px">Send</button></form></body></html>`
  :`<html><body><main>${turns}</main>${stop}<form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form></body></html>`;
 await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
 await page.clock.install();await page.goto(url);
 const journals={click:{phase:'prepared',expected:'fix prompt',exact:'fix prompt',baseline:0,attachments:[]},
  legacy:{phase:'sent',expected:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A'},
  reload:{phase:'attempted',expected:'fix prompt',baseline:0,attachments:[]}};
 await page.evaluate(({jobId,journal,turns,stop})=>{
  sessionStorage.setItem('ashlar:job',jobId);sessionStorage.setItem('ashlar:run','run-A');
  sessionStorage.setItem(`ashlar:submission:${jobId}:run-A`,JSON.stringify(journal));
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
  // The provider accepts the prompt: its turn and a still-generating response render, Stop replaces Send.
  document.querySelector('[data-testid="send-button"]')?.addEventListener('click',event=>{
   window.sendClicks=(window.sendClicks||0)+1;
   document.querySelector('main').innerHTML=turns;document.querySelector('#prompt-textarea').textContent='';
   event.currentTarget.remove();document.body.insertAdjacentHTML('beforeend',stop);
  });
 },{jobId,journal:journals[sent],turns,stop});
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 if(gated)await page.evaluate(()=>{
  window.collectGate=new Promise(resolve=>{window.openCollect=resolve;});
  // content-chatgpt.js's resume path (resumeSubmission, then the collector) with a pause between.
  runPrompt=async prompt=>{await resumeSubmission(sendButton,composer,prompt);window.sendConfirmed=true;await window.collectGate;return waitUntilReviewOrQuota('ChatGPT');};
 });
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type,jobId,runId:'run-A',provider:'chatgpt',...(kind==='fix'?{kind}:{}),...extra});
 await send('ashlar-run',{resume:true,prompt:'fix prompt'});
 await page.clock.runFor(1600); // the send is confirmed; ungated, the collector observes the generating response
 const journal=()=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),`ashlar:submission:${jobId}:run-A`);
 const move=async url=>{await page.evaluate(url=>history.pushState({},'',url),url);};
 const complete=()=>page.evaluate(toolbar=>{document.querySelector('[data-testid="stop-button"]').remove();document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('beforeend',toolbar);},toolbar);
 return {page,send,journal,move,complete,harvest:()=>send('ashlar-harvest'),openCollect:()=>page.evaluate(()=>window.openCollect())};
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
for(const moved of [true,false]){
const url=TEMP_URL; // a fix tab always opens on the temporary chat
test(`real DOM: a cancelled fix ${moved?'whose tab moved in-page from '+url+' to another conversation (old DOM still rendered)':'still in its bound conversation '+url} is preserved, never closed`,async t=>{
 const {page,send,journal,move}=await conversationPage(t,'fix',{url});
 const server={value:'awaiting_chat'};
 const {b,sync,state}=wiredWorker(page,server);
 await b.tick();
 const pinned={page:(await journal()).conversation,worker:state().conversation};
 // The user clicks another conversation: the SPA URL changes, the fix's DOM is still on screen.
 if(moved){await move(OTHER_URL);sync();}
 server.value='cancelled';
 await b.tick();
 assert.deepEqual(b.closedTabs,[],'a cancel never closes a fix tab');
 assert.equal(state(),undefined,'the cancelled fix retired');
 assert.equal((await send('ashlar-tab-status')).released,true,'the preserved tab frees its managed slot');
 assert.ok(b.messages.some(m=>m.type==='ashlar-fix-cancel'&&m.preserve===true),'the page was told it is preserved');
 assert.deepEqual(pinned,{page:url,worker:url},'the send recorded its conversation (page journal) and the worker kept it');
});
}

// Round 11 lifecycle: moving off the send-time conversation is a PERMANENT verdict (a recorded identity
// never comes back by waiting): the run ends at once and moving back does not revive it.
test('real DOM: a fix whose tab moved away from its bound conversation ends at once, stays ended after moving back; the recorded identity is never replaced',async t=>{
 const {page,send,journal,move}=await conversationPage(t,'fix');
 await move(OTHER_URL);await page.clock.runFor(1600); // the collector sees the exact turn under another URL
 assert.equal((await journal()).conversation,TEMP_URL,'the send-time identity is never re-recorded');
 const ended=await send('ashlar-harvest');
 assert.equal(ended.code,'taken_over','the run ended now, not at the fix deadline');
 assert.equal((await send('ashlar-tab-status')).released,true,'its managed slot is freed');
 await move(TEMP_URL);
 assert.equal((await send('ashlar-can-close')).reason,'repurposed','moving back does not hand the tab to the ended run');
 assert.equal((await send('ashlar-harvest')).code,'taken_over');
 assert.equal((await journal()).conversation,TEMP_URL,'recorded once, never replaced');
});

// Round 13 (Ashlar 4099207116): a fix's conversation identity is a fact of the moment its send is
// proven. composer.js submissionConfirmed records it then (in the journal, once); the collector,
// can-close, cancel and restore only compare with it. Each row: how the send came about, and whether
// the user moved the tab in-page (history.pushState) after the send was proven and BEFORE the
// collector's first poll, with the old DOM still rendered; then the old response finishes. The real
// page and the real worker over the message protocol.
//  - click: the send is confirmed on this page, which records its conversation (control when unmoved);
//  - legacy: a sent journal with no conversation (recorded before this rule);
//  - reload: the click belonged to an earlier page; this page confirms the send only after a reload;
//  - root / conversation: sent anywhere but the temporary chat (a bare new-chat root, an existing
//    conversation): a fix tab always opens on the temporary chat, whose URL never changes, so a
//    send-time identity that is not that page is unknown for good, even where the page never moved.
const SEND_IDENTITY_ROWS=[
 {sent:'click',url:TEMP_URL,moveTo:null,recorded:TEMP_URL,owned:true},
 {sent:'click',url:TEMP_URL,moveTo:OTHER_URL,recorded:TEMP_URL,owned:false},
 {sent:'click',url:CONV_URL,moveTo:OTHER_URL,recorded:CONV_URL,owned:false},
 {sent:'click',url:CONV_URL,moveTo:null,recorded:CONV_URL,owned:false,name:'conversation'},
 {sent:'legacy',url:TEMP_URL,moveTo:null,recorded:undefined,owned:false},
 {sent:'legacy',url:TEMP_URL,moveTo:OTHER_URL,recorded:undefined,owned:false},
 {sent:'reload',url:TEMP_URL,moveTo:null,recorded:undefined,owned:false},
 {sent:'reload',url:TEMP_URL,moveTo:OTHER_URL,recorded:undefined,owned:false},
 {sent:'click',url:NEW_URL,moveTo:null,recorded:NEW_URL,owned:false,name:'root'},
 {sent:'click',url:NEW_URL,moveTo:CONV_URL,recorded:NEW_URL,owned:false,name:'root'},
];
for(const row of SEND_IDENTITY_ROWS){
 const name=`${row.name||row.sent} on ${row.url}${row.moveTo?`, moved to ${row.moveTo} before the collector's first poll`:', never moved'}`;
 test(`real DOM send-time identity (${name}): ${row.owned?'harvested and closed (control)':'never harvested, can-close refused, released, never removed'}`,async t=>{
  const ctx=await conversationPage(t,'fix',{url:row.url,sent:row.sent,gated:true});
  const server={value:'awaiting_chat'};
  const {b,sync,state}=wiredWorker(ctx.page,server);
  assert.equal(await ctx.page.evaluate(()=>window.sendConfirmed),true,'the send is proven before the collector starts');
  assert.equal(await ctx.page.evaluate(()=>window.sendClicks||0),row.sent==='click'?1:0,'the prompt is clicked once, and only by the page that sends it');
  const atSend=await ctx.journal();
  assert.equal(atSend.phase,'sent');
  if(row.moveTo){await ctx.move(row.moveTo);sync();}
  await ctx.openCollect();await ctx.page.clock.runFor(1600); // the collector's first polls (old DOM still rendered)
  await ctx.complete();await ctx.page.clock.runFor(3200);      // the old response finishes
  const harvest=await ctx.harvest();
  const closing=await ctx.send('ashlar-can-close');
  await b.tick();await b.tick();
  const failure=b.calls.find(c=>c.action==='failure');
  const got={harvested:harvest.ok===true,canClose:closing.canClose===true,delivered:b.calls.some(c=>c.action==='complete'),
   takenOver:/^taken_over: /.test(failure?.error||''),closed:b.closedTabs.length,retired:state()===undefined,
   released:(await ctx.send('ashlar-tab-status')).released,
   // the identity is recorded when the send is proven, and only then (never at the collector's poll)
   atSend:atSend.conversation,recorded:(await ctx.journal()).conversation};
  assert.deepEqual(got,row.owned
   ?{harvested:true,canClose:true,delivered:true,takenOver:false,closed:1,retired:true,released:false,atSend:row.recorded,recorded:row.recorded}
   :{harvested:false,canClose:false,delivered:false,takenOver:true,closed:0,retired:true,released:true,atSend:row.recorded,recorded:row.recorded});
 });
}

// Round 13 sweep: a message ID the renderer assigns to the sent turn after mounting is recorded in a
// fix journal only while the page still shows the conversation its send was proven in; after an
// in-page move, the turn at the recorded position proves nothing about the send. (A review journal
// carries no conversation and keeps its late-ID upgrade unchanged.)
for(const moved of [false,true]){
 test(`real DOM: a late message ID on a fix's sent turn is ${moved?'never recorded after an in-page move':'recorded in its send-time conversation (control)'}`,async t=>{
  const ctx=await conversationPage(t,'fix',{url:TEMP_URL,userId:null,gated:true});
  assert.equal((await ctx.journal()).messageId,'','the turn had no ID when the send was proven');
  if(moved)await ctx.move(OTHER_URL);
  await ctx.page.evaluate(()=>{document.querySelector('[data-message-author-role="user"]').dataset.messageId='late-id';});
  await ctx.openCollect();await ctx.page.clock.runFor(1600);
  assert.equal((await ctx.journal()).messageId,moved?'':'late-id');
  assert.equal((await ctx.journal()).conversation,TEMP_URL);
 });
}

// The send-time rule for a REVIEW, where it does not contradict #82: a review sent on a page that
// names a conversation records it when its send is proven, so an in-page move before the
// collector's first poll never pins the user's conversation there. A review sent on a new chat has
// no conversation at its send: the provider assigns one afterwards, and the review pins where the
// provider puts it (#82, json.js pinNewChatReview), not the new-chat page it was sent on.
test('real DOM send-time identity (review on a conversation page, moved before the collector\'s first poll): recorded at send, never re-pinned, can-close refused',async t=>{
 const ctx=await conversationPage(t,'review',{url:CONV_URL,gated:true});
 assert.equal((await ctx.journal()).conversation,CONV_URL,'recorded when the send was proven');
 await ctx.move(OTHER_URL);
 await ctx.openCollect();await ctx.page.clock.runFor(1600);
 await ctx.complete();await ctx.page.clock.runFor(3200);
 assert.equal((await ctx.journal()).conversation,CONV_URL,'never re-pinned at collect');
 const out=await ctx.send('ashlar-can-close',{allocationUrl:TEMP_URL});
 assert.deepEqual({canClose:out.canClose,identity:out.identity,conversation:out.conversation},{canClose:false,identity:'changed',conversation:CONV_URL});
});
test('real DOM send-time identity (review on a new chat): nothing recorded at send; pinned where the provider puts it (#82)',async t=>{
 const ctx=await conversationPage(t,'review',{url:NEW_URL,gated:true});
 assert.equal((await ctx.journal()).conversation,undefined,'a new chat names no conversation when the send is proven');
 await ctx.move(CONV_URL); // the provider assigns the conversation URL (no user action)
 await ctx.openCollect();await ctx.page.clock.runFor(1600);
 assert.equal((await ctx.journal()).conversation,CONV_URL,'pinned where the provider put it');
 await ctx.complete();await ctx.page.clock.runFor(3200);
 const out=await ctx.send('ashlar-can-close',{allocationUrl:TEMP_URL});
 assert.deepEqual({canClose:out.canClose,conversation:out.conversation},{canClose:true,conversation:CONV_URL});
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

// Round 12 (Ashlar 4097631101), under #82's release rule: the server reports the fix cancelled or
// unknown (a registry restart or a terminal-retention prune forgets it) AFTER its answer was
// collected and delivered. Whether the tab closes never follows the server status: the answer was
// delivered (the worker recorded the complete ACK), so the fix takes its proven-success path and asks
// can-close whatever the server says since (#77: its run already ended with that answer, and a fix
// page's cancel reply carries no verdict). The answer changing on the page (regenerated, replaced
// under a new message ID) is not the user's activity (#82: ChatGPT keeps redrawing and re-keying a
// finished answer), so the tab still closes; only a user signal (here a follow-up turn) keeps it,
// preserved and released (the preserve message also stops the page's run).
const ANSWER_CHANGES={
 unchanged:null,
 regenerated:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="response-A"] code').textContent='{"summary":"regenerated","files":[]}';}),
 replaced:({page})=>page.evaluate(()=>{const r=document.querySelector('[data-message-id="response-A"]');r.dataset.messageId='response-B';r.querySelector('code').textContent='{"summary":"another answer","files":[]}';}),
 followup:({page})=>page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='personal follow-up';document.querySelector('main').append(u);}),
};
for(const status of ['cancelled','unknown'])for(const [change,apply] of Object.entries(ANSWER_CHANGES)){
const kept=change==='followup';
test(`real DOM: a delivered fix whose server then reports ${status}, answer ${change}: ${kept?'preserved, released and stopped, never closed':'closed (no user signal)'}`,async t=>{
 const ctx=await conversationPage(t,'fix');
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(ctx.page,server);
 await b.tick();
 // the worker takes and delivers the answer; its cleanup is held until the server forgot the item
 const cleanup=b.context.cleanupProvider;b.context.cleanupProvider=async()=>{};
 await ctx.complete();await ctx.page.clock.runFor(3200);await b.tick();
 assert.equal(b.calls.some(c=>c.action==='complete'),true,'delivered while the proof held');
 assert.equal(state().outcome?.ok,true,'the local outcome is kept');
 server.value=status;await b.tick();
 assert.equal(b.local.state.pendingReviewJobs['fix-A'].serverStatus,status);
 await apply?.(ctx);
 b.context.cleanupProvider=cleanup;
 await b.tick();
 const got={closed:b.closedTabs.length,retired:state()===undefined,released:(await ctx.send('ashlar-tab-status')).released,
  stopped:await ctx.page.evaluate(()=>sessionStorage.getItem('ashlar:stopped:fix-A:run-A')==='true')};
 // (a preserved tab's run is stopped: the preserve message is the cancel exit, preserveFixTab)
 assert.deepEqual(got,{closed:kept?0:1,retired:true,released:kept,stopped:kept});
});
}

// ── The fix ownership proof at EVERY page decision point (conformance rows P19-P21, P23, P26): the
// same violations of the full proof against each decision, with a control. A cell is `true` when the
// decision acts for Ashlar (collects, hands out, closes). The answer collection (fixOwnershipProof)
// and the tab release (tabOwnership) refuse every user signal and a fix journal with no send-time
// identity; a response the provider changed after collection is not one (#82: ChatGPT keeps
// redrawing a finished answer), so a collected answer is still handed out and its tab still closes.
// The cancel exit (P23, P26) never acts for Ashlar on a fix page, whatever the page shows: a fix tab
// is closed only on the proven-success path (#77), so its cancel reply stops the run, frees the slot
// and carries no verdict. (P22, restoring a completion proof after a reload, is gone: a reloaded tab
// is released by the same verdict, no restore needed.)
const PROOF_VIOLATIONS={
 none:null,
 editedSuffix:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='fix prompt and my own words';}),
 editedPrefix:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='my note: fix prompt';}),
 followup:({page})=>page.evaluate(()=>{const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent='personal follow-up';document.querySelector('main').append(u);}),
 draft:({page})=>page.locator('#prompt-textarea').evaluate(el=>{el.textContent='my own question';}),
 // a file the user staged in the composer before typing anything is a draft too
 stagedFile:({page})=>page.evaluate(()=>document.querySelector('form').insertAdjacentHTML('afterbegin','<div role="group" aria-label="my-notes.pdf" style="width:120px;height:40px">my-notes.pdf</div>')),
 moved:({move})=>move(OTHER_URL),
 // round 13: the journal carries no send-time identity (a legacy journal, or one confirmed only after
 // a reload); nothing may record one later
 noSendIdentity:({page})=>page.evaluate(()=>{
  const key='ashlar:submission:fix-A:run-A',journal=JSON.parse(sessionStorage.getItem(key));delete journal.conversation;
  sessionStorage.setItem(key,JSON.stringify(journal));delete __ashlarRunnerState.confirmedSubmission?.record.conversation;
 }),
 responseChanged:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="response-A"] code').textContent='{"summary":"regenerated","files":[]}';}),
 // round 15 (Ashlar 4100156785): permanent verdicts that leave NO identifiable response. The user
 // navigates in-page to another conversation and the old DOM is removed (the new page renders
 // nothing yet); or the sent turn's text is replaced with unrelated text (the turn no longer
 // contains the prompt, so no response binds to it).
 movedDomRemoved:({page,move})=>move(OTHER_URL).then(()=>page.evaluate(()=>{document.querySelector('main').innerHTML='';document.querySelector('[data-testid="stop-button"]')?.remove();})),
 turnReplaced:({page})=>page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='an unrelated question of my own';}),
};
const PROOF_DECISIONS={
 // P19 collect: the violation is present when the answer completes
 collect:async ctx=>{await PROOF_VIOLATIONS[ctx.violation]?.(ctx);await ctx.complete();await ctx.page.clock.runFor(3200);return (await ctx.harvest()).ok===true;},
 // P20 hand out a collected answer (ashlar-harvest / ashlar-run reply)
 handOut:async ctx=>{await ctx.complete();await ctx.page.clock.runFor(3200);await PROOF_VIOLATIONS[ctx.violation]?.(ctx);return (await ctx.harvest()).ok===true;},
 // P21 close after completion (can-close)
 canClose:async ctx=>{await ctx.complete();await ctx.page.clock.runFor(3200);await ctx.harvest();await PROOF_VIOLATIONS[ctx.violation]?.(ctx);return (await ctx.send('ashlar-can-close')).canClose===true;},
 // P23 the cancel exit before an answer (ashlar-fix-cancel): never a verdict for a fix page
 cancel:async ctx=>{await PROOF_VIOLATIONS[ctx.violation]?.(ctx);return (await ctx.send('ashlar-fix-cancel')).owned===true;},
 // P26 the cancel exit after the answer was collected (round 12): never a verdict either
 cancelCollected:async ctx=>{await ctx.complete();await ctx.page.clock.runFor(3200);await ctx.harvest();await PROOF_VIOLATIONS[ctx.violation]?.(ctx);return (await ctx.send('ashlar-fix-cancel')).owned===true;},
};
// The collector and the cancel exit before an answer have no collected answer the provider could
// change; a move that removed the old DOM leaves no response to complete (the lifecycle rows cover it).
const PROOF_NA={collect:['responseChanged','movedDomRemoved'],cancel:['responseChanged']};
// Not the user's activity: the decision still acts for Ashlar.
const PROOF_ACTS=['none','responseChanged'];
// Decisions that never act for Ashlar on a fix page (#77: a cancel never closes a fix tab).
const PROOF_NEVER=['cancel','cancelCollected'];
for(const [decision,act] of Object.entries(PROOF_DECISIONS)){
 test(`real DOM fix ownership proof at ${decision}: only the full proof acts, every violation is refused`,async t=>{
  const got={},want={};
  for(const violation of Object.keys(PROOF_VIOLATIONS)){
   if(PROOF_NA[decision]?.includes(violation))continue;
   const ctx=await conversationPage(t,'fix');
   got[violation]=await act({...ctx,violation});
   want[violation]=!PROOF_NEVER.includes(decision) && PROOF_ACTS.includes(violation);
  }
  assert.deepEqual(got,want);
 });
}

// ── Round 11 lifecycle (review 5307890587, P1): a PERMANENT ownership verdict ends the fix at once.
// The real page and the real worker over the message protocol: the violation appears while the
// answer is generating (the collector) or after it was collected (the hand-out). A permanent
// verdict must reach the server as a `taken_over` failure on the worker's next tick (the runtime
// retries or escalates now), with the tab preserved and its managed slot freed. Only a transient
// verdict keeps the run alive (it would end at the fix deadline).
const TERMINAL_VIOLATIONS={
 followup:PROOF_VIOLATIONS.followup,editedSuffix:PROOF_VIOLATIONS.editedSuffix,editedPrefix:PROOF_VIOLATIONS.editedPrefix,
 draft:PROOF_VIOLATIONS.draft,stagedFile:PROOF_VIOLATIONS.stagedFile,moved:PROOF_VIOLATIONS.moved,noSendIdentity:PROOF_VIOLATIONS.noSendIdentity,
 movedDomRemoved:PROOF_VIOLATIONS.movedDomRemoved,turnReplaced:PROOF_VIOLATIONS.turnReplaced,
};
const TRANSIENT_VIOLATIONS={
 none:null,
 // the just-sent prompt still echoed in the composer is Ashlar's own text, not a user draft
 composerEcho:({page})=>page.locator('#prompt-textarea').evaluate(el=>{el.textContent='fix prompt';}),
 // #82: the provider redrawing a collected answer is not the user's activity (PROOF_ACTS): the
 // collected answer is still handed out and its tab closes
 responseChanged:PROOF_VIOLATIONS.responseChanged,
};
for(const when of ['generating','collected']){
 for(const [violation,apply] of Object.entries({...TERMINAL_VIOLATIONS,...TRANSIENT_VIOLATIONS})){
  // a replaced response is a change only against a collected answer
  if(when==='generating' && violation==='responseChanged')continue;
  const terminal=violation in TERMINAL_VIOLATIONS;
  test(`real DOM lifecycle: ${violation} while ${when} ${terminal?'ends the fix at once (taken_over), tab preserved':violation==='responseChanged'?'still delivers the collected answer and closes its tab':'keeps the run alive'}`,async t=>{
   const ctx=await conversationPage(t,'fix');
   const server={value:'awaiting_chat'};
   const {b,sync,state}=wiredWorker(ctx.page,server);
   await b.tick();
   if(when==='collected'){await ctx.complete();await ctx.page.clock.runFor(3200);}
   await apply?.(ctx);sync();
   await ctx.page.clock.runFor(1600);
   await b.tick();
   const failure=b.calls.find(c=>c.action==='failure');
   const got={failed:Boolean(failure),takenOver:/^taken_over: /.test(failure?.error||''),delivered:b.calls.some(c=>c.action==='complete'),
    closed:b.closedTabs.length,retired:state()===undefined,released:(await ctx.send('ashlar-tab-status')).released};
   // control (none): generating waits, a collected answer is delivered and its tab closed; the
   // composer echo waits (unknown, never handed out) without ending the run
   const delivered=when==='collected' && ['none','responseChanged'].includes(violation);
   const want=terminal
    ?{failed:true,takenOver:true,delivered:false,closed:0,retired:true,released:true}
    :{failed:false,takenOver:false,delivered,closed:delivered?1:0,retired:delivered,released:false};
   assert.deepEqual(got,want);
  });
 }
}

// Round 15 control: `turn_unrendered` is reserved for a turn genuinely not rendered while the page is
// still in the recorded conversation: the run keeps waiting (never taken over by DOM absence alone).
test('real DOM lifecycle: the sent turn not rendered in the recorded conversation while generating keeps the run alive',async t=>{
 const ctx=await conversationPage(t,'fix');
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(ctx.page,server);
 await b.tick();
 await ctx.page.evaluate(()=>{document.querySelector('main').innerHTML='';});
 await ctx.page.clock.runFor(1600);await b.tick();
 assert.deepEqual({failed:b.calls.some(c=>c.action==='failure'),retired:state()===undefined,released:(await ctx.send('ashlar-tab-status')).released},
  {failed:false,retired:false,released:false});
 assert.equal(await ctx.page.evaluate(()=>__ashlarRunnerState.running),true,'still collecting');
});

// R17 (Ashlar 4101855318, P1): the answer completes and the collector observes it once; before its
// second stable observation the user regenerates it (a new response replaces response-A). The run
// ends taken_over with the tab preserved: the regenerated response is never handed out, delivered or
// closed on.
test('real DOM lifecycle: a fix response regenerated before its second stable observation ends the fix (taken_over), never delivered',async t=>{
 const ctx=await conversationPage(t,'fix');
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(ctx.page,server);
 await b.tick();
 await ctx.complete();
 assert.equal(await ctx.page.evaluate(()=>__ashlarRunnerState.observation?.state),'answer_observed','the first answered observation');
 const regenerated='{"summary":"regenerated","files":[],"dispositions":[]}';
 await ctx.page.evaluate(regenerated=>{
  document.querySelector('[data-message-id="response-A"]').outerHTML=`<div data-message-author-role="assistant" data-message-id="response-B"><div class="markdown"><pre><code>${regenerated}</code></pre></div></div>`;
 },regenerated);
 await ctx.page.clock.runFor(3200);
 const out=await ctx.harvest();
 await b.tick();
 const failure=b.calls.find(c=>c.action==='failure');
 assert.notEqual(out.raw,regenerated,'never handed out');
 assert.deepEqual({code:out.code,takenOver:/^taken_over: /.test(failure?.error||''),delivered:b.calls.some(c=>c.action==='complete'),closed:b.closedTabs.length,
  retired:state()===undefined,released:(await ctx.send('ashlar-tab-status')).released,canClose:(await ctx.send('ashlar-can-close')).canClose},
  {code:'taken_over',takenOver:true,delivered:false,closed:0,retired:true,released:true,canClose:false});
});

// R18 control: the answer completes before its response ID is assigned, and the ID then appears on
// the same message node (a late ID). It is the same response: collected under that ID, delivered and
// closed on the proven-success path, never ended as taken_over.
test('real DOM lifecycle: a fix response whose ID is assigned after its first answered observation is delivered and closed (control)',async t=>{
 const ctx=await conversationPage(t,'fix');
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(ctx.page,server);
 await b.tick();
 await ctx.page.evaluate(()=>document.querySelector('[data-message-id="response-A"]').removeAttribute('data-message-id'));
 await ctx.complete();
 assert.equal(await ctx.page.evaluate(()=>__ashlarRunnerState.observation?.state),'answer_observed','the first answered observation, with no response ID');
 await ctx.page.evaluate(()=>document.querySelector('[data-message-author-role="assistant"]').setAttribute('data-message-id','response-A'));
 await ctx.page.clock.runFor(3200);
 await b.tick();
 const failure=b.calls.find(c=>c.action==='failure');
 assert.deepEqual({failure:failure?.error,delivered:b.calls.some(c=>c.action==='complete'),closed:b.closedTabs.length,retired:state()===undefined},
  {failure:undefined,delivered:true,closed:1,retired:true});
});

// R17 (Ashlar 4101855338): the same absent turn, while the user types a draft of their own and clears it
// before the turn renders again. The draft was seen: the run ends taken_over on that poll, the tab is
// preserved, and the restored turn with an empty composer never hands it back.
test('real DOM lifecycle: a draft typed and cleared while the sent turn is not rendered ends the fix (taken_over), tab preserved',async t=>{
 const ctx=await conversationPage(t,'fix');
 const server={value:'awaiting_chat'};
 const {b,state}=wiredWorker(ctx.page,server);
 await b.tick();
 await ctx.page.evaluate(()=>{window.turns=document.querySelector('main').innerHTML;document.querySelector('main').innerHTML='';
  document.querySelector('#prompt-textarea').textContent='my own question';});
 await ctx.page.clock.runFor(1600);
 await ctx.page.evaluate(()=>{document.querySelector('#prompt-textarea').textContent='';document.querySelector('main').innerHTML=window.turns;});
 await ctx.complete();
 await ctx.page.clock.runFor(3200);await b.tick();
 const failure=b.calls.find(c=>c.action==='failure');
 assert.deepEqual({takenOver:/^taken_over: /.test(failure?.error||''),delivered:b.calls.some(c=>c.action==='complete'),closed:b.closedTabs.length,
  retired:state()===undefined,released:(await ctx.send('ashlar-tab-status')).released,canClose:(await ctx.send('ashlar-can-close')).canClose},
  {takenOver:true,delivered:false,closed:0,retired:true,released:true,canClose:false});
});

// Round 15 class sibling (Ashlar 4100156785): after a reload lost the page's collected answer, the
// tab's release decides the permanent verdicts before anything transient, so a tab the user took over
// answers `repurposed` (slot freed: the worker preserves it at once) instead of the retryable
// `pending`. #77 pinned this on the completion restore (ashlar-result-saved); #82 removed that restore
// (a reloaded tab is released by the same verdict, json.js tabOwnership, with nothing to restore), so
// the row asks that verdict. Control: a sent turn not rendered yet in the recorded conversation (asked
// without the allocation page, where a blank temporary chat is Ashlar's) stays retryable.
for(const [name,apply,want] of [
 ['movedDomRemoved',PROOF_VIOLATIONS.movedDomRemoved,{reason:'repurposed',released:true}],
 ['turnReplaced',PROOF_VIOLATIONS.turnReplaced,{reason:'repurposed',released:true}],
 ['notRenderedYet',({page})=>page.evaluate(()=>{document.querySelector('main').innerHTML='';}),{reason:'pending',released:false}],
]){
 test(`real DOM release verdict after a reload, ${name}: ${want.reason}`,async t=>{
  const ctx=await conversationPage(t,'fix');
  await ctx.complete();await ctx.page.clock.runFor(3200);const out=await ctx.harvest();
  assert.equal(out.ok,true,'collected');
  await ctx.page.evaluate(()=>{const s=__ashlarRunnerState;s.result=null;s.nativeCompletion=undefined;s.restoredCompletion=false;s.running=false;});
  await apply(ctx);
  const verdict=await ctx.send('ashlar-can-close');
  assert.deepEqual({reason:verdict.reason,released:(await ctx.send('ashlar-tab-status')).released},want);
 });
}

/** The conversation a fix's send records (composer.js submissionConfirmed): a fix page is served at
 * ChatGPT's temporary chat, the only page a fix can be proven in (json.js fixChatPage). */
const SENT_HERE=TEMP_URL;
/** Put `html` on the page at the temporary-chat URL (a fix page; setContent would be about:blank). */
async function setFixContent(page,html){
 await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:`<html><body>${html}</body></html>`}));
 await page.goto(TEMP_URL);
}
/** A fix run's page: this run's user turn (user-A) and an assistant response (response-A) with
 * `inner`, plus its submission journal (`journal` null = none yet). */
async function fixPage(t,inner,journal={phase:'sent',expected:'fix prompt',exact:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A',conversation:SENT_HERE},{done=true}={}){
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 await setFixContent(page,`<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown">${inner}</div></div>${done?'<button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button>':''}</section></main>${done?'':stop}<form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form>`);
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
async function kindPage(t,kind,{done=true,journal={phase:'sent',expected:'fix prompt',...(kind==='fix'?{exact:'fix prompt'}:{}),baseline:0,submittedUsers:1,messageId:'user-A',conversation:kind==='fix'?SENT_HERE:'about:blank'},extra=''}={}){
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 const html=`<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><p>Here.</p><pre><code>${KIND_ANSWER}</code></pre></div></div>${done?toolbar:''}</section></main>${done?'':stop}${extra}<form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form>`;
 // a fix page is served at the temporary chat (the only page a fix is proven in); a review page is unchanged
 await (kind==='fix'?setFixContent(page,html):page.setContent(html));
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
  // Round 11 lifecycle: for a fix a follow-up is a permanent verdict that ends the run at once
  // (taken_over); a review has no ownership proof or deadline and keeps waiting (busy).
  assert.equal((await harvest()).code,kind==='fix'?'taken_over':'busy','no answer from a repurposed conversation');
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
  // was bound in; a review still harvests the lingering DOM (FLAG R4, out of scope). Both runs
  // recorded their conversation when the send was proven (a review sent on a conversation page does
  // too), so neither tab may close in the user's conversation.
  assert.deepEqual({ok:out.ok===true,canClose},kind==='fix'?{ok:false,canClose:false}:{ok:true,canClose:false});
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
 await page.evaluate(()=>window.__saved.set('ashlar:submission:fix-A:run-A',JSON.stringify({phase:'sent',expected:'fix prompt',exact:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A',conversation:location.href})));
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
  // Round 11: an edited turn is a permanent verdict: the collector ends at once (taken_over).
  const out=await page.evaluate(()=>window.fixOut);
  assert.equal(out.raw,undefined,`an edited sent turn (${edit}) never yields a fix answer`);
  assert.match(out.error||'',/^fix run ended: the user took over the fix tab \(edited\)/);
  assert.equal(await page.evaluate(()=>__ashlarRunnerState.tabRepurposed),true,'the edited tab is repurposed');
  await page.evaluate(()=>{document.querySelector('[data-message-id="user-A"]').textContent='fix prompt';});
  await page.clock.runFor(6400);
  assert.equal((await page.evaluate(()=>window.fixOut)).raw,undefined,'undoing the edit does not revive the harvest');
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

// Ashlar 4099509090: a fix prompt is delivered VERBATIM, byte-exact. It inlines whole source files,
// so an attachment-looking line in a file (a V2 sentinel, a complete legacy <<<ATTACH:…>>> block) is
// file content: never rejected, never converted into an upload, never trimmed. The real composer on a
// temporary-chat page with an upload input: the composer holds exactly the prompt at the Send click,
// nothing is uploaded, the send is confirmed, and the answer goes through the fix parser.
const LEGACY_BLOCK='<<<ATTACH:inlined.txt>>>\nconst marker = "<<<END_ATTACH>>>";\n<<<END_ATTACH>>>';
for(const [name,inlined] of Object.entries({
 'a V2 sentinel line and a complete legacy block':`// transport-looking lines are file content:\n<<<ASHLAR_ATTACHMENTS_V2>>>\n${LEGACY_BLOCK}`,
 'a complete legacy block':LEGACY_BLOCK,
})){
test(`real DOM: a fix prompt whose inlined source holds ${name} reaches the composer byte-exact, with no upload`,async t=>{
 const {parseFixResponse}=await import('../../src/lib/fix-apply.ts');
 const prompt=`  Fix F1. Current content of src/a.ts:\n\n${inlined}\n\nReturn the JSON object.\n`;
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 await setFixContent(page,'<main></main><form data-type="unified-composer"><input type="file" multiple><textarea id="prompt-textarea" style="width:300px;height:60px"></textarea><button data-testid="send-button" aria-label="Send prompt" style="width:60px;height:30px">Send</button></form>');
 await page.evaluate(({stop})=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A']]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.__saved=saved;
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
  // The provider accepts the prompt: what the composer held at the click becomes the sent turn.
  document.querySelector('[data-testid="send-button"]').addEventListener('click',event=>{
   const composer=document.querySelector('#prompt-textarea');
   window.atClick={text:composer.value,uploads:document.querySelector('input[type=file]').files.length};
   const turn=document.createElement('section');turn.dataset.testid='conversation-turn-1';
   const userTurn=document.createElement('div');userTurn.dataset.messageAuthorRole='user';userTurn.dataset.messageId='user-A';userTurn.textContent=composer.value;
   turn.append(userTurn);document.querySelector('main').append(turn);
   composer.value='';event.currentTarget.remove();document.body.insertAdjacentHTML('beforeend',stop);
  });
 },{stop});
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 await page.evaluate(prompt=>{
  const s=__ashlarRunnerState;Object.assign(s,{kind:'fix',jobId:'fix-A',runId:'run-A',running:true});
  window.filled={pending:true};
  fillComposer(composer(),prompt).then(text=>{window.filled={text};return clickSend(sendButton,composer,text);}).then(()=>{window.sent=true;},e=>{window.filled={error:e.message};});
 },prompt);
 await page.clock.runFor(1600);
 assert.equal((await page.evaluate(()=>window.filled)).error,undefined,'the prompt is never rejected as a broken envelope');
 assert.deepEqual(await page.evaluate(()=>window.atClick),{text:prompt,uploads:0},'the composer held exactly the prompt bytes; nothing was uploaded');
 assert.equal(await page.evaluate(()=>window.sent),true,'the send is confirmed');
 const journal=JSON.parse(await page.evaluate(()=>window.__saved.get('ashlar:submission:fix-A:run-A')));
 assert.deepEqual([journal.phase,journal.conversation,journal.attachments],['sent',TEMP_URL,[]]);
 // the answer completes and is read by the fix collector, then parsed by the server's fix parser
 const code='{"summary":"guarded","files":[{"path":"src/a.ts","content":"export const a = 1;\\n"}],"dispositions":[{"finding":"F1","action":"fixed","note":"guarded"}]}';
 await page.evaluate(({code,toolbar})=>{
  document.querySelector('[data-testid="stop-button"]').remove();
  document.querySelector('main').insertAdjacentHTML('beforeend',`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><pre><code>${code}</code></pre></div></div>${toolbar}</section>`);
  window.fixOut={pending:true};waitUntilFixOrQuota('ChatGPT').then(raw=>{window.fixOut={raw};},e=>{window.fixOut={error:e.message};});
 },{code,toolbar});
 await page.clock.runFor(3200);
 const out=await page.evaluate(()=>window.fixOut);
 assert.equal(out.raw,code,JSON.stringify(out));
 const parsed=parseFixResponse(out.raw,{findingCount:1});
 assert.equal(parsed.ok,true,JSON.stringify(parsed));
});
}

// R17 (Ashlar 4101855330): a fix prompt inlines source whose whitespace is content, so it is verified
// LOSSLESSLY (composer.js fixPromptForm: only CRLF->LF and the two ends of the whole prompt), never by
// the whitespace-collapsing normalizePrompt a review prompt keeps. Each alteration changes ONE whitespace
// sequence (every one is invisible to normalizePrompt).
const WS_PROMPT='Fix F1. Current content of src/a.py:\n\ndef f(x):\n\tif x:\n\t\treturn "a  b\t c"\n\n\n    pass  # two  spaces\nReturn the JSON object.';
const WS_ALTERATIONS={
 tabToSpaces:text=>text.replace('\t\t','\t    '),
 stringSpacesCollapsed:text=>text.replace('"a  b','"a b'),
 blankLinesMerged:text=>text.replace('\n\n\n','\n\n'),
 indentDropped:text=>text.replace('\n    pass','\n  pass'),
 newlineToSpace:text=>text.replace(':\n\tif',': \tif'),
};
/** A temporary-chat fix page with a textarea composer. `editor(value)` is what the editor keeps of a
 * typed value; `render(value)` is the text of the sent turn the provider renders from the composer. */
async function whitespacePage(t,{kind='fix',editor=null,render=null}={}){
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 await setFixContent(page,'<main></main><form data-type="unified-composer"><textarea id="prompt-textarea" style="width:300px;height:60px"></textarea><button data-testid="send-button" aria-label="Send prompt" style="width:60px;height:30px">Send</button></form>');
 await page.evaluate(({stop,editor,render})=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A']]);
  Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
  window.__saved=saved;window.sends=0;
  window.chrome={runtime:{onMessage:{addListener:f=>window.receiver=f,removeListener(){}}}};
  const composer=document.querySelector('#prompt-textarea');
  if(editor){const alter=new Function('return '+editor)();composer.addEventListener('input',()=>{composer.value=alter(composer.value);});}
  document.querySelector('[data-testid="send-button"]').addEventListener('click',event=>{
   window.sends++;
   const shown=render?new Function('return '+render)()(composer.value):composer.value;
   const turn=document.createElement('section');turn.dataset.testid='conversation-turn-1';
   const userTurn=document.createElement('div');userTurn.dataset.messageAuthorRole='user';userTurn.dataset.messageId='user-A';userTurn.textContent=shown;
   turn.append(userTurn);document.querySelector('main').append(turn);
   composer.value='';event.currentTarget.remove();document.body.insertAdjacentHTML('beforeend',stop);
  });
 },{stop,editor:editor&&editor.toString(),render:render&&render.toString()});
 for(const file of ['composer.js','quota.js','model.js','json.js','content-chatgpt.js'])await page.addScriptTag({content:source('extension/'+file)});
 await page.evaluate(kind=>{Object.assign(__ashlarRunnerState,{kind:kind==='fix'?'fix':undefined,jobId:'fix-A',runId:'run-A',running:true});},kind);
 const journal=()=>page.evaluate(()=>JSON.parse(window.__saved.get('ashlar:submission:fix-A:run-A')||'null'));
 const fill=async(prompt=WS_PROMPT)=>{
  await page.evaluate(prompt=>{window.filled={pending:true};
   fillComposer(composer(),prompt).then(text=>{window.filled={text};return clickSend(sendButton,composer,text);})
    .then(()=>{window.sent=true;},e=>{window.filled={error:e.message,code:e.code};});},prompt);
  await page.clock.runFor(1600);
  return page.evaluate(()=>({...window.filled,sends:window.sends,sent:window.sent===true}));
 };
 return {page,journal,fill};
}
for(const [name,alter] of Object.entries(WS_ALTERATIONS)){
 test(`real DOM: a fix prompt whose editor changes one whitespace sequence (${name}) is never sent; a review prompt still is`,async t=>{
  assert.notEqual(alter(WS_PROMPT),WS_PROMPT,'the fixture alters the prompt');
  const fix=await whitespacePage(t,{editor:alter});
  assert.deepEqual(await fix.fill(),{code:'prompt_altered',error:"the composer changed the fix prompt's whitespace; it was not sent",sends:0,sent:false});
  assert.equal(await fix.journal(),null,'nothing was prepared, nothing sent');
  // a review prompt keeps the whitespace-normalized comparison: the same editor is accepted
  const review=await whitespacePage(t,{kind:'review',editor:alter});
  const out=await review.fill();
  assert.deepEqual([out.error,out.sends,out.sent],[undefined,1,true]);
 });
 test(`real DOM: a fix draft changed (${name}) after it was filled is caught before Send`,async t=>{
  const {page,journal}=await whitespacePage(t);
  await page.evaluate(({prompt,altered})=>{document.querySelector('#prompt-textarea').value=altered;window.out={pending:true};
   clickSend(sendButton,composer,prompt).then(()=>{window.out={sent:true};},e=>{window.out={code:e.code};});},{prompt:WS_PROMPT,altered:alter(WS_PROMPT)});
  await page.clock.runFor(1600);
  assert.deepEqual({out:await page.evaluate(()=>window.out),sends:await page.evaluate(()=>window.sends),phase:(await journal()).phase},
   {out:{code:'prompt_altered'},sends:0,phase:'prepared'});
 });
 test(`real DOM: a fix whose sent turn renders the prompt with one whitespace sequence changed (${name}) is never harvested`,async t=>{
  const {page,fill,journal}=await whitespacePage(t,{render:alter});
  assert.deepEqual(await fill(),{text:WS_PROMPT,sends:1,sent:true},'the composer held the prompt exactly; the send is confirmed');
  assert.equal((await journal()).exact,WS_PROMPT,'the journal carries the lossless form');
  const code='{"summary":"s","files":[],"dispositions":[]}';
  await page.evaluate(({code,toolbar})=>{
   document.querySelector('[data-testid="stop-button"]').remove();
   document.querySelector('main').insertAdjacentHTML('beforeend',`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><pre><code>${code}</code></pre></div></div>${toolbar}</section>`);
   window.fixOut={pending:true};waitUntilFixOrQuota('ChatGPT').then(raw=>{window.fixOut={raw};},e=>{window.fixOut={code:e.code};});
  },{code,toolbar});
  await page.clock.runFor(3200);
  assert.deepEqual(await page.evaluate(()=>window.fixOut),{code:'taken_over'});
  assert.equal(await page.evaluate(()=>__ashlarRunnerState.tabRepurposed),true,'the tab is preserved as the user\'s');
 });
}
test('real DOM: a prepared fix journal with no lossless prompt form is never sent, even with the prompt held exactly',async t=>{
 const {page}=await whitespacePage(t);
 await page.evaluate(prompt=>{
  window.__saved.set('ashlar:submission:fix-A:run-A',JSON.stringify({phase:'prepared',expected:normalizePrompt(prompt),baseline:0,attachments:[]}));
  document.querySelector('#prompt-textarea').value=prompt;window.out={pending:true};
  clickSend(sendButton,composer,prompt).then(()=>{window.out={sent:true};},e=>{window.out={code:e.code};});
 },WS_PROMPT);
 await page.clock.runFor(1600);
 assert.deepEqual({out:await page.evaluate(()=>window.out),sends:await page.evaluate(()=>window.sends)},{out:{code:'prompt_altered'},sends:0});
});
test('real DOM: a fix prompt with tabs, runs of spaces and blank lines, sent through CRLF, round-trips and is harvested (control)',async t=>{
 const {page,fill,journal}=await whitespacePage(t);
 // the textarea stores CRLF as LF: a transport change the lossless form undoes
 const crlf=WS_PROMPT.replace(/\n/g,'\r\n');
 const out=await fill(crlf);
 assert.deepEqual(out,{text:crlf,sends:1,sent:true});
 assert.equal((await journal()).exact,WS_PROMPT);
 const code='{"summary":"s","files":[],"dispositions":[]}';
 await page.evaluate(({code,toolbar})=>{
  // the provider stores line endings as LF and trims the message: the lossless form is unchanged
  const turn=document.querySelector('[data-message-id="user-A"]');turn.textContent=`\n${turn.textContent.replace(/\n/g,'\r\n')}\n`;
  document.querySelector('[data-testid="stop-button"]').remove();
  document.querySelector('main').insertAdjacentHTML('beforeend',`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><pre><code>${code}</code></pre></div></div>${toolbar}</section>`);
  window.fixOut={pending:true};waitUntilFixOrQuota('ChatGPT').then(raw=>{window.fixOut={raw};},e=>{window.fixOut={code:e.code};});
 },{code,toolbar});
 await page.clock.runFor(3200);
 assert.deepEqual(await page.evaluate(()=>window.fixOut),{raw:code});
});
// R18: ChatGPT renders the sent user turn as rich text (captured-dom-shapes.e2e.mjs:
// collapsible-user-message-content > .rich-text-user-turn.markdown), whose blocks can be read two ways:
// one <p> per blank-line paragraph with a <br> per line break (the captured shape), or one <p> per line
// (the composer's own structure). The composer held the prompt exactly and the send delivered it: either
// shape is the prompt, harvested; a whitespace sequence changed in the rendered turn is not, in either.
const RICH_TURN_SHAPES=['paragraphsWithBreaks','paragraphPerLine'];
async function richSentTurn(t,shape,rendered){
 const {page,fill}=await whitespacePage(t);
 assert.deepEqual(await fill(),{text:WS_PROMPT,sends:1,sent:true},'the composer held the prompt exactly; the send is confirmed');
 const code='{"summary":"s","files":[],"dispositions":[]}';
 await page.evaluate(({shape,text,code,toolbar})=>{
  const block=lines=>{const p=document.createElement('p');
   lines.forEach((line,i)=>{if(i)p.append(document.createElement('br'));if(line)p.append(line);});
   if(lines.length===1&&!lines[0])p.append(document.createElement('br'));return p;};
  const blocks=shape==='paragraphPerLine'?text.split('\n').map(line=>[line]):text.split('\n\n').map(par=>par.split('\n'));
  const body=document.createElement('div');body.className='rich-text-user-turn markdown';body.append(...blocks.map(block));
  const content=document.createElement('div');content.dataset.testid='collapsible-user-message-content';content.append(body);
  document.querySelector('[data-message-id="user-A"]').replaceChildren(content);
  document.querySelector('[data-testid="stop-button"]').remove();
  document.querySelector('main').insertAdjacentHTML('beforeend',`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><pre><code>${code}</code></pre></div></div>${toolbar}</section>`);
  window.fixOut={pending:true};waitUntilFixOrQuota('ChatGPT').then(raw=>{window.fixOut={raw};},e=>{window.fixOut={code:e.code};});
 },{shape,text:rendered,code,toolbar});
 await page.clock.runFor(3200);
 return {out:await page.evaluate(()=>window.fixOut),code};
}
for(const shape of RICH_TURN_SHAPES){
 test(`real DOM: a fix whose sent turn renders the prompt as rich text (${shape}) is harvested`,async t=>{
  const {out,code}=await richSentTurn(t,shape,WS_PROMPT);
  assert.deepEqual(out,{raw:code});
 });
 test(`real DOM: a fix whose rich-text sent turn (${shape}) has one whitespace sequence changed is never harvested`,async t=>{
  const got={};
  for(const [name,alter] of Object.entries(WS_ALTERATIONS))got[name]=(await richSentTurn(t,shape,alter(WS_PROMPT))).out;
  assert.deepEqual(got,Object.fromEntries(Object.keys(WS_ALTERATIONS).map(name=>[name,{code:'taken_over'}])));
 });
}
// ChatGPT's composer is a rich editor holding one <p> per line (an empty line: <p><br class=
// "ProseMirror-trailingBreak"></p>). Its innerText separates the <p> blocks by a blank line, so the
// lossless reading is structural (composer.js losslessText); a changed whitespace sequence still fails.
test('real DOM: a rich-editor composer holding the fix prompt one <p> per line reads back exactly; one changed sequence does not',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent('<form><div id="prompt-textarea" contenteditable="true" class="ProseMirror" style="white-space:pre-wrap;width:400px;min-height:60px"></div></form>');
 await page.addScriptTag({content:source('extension/composer.js')});
 const read=text=>page.evaluate(text=>{
  const el=document.querySelector('#prompt-textarea');el.replaceChildren();
  for(const line of text.split('\n')){const p=document.createElement('p');if(line)p.textContent=line;else{const br=document.createElement('br');br.className='ProseMirror-trailingBreak';p.append(br);}el.append(p);}
  return {holds:composerHoldsFix(el,fixPromptForm(text===window.altered?window.original:text)),innerTextExact:fixPromptForm(el.innerText)===fixPromptForm(window.original)};
 },text);
 await page.evaluate(original=>{window.original=original;},WS_PROMPT);
 assert.deepEqual(await read(WS_PROMPT),{holds:true,innerTextExact:false},'held exactly (innerText would not be)');
 for(const [name,alter] of Object.entries(WS_ALTERATIONS)){
  await page.evaluate(altered=>{window.altered=altered;},alter(WS_PROMPT));
  assert.equal((await read(alter(WS_PROMPT))).holds,false,name);
 }
});

// Control, through the browser's own editing path: a pre-wrap rich editor typed into with
// execCommand insertText holds each line in a <div> (a blank one as <div><br></div>), whose innerText
// adds blank lines; the lossless reading is the prompt exactly, so the fix is filled, never aborted.
test('real DOM: a fix prompt typed into a pre-wrap rich editor is held exactly (control)',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent('<form><div id="prompt-textarea" contenteditable="true" style="white-space:pre-wrap;width:400px;min-height:60px"></div></form>');
 await page.addScriptTag({content:source('extension/composer.js')});
 const out=await page.evaluate(async prompt=>{
  window.__ashlarRunnerState={kind:'fix'};window.composer=()=>document.querySelector('#prompt-textarea');
  const filled=await fillComposer(composer(),prompt).catch(e=>e.code);
  return {filled:filled===prompt,holds:composerHoldsFix(composer(),fixPromptForm(prompt)),innerTextExact:fixPromptForm(composer().innerText)===fixPromptForm(prompt)};
 },WS_PROMPT);
 assert.deepEqual(out,{filled:true,holds:true,innerTextExact:false});
});

test('real DOM: a completed fix with prose around its fence still proves its own tab (can close)',async t=>{
 const code='{"summary":"s","files":[{"path":"a.ts","content":"x"}],"dispositions":[]}';
 const page=await browser.newPage();t.after(()=>page.close());await page.clock.install();
 await setFixContent(page,`<main><section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-A">fix prompt</div></section><section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="response-A"><div class="markdown"><p>Here is the fix.</p><pre><code>${code}</code></pre></div></div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main><form><div id="prompt-textarea" contenteditable="true" style="width:300px;height:60px"></div></form>`);
 await page.evaluate(()=>{
  const saved=new Map([['ashlar:job','fix-A'],['ashlar:run','run-A'],['ashlar:submission:fix-A:run-A',JSON.stringify({phase:'sent',expected:'fix prompt',exact:'fix prompt',baseline:0,submittedUsers:1,messageId:'user-A',conversation:location.href})]]);
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
