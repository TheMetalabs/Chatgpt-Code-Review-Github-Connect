// Tab release (#82), real Chromium pages: once a review or fix leg's result is secured (or nobody
// wants it: cancelled / forgotten), its chat tab has no further use and is closed; the ONLY reason
// to keep it is positive evidence the user took it over (a follow-up turn, a draft that is not
// Ashlar's prompt, an edit of Ashlar's prompt, another conversation or site). ChatGPT's own redraws
// of the answer (a finishing code fence, labels, re-keyed ids, streaming flags) are not user activity.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {source} from './load-source.mjs';
import {background,storage} from './helpers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

test('composer.js can be injected twice into one page (the worker re-injects on a lost receiver): the second copy is in effect',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<main></main>');
 await page.addScriptTag({content:source('extension/composer.js')});
 await page.evaluate(()=>{window.first={clickSend,fillComposer,waitUntilComposer};});
 await page.addScriptTag({content:source('extension/composer.js')});
 assert.deepEqual(errors,[],'a re-injected composer.js must not throw (a top-level const/let redeclaration aborts the whole script)');
 assert.deepEqual(await page.evaluate(()=>Object.entries(window.first).filter(([name,fn])=>globalThis[name]===fn).map(([name])=>name)),[],
  'the re-injected definitions replace the old ones, so new checks (the stop fence) apply to later calls');
});

// ── A provider tab served at a real chatgpt.com URL (real sessionStorage, reloadable), running the
// manifest content scripts in manifest order. `view` is what the next (re)load serves.
const MANIFEST=['composer.js','quota.js','overlay.js','model.js','json.js','content-chatgpt.js'];
const TEMP_URL='https://chatgpt.com/?temporary-chat=true',CONV_URL='https://chatgpt.com/c/ashlar-conv',OTHER_URL='https://chatgpt.com/c/users-own';
const PROMPT='Review fixture PR #1 at abc123. Return the review JSON.';
const ANSWER=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['fixture checked']},null,2);
const actions='<div aria-label="Response actions" role="group"><button data-testid="copy-turn-action-button" aria-label="Copy response" style="width:32px;height:32px">c</button></div>';
const stopButton='<button data-testid="stop-button" aria-label="Stop generating" style="width:32px;height:32px">Stop</button>';
const userTurn=(id='user-A',text=PROMPT)=>`<section data-testid="conversation-turn-${id}"><div data-message-author-role="user" data-message-id="${id}"><div class="whitespace-pre-wrap">${text}</div></div></section>`;
/** The assistant turn as ChatGPT renders a fenced JSON answer (`code`: the code block's text). */
const answerTurn=({code=ANSWER,done=true,id='answer-A'}={})=>`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown"><p>Review below.</p><pre><div><div id="lang">JSON</div><div><button>Copy</button></div></div><div><code id="code">${code.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</code></div></pre></div></div>${done?actions:''}</section>`;
const composerHtml=({composer='',sendDisabled=false,uploading=false})=>`<form data-type="unified-composer"><div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px">${composer}</div>${uploading?'<div role="progressbar" style="width:60px;height:20px">uploading</div>':''}<button id="composer-submit-button" aria-label="Send prompt" style="width:32px;height:32px"${sendDisabled?' disabled':''}>send</button></form>`;
const sentJournal=(extra={})=>({phase:'sent',expected:PROMPT,baseline:0,submittedUsers:1,messageId:'user-A',...extra});

async function chatTab(t,{url=TEMP_URL,kind,job=kind==='fix'?'fix-A':'job-A',run='run-A',bound=true,journal,...view}={}){
 const page=await browser.newPage();t.after(()=>page.close());
 const served={thread:'',composer:'',sendDisabled:false,uploading:false,after:'',...view};
 await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',
  body:`<html><body><main id="thread">${served.thread}</main>${served.after}${composerHtml(served)}</body></html>`}));
 await page.clock.install();
 await page.goto(url);
 await page.evaluate(({job,run,bound,journal})=>{
  if(bound){sessionStorage.setItem('ashlar:job',job);sessionStorage.setItem('ashlar:run',run);}
  if(journal)sessionStorage.setItem(`ashlar:submission:${job}:${run}`,JSON.stringify(journal));
 },{job,run,bound,journal});
 const inject=async()=>{
  await page.evaluate(()=>{
   window.chrome={runtime:{onMessage:{addListener(fn){window.receiver=fn;},removeListener(){}}}};
   window.sendClicks=0;document.querySelector('form').addEventListener('submit',e=>e.preventDefault());
   document.getElementById('composer-submit-button').addEventListener('click',()=>window.sendClicks++);
  });
  for(const file of MANIFEST)await page.addScriptTag({content:source('extension/'+file)});
 };
 await inject();
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),{type,jobId:job,runId:run,provider:'chatgpt',...(kind==='fix'?{kind}:{}),...extra});
 return {page,served,send,inject,job,run,
  reload:async()=>{await page.reload();await inject();},
  steps:()=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'{"events":[]}').events.map(e=>e.stage),`ashlar:steps:${job}:${run}`),
  released:()=>page.evaluate(key=>sessionStorage.getItem(key),`ashlar:released:${job}:${run}`),
  runner:()=>page.evaluate(()=>({running:__ashlarRunnerState.running,code:__ashlarRunnerState.result?.code})),
  clicks:()=>page.evaluate(()=>window.sendClicks),
  enableSend:()=>page.evaluate(()=>{document.querySelector('[role="progressbar"]')?.remove();document.getElementById('composer-submit-button').disabled=false;}),
 };
}

// ── The stop fence: a run the server no longer wants never sends or collects again.
for(const kind of ['review','fix'])test(`${kind}: a cancelled run whose prompt is still unsent never sends it, not even after a reload re-injects the scripts`,async t=>{
 const tab=await chatTab(t,{kind,composer:PROMPT,sendDisabled:true,uploading:true,journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:[]}});
 await tab.send('ashlar-run',{resume:true});
 await tab.page.clock.runFor(1000);
 assert.equal((await tab.runner()).running,true,'waiting for its attachment upload');
 assert.equal((await tab.send('ashlar-fix-cancel')).ok,true);
 await tab.enableSend();await tab.page.clock.runFor(2000);
 assert.equal(await tab.clicks(),0,'the cancelled prompt is never submitted');
 assert.deepEqual(await tab.runner(),{running:false,code:'cancelled'});
 assert.ok((await tab.steps()).includes('cancelled'),'the page records why it stopped');
 // A reload re-binds the page from sessionStorage and the worker resumes observation: still stopped.
 Object.assign(tab.served,{uploading:false,sendDisabled:false});
 await tab.reload();
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(2000);
 assert.equal(await tab.clicks(),0,'the stop marker survives the reload');
 assert.equal((await tab.runner()).code,'cancelled');
});
for(const kind of ['review','fix'])test(`${kind}: a cancelled run's collector ends as "cancelled" while its answer is still generating`,async t=>{
 const tab=await chatTab(t,{kind,thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(1600);
 assert.equal((await tab.runner()).running,true,'still generating');
 await tab.send('ashlar-fix-cancel');await tab.page.clock.runFor(1000);
 assert.deepEqual(await tab.runner(),{running:false,code:'cancelled'});
 const steps=await tab.steps();
 assert.equal(steps.at(-1),'cancelled','recorded as cancelled, not as a provider error');
 assert.equal(steps.includes('error'),false);
});

// ── The close verdict (page side). A review or fix run collects its answer, then the page changes.
async function collected(t,{kind,tail='',url=TEMP_URL,...rest}={}){
 const tab=await chatTab(t,{kind,url,thread:userTurn()+answerTurn({code:ANSWER+tail}),journal:sentJournal(),...rest});
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(2400);
 const out=await tab.send('ashlar-harvest');
 assert.equal(out.ok,true,`collected: ${JSON.stringify(out)}`);
 return {tab,out};
}
const canClose=tab=>tab.send('ashlar-can-close',{allocationUrl:TEMP_URL});
const verdict=out=>({canClose:out.canClose,reason:out.reason,...(out.cause?{cause:out.cause}:{})});

// ChatGPT keeps redrawing a finished answer. None of this is the user's activity.
const REDRAWS=[
 ['the closing code fence finishes drawing after collection ("}\\n`")','\n`',p=>p.locator('#code').evaluate(el=>{el.textContent=el.textContent.replace(/\n`+$/,'');})],
 ['the closing code fence finishes drawing after collection ("}\\n``")','\n``',p=>p.locator('#code').evaluate(el=>{el.textContent=el.textContent.replace(/\n`+$/,'');})],
 ['a late code-block label and an Edit affordance render','',p=>p.locator('#lang').evaluate(el=>{el.textContent='json';el.insertAdjacentHTML('afterend','<span>Edit</span>');})],
 ['the provider re-keys its assistant message id','',p=>p.evaluate(()=>{document.querySelector('[data-message-author-role="assistant"]').dataset.messageId='answer-B';})],
 ['the provider replaces the answer text (no new user turn)','',p=>p.locator('#code').evaluate(el=>{el.textContent='{"findings":[],"merge_recommendation":"REQUEST_CHANGES"}';})],
 ['a streaming indicator and Stop reappear','',p=>p.evaluate(stop=>{document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('afterbegin','<div data-streaming-response-status="streaming" style="width:60px;height:20px">…</div>');document.body.insertAdjacentHTML('beforeend',stop);},stopButton)],
];
for(const kind of ['review','fix'])for(const [name,tail,redraw] of REDRAWS)test(`${kind}: a secured tab may close after ${name}`,async t=>{
 const {tab,out}=await collected(t,{kind,tail});
 if(tail)assert.ok(out.responseText.endsWith(tail),'the fixture reproduces the partial fence frozen at collection');
 await redraw(tab.page);
 assert.deepEqual(verdict(await canClose(tab)),{canClose:true,reason:'complete'});
 assert.equal((await tab.steps()).includes('context_changed'),false,'no takeover recorded');
 assert.equal(await tab.released(),null,'the managed slot is kept until the tab closes');
});

// Positive evidence the user took the tab over: preserved (slot freed), with the cause.
const TAKEOVERS=[
 ['a follow-up turn','user_turn',p=>p.evaluate(html=>document.getElementById('thread').insertAdjacentHTML('beforeend',html),userTurn('user-B','my own question'))],
 ['a draft in the composer','draft',p=>p.evaluate(()=>{document.getElementById('prompt-textarea').textContent='my unsent question';})],
 ['an edit of Ashlar\'s prompt (the turn is replaced)','edited',p=>p.evaluate(html=>{document.querySelector('[data-testid="conversation-turn-user-A"]').outerHTML=html;},userTurn('user-A2','my edited question'))],
];
for(const kind of ['review','fix'])for(const [name,cause,takeover] of TAKEOVERS)test(`${kind}: a secured tab with ${name} is preserved and released`,async t=>{
 const {tab}=await collected(t,{kind});
 await takeover(tab.page);
 assert.deepEqual(verdict(await canClose(tab)),{canClose:false,reason:'repurposed',cause});
 assert.equal(await tab.released(),'true','the preserved tab frees its managed slot');
 assert.ok((await tab.steps()).includes('context_changed'));
});
for(const kind of ['review','fix'])test(`${kind}: a secured tab moved in-page to another conversation (old DOM still rendered) is the user's`,async t=>{
 const {tab}=await collected(t,{kind});
 assert.equal((await canClose(tab)).canClose,true,'control: still in its own conversation');
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 const out=await canClose(tab);
 assert.deepEqual({...verdict(out),identity:out.identity,conversation:out.conversation},{canClose:false,reason:'repurposed',cause:'navigated',identity:'changed',conversation:TEMP_URL});
});

// A reloaded ACKed temporary chat renders nothing: blank on the page it was opened on, so it closes.
for(const kind of ['review','fix'])test(`${kind}: a secured temporary chat reloaded blank still closes; a conversation page not rendered yet waits`,async t=>{
 const {tab}=await collected(t,{kind});
 tab.served.thread='';
 await tab.reload();
 const out=await canClose(tab);
 assert.deepEqual({...verdict(out),blank:out.blank},{canClose:true,reason:'complete',blank:true});
 const conv=await collected(t,{kind,url:CONV_URL});
 conv.tab.served.thread='';await conv.tab.reload();
 assert.deepEqual(verdict(await canClose(conv.tab)),{canClose:false,reason:'pending',cause:'not_rendered'},'nothing rendered on a conversation page proves nothing: asked again');
});

test('review: a run pins its conversation on its exact sent turn, and follows a bare new-chat page to the assigned conversation once',async t=>{
 const temp=await chatTab(t,{thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await temp.send('ashlar-run',{resume:true});await temp.page.clock.runFor(1600);
 const journal=tab=>tab.page.evaluate(()=>JSON.parse(sessionStorage.getItem('ashlar:submission:job-A:run-A')).conversation);
 assert.equal(await journal(temp),TEMP_URL);
 assert.equal((await temp.send('ashlar-harvest')).conversation,TEMP_URL,'every reply reports the pinned conversation');
 const fresh=await chatTab(t,{url:'https://chatgpt.com/',thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await fresh.send('ashlar-run',{resume:true});await fresh.page.clock.runFor(1600);
 assert.equal(await journal(fresh),'https://chatgpt.com/');
 await fresh.page.evaluate(url=>history.pushState({},'',url),CONV_URL);await fresh.page.clock.runFor(1600);
 assert.equal(await journal(fresh),CONV_URL,'upgraded once to the conversation the provider assigned');
 await fresh.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);await fresh.page.clock.runFor(1600);
 assert.equal(await journal(fresh),CONV_URL,'never re-pinned after that');
});
test('an unbound page never answers for a job: can-close and a cancel without the undispatched claim get job_mismatch',async t=>{
 const tab=await chatTab(t,{bound:false});
 assert.equal((await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL})).code,'job_mismatch');
 assert.equal((await tab.send('ashlar-fix-cancel',{allocationUrl:TEMP_URL})).code,'job_mismatch');
 const claimed=await tab.send('ashlar-fix-cancel',{allocationUrl:TEMP_URL,undispatched:true});
 assert.deepEqual({owned:claimed.owned,blank:claimed.blank,releaseProtocol:claimed.releaseProtocol},{owned:true,blank:true,releaseProtocol:1});
 await tab.page.evaluate(()=>{document.getElementById('prompt-textarea').textContent='my own question';});
 const draft=await tab.send('ashlar-fix-cancel',{allocationUrl:TEMP_URL,undispatched:true});
 assert.deepEqual({owned:draft.owned,cause:draft.cause},{owned:false,cause:'draft'});
});

// ── The real worker (vm harness) wired to that page over the message protocol: the job is started
// in tab 10, whose URL follows the page (an in-page pushState is a tab URL update in Chrome) when
// `tick` syncs it. `server.value` is the job status the bridge reports; `onComplete` runs before
// the bridge ACKs a delivered result.
function wire(tab,{kind,server={value:'awaiting_chat'},onComplete,started=true}={}){
 const job={jobId:tab.job,...(kind==='fix'?{kind:'fix'}:{}),origin:'http://bridge',leaseId:'lease-A',prompt:PROMPT,providers:['chatgpt'],
  reasoning:{chatgpt:'pro',grok:'heavy'},states:{chatgpt:{tabId:10,started,runId:tab.run}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{[job.jobId]:job}}),
  tabs:new Map([[10,{id:10,url:tab.page.url(),status:'complete'}]]),
  api:async(_path,body)=>{
   if(body?.action==='ping')return {ok:true,active:server.value==='awaiting_chat',accepted:server.value==='awaiting_chat',status:server.value,bridge:{captureProtocol:1,localJsonRepairEnabled:false}};
   if(body?.action==='complete'&&onComplete)await onComplete(body);
   return {ok:true,job:null};
  }});
 b.context.crypto=webcrypto;b.context.TextEncoder=TextEncoder;
 b.chrome.tabs.sendMessage=(id,msg,callback)=>{
  b.messages.push({id,...msg});
  if(!b.tabs.has(id)){b.chrome.runtime.lastError={message:`No tab with id: ${id}.`};callback();b.chrome.runtime.lastError=null;return;}
  tab.page.evaluate(msg=>new Promise(resolve=>receiver(msg,null,resolve)),msg).then(callback,error=>{
   b.chrome.runtime.lastError={message:error.message};callback();b.chrome.runtime.lastError=null;
  });
 };
 const sync=()=>{const known=b.tabs.get(10);if(known)known.url=tab.page.url();};
 return {b,job,sync,server,state:()=>b.local.state.pendingReviewJobs[job.jobId]?.states.chatgpt,
  tick:async({syncUrl=true}={})=>{if(syncUrl)sync();await b.tick();}};
}
/** A leg whose page collected its answer (tail frozen in), before the worker harvests and delivers it. */
async function collectedLeg(t,{kind,tail='',onComplete,...rest}={}){
 const tab=await chatTab(t,{kind,thread:userTurn()+answerTurn({code:ANSWER+tail}),journal:sentJournal(),...rest});
 const w=wire(tab,{kind,onComplete});
 await w.tick(); // the page has no collector yet: the worker resumes observation (never re-sends)
 await tab.page.clock.runFor(2400);
 assert.equal(await tab.page.evaluate(()=>__ashlarRunnerState.result?.ok),true,'the page collected its answer');
 return {tab,w};
}

// Secured legs: once the bridge ACKed the result, the tab closes whatever ChatGPT redraws.
for(const kind of ['review','fix'])for(const [name,tail,redraw] of REDRAWS)test(`worker, ${kind}: the ACKed tab closes after ${name}`,async t=>{
 const {tab,w}=await collectedLeg(t,{kind,tail});
 await redraw(tab.page);
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
 assert.deepEqual(w.b.closedTabs,[10],'the secured tab is closed');
 assert.equal(w.state(),undefined,'the job retired');
 assert.equal((await tab.steps()).includes('context_changed'),false);
 assert.equal(await tab.released(),null);
 assert.ok(w.b.messages.some(m=>m.type==='ashlar-can-close'&&m.allocationUrl===TEMP_URL),'the worker names the page the tab was opened on');
});
for(const kind of ['review','fix'])test(`worker, ${kind}: an ACKed temporary chat reloaded blank before cleanup still closes`,async t=>{
 let tab;
 const reloadBlank=async()=>{tab.served.thread='';await tab.reload();};
 const leg=await collectedLeg(t,{kind,onComplete:()=>reloadBlank()});
 tab=leg.tab;
 await leg.w.tick();
 assert.deepEqual(leg.w.b.closedTabs,[10]);assert.equal(leg.w.state(),undefined);
});
test('worker: a secured tab closes even while its sent-journal write keeps failing',async t=>{
 const tab=await chatTab(t,{thread:userTurn()+answerTurn(),journal:sentJournal({messageId:''})});
 await tab.page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
  if(key.startsWith('ashlar:submission:')&&JSON.parse(value).phase==='sent')throw new DOMException('fixture quota exceeded','QuotaExceededError');
  return set.call(this,key,value);};});
 const w=wire(tab);
 await w.tick();await tab.page.clock.runFor(2400);
 assert.equal(await tab.page.evaluate(()=>__ashlarRunnerState.submissionPersistencePending),true,'the journal write is still failing');
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[10]);assert.equal(w.state(),undefined);
});
// Secured legs the user took over: preserved (never closed), released, and the job retires.
for(const [name,cause,takeover] of TAKEOVERS)test(`worker: an ACKed tab with ${name} is preserved and released`,async t=>{
 const {tab,w}=await collectedLeg(t,{});
 await takeover(tab.page);
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[]);assert.equal(w.state(),undefined,'the job retired');
 assert.equal(await tab.released(),'true');
});
for(const syncUrl of [true,false])test(`worker: an ACKed tab moved in-page to another conversation is preserved (${syncUrl?'the tab URL already moved':'only the page knows'})`,async t=>{
 const {tab,w}=await collectedLeg(t,{});
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 await w.tick({syncUrl});
 assert.deepEqual(w.b.closedTabs,[]);assert.equal(w.state(),undefined);
 assert.equal(await tab.released(),'true','the preserved tab frees its managed slot');
 assert.equal(w.b.messages.some(m=>m.type==='ashlar-can-close'),!syncUrl,syncUrl?'the worker saw the move itself: the page is not asked':'the page reports the move');
});
