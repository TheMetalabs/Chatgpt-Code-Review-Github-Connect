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
import {sanitizeProgressEvents} from '../../src/lib/review-progress.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

test('composer.js can be injected twice into one page (the worker re-injects on a lost receiver): the second copy is in effect',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<main></main>');
 await page.addScriptTag({content:source('extension/turns.js')});await page.addScriptTag({content:source('extension/composer.js')});
 await page.evaluate(()=>{window.first={clickSend,fillComposer,waitUntilComposer};});
 await page.addScriptTag({content:source('extension/turns.js')});await page.addScriptTag({content:source('extension/composer.js')});
 assert.deepEqual(errors,[],'a re-injected composer.js must not throw (a top-level const/let redeclaration aborts the whole script)');
 assert.deepEqual(await page.evaluate(()=>Object.entries(window.first).filter(([name,fn])=>globalThis[name]===fn).map(([name])=>name)),[],
  'the re-injected definitions replace the old ones, so new checks (the stop fence) apply to later calls');
});

// ── A provider tab served at a real chatgpt.com URL (real sessionStorage, reloadable), running the
// manifest content scripts in manifest order. `view` is what the next (re)load serves.
const MANIFEST=['turns.js','composer.js','quota.js','overlay.js','model.js','json.js','content-chatgpt.js'];
const TEMP_URL='https://chatgpt.com/?temporary-chat=true',CONV_URL='https://chatgpt.com/c/ashlar-conv',OTHER_URL='https://chatgpt.com/c/users-own';
const PROMPT='Review fixture PR #1 at abc123. Return the review JSON.';
const ANSWER=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['fixture checked']},null,2);
const actions='<div aria-label="Response actions" role="group"><button data-testid="copy-turn-action-button" aria-label="Copy response" style="width:32px;height:32px">c</button></div>';
const stopButton='<button data-testid="stop-button" aria-label="Stop generating" style="width:32px;height:32px">Stop</button>';
const userTurn=(id='user-A',text=PROMPT)=>`<section data-testid="conversation-turn-${id}"><div data-message-author-role="user" data-message-id="${id}"><div class="whitespace-pre-wrap">${text}</div></div></section>`;
/** The assistant turn as ChatGPT renders a fenced JSON answer (`code`: the code block's text). */
const answerTurn=({code=ANSWER,done=true,id='answer-A'}={})=>`<section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown"><p>Review below.</p><pre><div><div id="lang">JSON</div><div><button>Copy</button></div></div><div><code id="code">${code.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</code></div></pre></div></div>${done?actions:''}</section>`;
/** A file chip as the composer shows a staged attachment (the named shape attachmentsReady reads). */
const fileChip=name=>`<div role="group" aria-label="${name}" style="width:120px;height:40px">${name}<button aria-label="Remove file">x</button></div>`;
/** `controls`: more of the composer's own controls; `sendTitle`: a tooltip title on the send button. */
const composerHtml=({composer='',sendDisabled=false,uploading=false,chips=[],controls='',sendTitle=''})=>`<form data-type="unified-composer">${chips.map(fileChip).join('')}${controls}<div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px">${composer}</div>${uploading?'<div role="progressbar" style="width:60px;height:20px">uploading</div>':''}<button id="composer-submit-button" aria-label="Send prompt"${sendTitle?` title="${sendTitle}"`:''} style="width:32px;height:32px"${sendDisabled?' disabled':''}>send</button></form>`;
const sentJournal=(extra={})=>({phase:'sent',expected:PROMPT,baseline:0,submittedUsers:1,messageId:'user-A',...extra});

async function chatTab(t,{provider='chatgpt',url=provider==='grok'?'https://grok.com/':TEMP_URL,kind,job=kind==='fix'?'fix-A':'job-A',run='run-A',bound=true,journal,...view}={}){
 // A sent FIX journal carries the conversation its send was proven in (#77: composer.js
 // submissionConfirmed records it then, never later): the page the tab was sent on. A row that
 // needs a journal without it names `conversation: undefined` itself.
 if(kind==='fix'&&journal?.phase==='sent'&&!('conversation' in journal))journal={...journal,conversation:url};
 // A FIX journal also carries its prompt's lossless form from the moment its send is prepared (#77
 // R17: composer.js clickSend records `exact`, fixPromptForm; this single-line prompt is its own).
 // A row that needs a journal without it names `exact: undefined` itself.
 if(kind==='fix'&&journal&&!('exact' in journal))journal={...journal,exact:journal.expected};
 const page=await browser.newPage();t.after(()=>page.close());
 const served={thread:'',composer:'',sendDisabled:false,uploading:false,chips:[],after:'',...view};
 await page.route(provider==='grok'?'https://grok.com/**':'https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',
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
  for(const file of MANIFEST)await page.addScriptTag({content:source('extension/'+(provider==='grok'&&file==='content-chatgpt.js'?'content-grok.js':file))});
 };
 await inject();
 // A run message carries its deadline (until, X4 #85) as the worker's does, on the page's clock.
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>{if(msg.type==='ashlar-run'&&!('until' in msg))msg.until=Date.now()+10_000;receiver(msg,null,resolve);}),
  {type,jobId:job,runId:run,provider,...(kind==='fix'?{kind}:{}),...extra});
 return {page,served,send,inject,job,run,provider,
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
test('a stop that could not be persisted still holds when a late run message reaches the re-bound page',async t=>{
 // After a reload the page is bound from sessionStorage but runs nothing yet; the cancel arrives
 // while marker writes fail, then a late "ashlar-run" resumes the run: it must stay stopped.
 const tab=await chatTab(t,{composer:PROMPT,journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:[]}});
 await tab.page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
  if(key.startsWith('ashlar:stopped:'))throw new DOMException('fixture quota exceeded','QuotaExceededError');return set.call(this,key,value);};});
 assert.equal((await tab.send('ashlar-fix-cancel')).ok,true);
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(2000);
 assert.equal(await tab.clicks(),0,'the prompt is never submitted');
 assert.deepEqual(await tab.runner(),{running:false,code:'cancelled'});
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
 ['the provider replaces the answer under a new message id (no Stop, no variant pager)','',p=>p.evaluate(()=>{const a=document.querySelector('[data-message-author-role="assistant"]');a.dataset.messageId='answer-B';a.querySelector('#code').textContent='{"findings":[],"merge_recommendation":"COMMENT"}';})],
];
// Ashlar 4101062754: a generation cycle on the answer AFTER the page collected it is the user's
// regenerate or retry (neither Ashlar nor a redraw starts one): a Stop control or a streaming flag
// back on the finished answer, or a variant pager ("2/2") it did not have. Preserved, cause
// "regenerated". (The rows above, which change the answer with neither, still close.)
const stopAndStream=p=>p.evaluate(stop=>{document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('afterbegin','<div data-streaming-response-status="streaming" style="width:60px;height:20px">…</div>');document.body.insertAdjacentHTML('beforeend',stop);},stopButton);
const pager='<div class="flex"><button aria-label="Previous response" style="width:20px;height:20px">‹</button><div class="tabular-nums">2/2</div><button aria-label="Next response" style="width:20px;height:20px">›</button></div>';
const REGENERATIONS=[
 ['a streaming indicator and Stop reappear on the finished answer',stopAndStream],
 ['the user regenerates: a new answer streams under a new message id',p=>p.evaluate(()=>{const a=document.querySelector('[data-message-author-role="assistant"]');a.dataset.messageId='answer-B';a.querySelector('#code').textContent='{"findings":[';}).then(()=>stopAndStream(p))],
 ['the user regenerated and the new answer already finished (the variant pager shows 2/2)',p=>p.evaluate(pager=>{const a=document.querySelector('[data-message-author-role="assistant"]');a.dataset.messageId='answer-B';a.querySelector('#code').textContent='{"findings":[],"merge_recommendation":"COMMENT"}';document.querySelector('[aria-label="Response actions"]').insertAdjacentHTML('beforeend',pager);},pager)],
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
const stageFile=p=>p.evaluate(html=>document.querySelector('form').insertAdjacentHTML('afterbegin',html),fileChip('my-notes.pdf'));
for(const kind of ['review','fix'])for(const [name,regenerate] of REGENERATIONS)test(`${kind}: a secured tab where ${name} is preserved as regenerated`,async t=>{
 const {tab}=await collected(t,{kind});
 await regenerate(tab.page);
 assert.deepEqual(verdict(await canClose(tab)),{canClose:false,reason:'repurposed',cause:'regenerated'});
 assert.equal(await tab.released(),'true','the preserved tab frees its managed slot');
 assert.ok((await tab.steps()).includes('context_changed'));
});
// Ashlar finding on 5d646137 (R2): the regeneration evidence lived only in the page's memory. A page
// reloaded after the answer was secured (Chrome discarded the tab and the cleanup's own wake reloaded
// it, or an extension update re-injected the scripts) has a fresh runner that never completed the
// answer, so a Stop, a streaming flag or a pager was ignored and the tab closed during the user's
// regeneration. The worker asks can-close only for a secured answer and says so (`secured`).
const RELOADED_REGENERATIONS=[
 ['the regeneration finished (a 2/2 pager)',async tab=>{
  await tab.page.evaluate(pager=>{const a=document.querySelector('[data-message-author-role="assistant"]');a.dataset.messageId='answer-B';a.querySelector('#code').textContent='{"findings":[],"merge_recommendation":"COMMENT"}';document.querySelector('[aria-label="Response actions"]').insertAdjacentHTML('beforeend',pager);},pager);
  tab.served.thread=await tab.page.evaluate(()=>document.getElementById('thread').innerHTML);
  await tab.reload();
 }],
 ['the regeneration is still streaming (Stop and a streaming flag)',async tab=>{
  tab.served.thread=await tab.page.evaluate(()=>document.getElementById('thread').innerHTML);tab.served.after=stopButton;
  await tab.reload();
  await tab.page.evaluate(()=>{document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('afterbegin','<div data-streaming-response-status="streaming" style="width:60px;height:20px">…</div>');});
 }],
];
for(const kind of ['review','fix'])for(const [name,regenerateAndReload] of RELOADED_REGENERATIONS)test(`${kind}: a secured tab reloaded after the user regenerated (${name}) is preserved as regenerated`,async t=>{
 const {tab}=await collected(t,{kind});
 await regenerateAndReload(tab);
 assert.equal(await tab.page.evaluate(()=>Boolean(__ashlarRunnerState.result||__ashlarRunnerState.nativeCompletion)),false,'fixture: the reloaded page never completed the answer itself');
 assert.deepEqual(verdict(await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL,secured:true})),{canClose:false,reason:'repurposed',cause:'regenerated'});
 assert.equal(await tab.released(),'true','the preserved tab frees its managed slot');
});
for(const kind of ['review','fix'])test(`${kind}: control: a secured tab reloaded with no regeneration still closes`,async t=>{
 const {tab}=await collected(t,{kind});
 tab.served.thread=await tab.page.evaluate(()=>document.getElementById('thread').innerHTML);
 await tab.reload();
 assert.deepEqual(verdict(await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL,secured:true})),{canClose:true,reason:'complete'});
});
const TAKEOVERS=[
 ['a follow-up turn','user_turn',p=>p.evaluate(html=>document.getElementById('thread').insertAdjacentHTML('beforeend',html),userTurn('user-B','my own question'))],
 ['a draft in the composer','draft',p=>p.evaluate(()=>{document.getElementById('prompt-textarea').textContent='my unsent question';})],
 ['an edit of Ashlar\'s prompt (the turn is replaced)','edited',p=>p.evaluate(html=>{document.querySelector('[data-testid="conversation-turn-user-A"]').outerHTML=html;},userTurn('user-A2','my edited question'))],
 ['a file the user staged in the composer (no text yet)','draft',p=>stageFile(p)],
];
for(const kind of ['review','fix'])for(const [name,cause,takeover] of TAKEOVERS)test(`${kind}: a secured tab with ${name} is preserved and released`,async t=>{
 const {tab}=await collected(t,{kind});
 await takeover(tab.page);
 assert.deepEqual(verdict(await canClose(tab)),{canClose:false,reason:'repurposed',cause});
 assert.equal(await tab.released(),'true','the preserved tab frees its managed slot');
 assert.ok((await tab.steps()).includes('context_changed'));
});
// #77 R17 at release: a fix's sent turn is held to its prompt's lossless form (json.js fixTurnExact),
// so an edit that changes only whitespace (a fix prompt inlines source, whose spaces are content) is
// the user's too. A review compares its normalized prompt: the same edit leaves its tab closable.
for(const kind of ['review','fix'])test(`${kind}: a secured tab whose sent turn the user edited in whitespace only is ${kind==='fix'?'preserved as edited':'still closable (control)'}`,async t=>{
 const {tab}=await collected(t,{kind});
 await tab.page.evaluate(()=>{const body=document.querySelector('[data-message-id="user-A"] .whitespace-pre-wrap');body.textContent=body.textContent.replace(' at ','  at ');});
 assert.deepEqual(verdict(await canClose(tab)),kind==='fix'?{canClose:false,reason:'repurposed',cause:'edited'}:{canClose:true,reason:'complete'});
});
// Ashlar 4101623051: every file-chip shape the send barrier accepts is a staged file for the release
// verdict too (composer.js fileChipSelector: one list for attachmentsReady and composerStagedFiles), a
// chip that names its file only in its title included.
const CHIP_SHAPES=[
 ['a named group',name=>`<div role="group" aria-label="${name}" style="width:120px;height:40px">${name}<button aria-label="Remove file">x</button></div>`],
 ['a data-file-name tile',name=>`<div data-file-name="${name}" style="width:120px;height:40px">${name}<button aria-label="Remove file">x</button></div>`],
 ['a title-only chip',name=>`<div title="${name}" style="width:120px;height:40px">${name}<button aria-label="Remove file">x</button></div>`],
];
const stageChip=(page,chip,name)=>page.evaluate(html=>document.querySelector('form').insertAdjacentHTML('afterbegin',html),chip(name));
for(const [shape,chip] of CHIP_SHAPES){
 test(`the send barrier and the release verdict read the same file chip (${shape})`,async t=>{
  const tab=await chatTab(t,{bound:false});
  await stageChip(tab.page,chip,'my-notes.pdf');
  assert.deepEqual(await tab.page.evaluate(()=>({ready:attachmentsReady(document.querySelector('form'),['my-notes.pdf']),staged:composerStagedFiles(null,null)})),
   {ready:true,staged:['my-notes.pdf']});
 });
 for(const kind of ['review','fix'])test(`${kind}: a secured tab where the user staged a file (${shape}) is preserved as a draft, never closed`,async t=>{
  const {tab}=await collected(t,{kind});
  await stageChip(tab.page,chip,'my-notes.pdf');
  const out=await canClose(tab);
  assert.deepEqual({...verdict(out),ownership:out.ownership},{canClose:false,reason:'repurposed',cause:'draft',ownership:'takenOver'});
 });
 test(`review: an undispatched page where the user staged a file (${shape}) is not blank: never claimed as Ashlar's`,async t=>{
  const tab=await chatTab(t,{bound:false});
  await stageChip(tab.page,chip,'my-notes.pdf');
  const out=await tab.send('ashlar-fix-cancel',{allocationUrl:TEMP_URL,undispatched:true});
  assert.deepEqual({owned:out.owned,canClose:out.canClose,ownership:out.ownership,blank:out.blank,cause:out.cause},{owned:false,canClose:false,ownership:'takenOver',blank:false,cause:'draft'});
 });
 // A named element inside a chip (its icon's title, its remove control's title) is part of that
 // chip, not another file: before the send, the run's own chip is still its own.
 test(`worker, review: a leg cancelled while its own attachment (${shape}, its icon and remove control titled) still uploads is closed: its own file is not a draft`,async t=>{
  const own=name=>chip(name).replace('<button aria-label="Remove file">','<span title="Patch file">p</span><button title="Remove file" aria-label="Remove file">');
  const tab=await chatTab(t,{composer:PROMPT,sendDisabled:true,uploading:true,journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:['diff.patch']}});
  await stageChip(tab.page,own,'diff.patch');
  const w=wire(tab);
  await w.tick();await tab.page.clock.runFor(1000);
  assert.equal((await tab.runner()).running,true,'waiting for its attachment upload');
  w.server.value='cancelled';
  await w.tick();
  assert.deepEqual(w.b.closedTabs,[10]);assert.equal(w.state(),undefined);
 });
}
// Ashlar, review of 5af999fd: only a chip that names a file takes in the elements inside it. An
// element in a chip shape that names nothing (an empty or blank title, an empty group label) is no
// chip, so a wrapper like that never hides the user's named chip inside it: the tab is kept.
const UNNAMED_WRAPPERS=[
 ['an empty-title wrapper',html=>`<div title="" style="display:flex">${html}</div>`],
 ['a whitespace-title wrapper',html=>`<div title=" " style="display:flex">${html}</div>`],
 ['an empty-label group',html=>`<div role="group" aria-label="" style="display:flex">${html}</div>`],
];
const tileChip=CHIP_SHAPES.find(([shape])=>shape==='a data-file-name tile')[1];
for(const [wrapper,wrap] of UNNAMED_WRAPPERS){
 const wrapped=name=>wrap(tileChip(name));
 for(const kind of ['review','fix'])test(`${kind}: a secured tab where the user's staged file sits inside ${wrapper} is preserved as a draft, never closed`,async t=>{
  const {tab}=await collected(t,{kind});
  await stageChip(tab.page,wrapped,'my-notes.pdf');
  assert.deepEqual(await tab.page.evaluate(()=>composerStagedFiles(null,{phase:'sent'})),['my-notes.pdf']);
  const out=await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL,secured:true});
  assert.deepEqual({...verdict(out),ownership:out.ownership},{canClose:false,reason:'repurposed',cause:'draft',ownership:'takenOver'});
 });
 test(`review: an undispatched page where the user's staged file sits inside ${wrapper} is not blank: never claimed as Ashlar's`,async t=>{
  const tab=await chatTab(t,{bound:false});
  await stageChip(tab.page,wrapped,'my-notes.pdf');
  const out=await tab.send('ashlar-fix-cancel',{allocationUrl:TEMP_URL,undispatched:true});
  assert.deepEqual({owned:out.owned,canClose:out.canClose,ownership:out.ownership,blank:out.blank,cause:out.cause},{owned:false,canClose:false,ownership:'takenOver',blank:false,cause:'draft'});
 });
}
// Ashlar, review of 5af999fd: the composer's own titled controls are not title-only file chips. The
// title on a control is its tooltip, so neither the send barrier nor the release verdict reads it as
// a file (composer.js fileChips, one list for both): a secured review or fix tab closes, a fix run
// delivers its answer instead of ending taken_over, and an undispatched blank page closes.
const TITLED_CONTROLS=[
 ['a titled send button',{sendTitle:'Send prompt'},'Send prompt'],
 ['a titled voice button',{controls:'<button type="button" title="Start voice mode" aria-label="Start voice mode" style="width:32px;height:32px">v</button>'},'Start voice mode'],
 ['a titled model menu',{controls:'<span aria-haspopup="menu" title="GPT-5 Thinking" style="display:inline-block;width:60px;height:20px">GPT-5</span>'},'GPT-5 Thinking'],
 ['a titled tool pill (role=button)',{controls:'<div role="button" tabindex="0" title="Search the web" style="width:60px;height:20px">Search</div>'},'Search the web'],
 ['a titled help link',{controls:'<a href="/help" title="Help and shortcuts" style="display:inline-block;width:20px;height:20px">?</a>'},'Help and shortcuts'],
 ['a titled attach label',{controls:'<label title="Attach files" style="display:inline-block;width:20px;height:20px">+<input type="file" hidden></label>'},'Attach files'],
];
for(const [control,view,title] of TITLED_CONTROLS){
 test(`the send barrier and the release verdict both read ${control} as the composer's, not a file`,async t=>{
  const tab=await chatTab(t,{bound:false,...view});
  assert.deepEqual(await tab.page.evaluate(title=>({ready:attachmentsReady(document.querySelector('form'),[title]),staged:composerStagedFiles(null,null)}),title),
   {ready:false,staged:[]});
 });
 for(const kind of ['review','fix'])test(`${kind}: a secured tab whose composer has ${control} is Ashlar's and closes`,async t=>{
  const {tab}=await collected(t,{kind,...view}); // a fix run's own collection delivers (never taken_over)
  const out=await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL,secured:true});
  assert.deepEqual({...verdict(out),ownership:out.ownership},{canClose:true,reason:'complete',ownership:'owned'});
 });
 for(const kind of ['review','fix'])test(`worker, ${kind}: a leg whose composer has ${control} delivers its answer and its ACKed tab closes`,async t=>{
  const {tab,w}=await collectedLeg(t,{kind,...view});
  await w.tick();
  assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
  assert.equal(w.b.calls.some(c=>c.action==='failure'),false,'never ended as taken_over');
  assert.deepEqual(w.b.closedTabs,[10]);assert.equal(w.state(),undefined);
  assert.equal((await tab.steps()).includes('context_changed'),false);
 });
 test(`review: an undispatched page whose composer has ${control} is blank: the worker may close it`,async t=>{
  const tab=await chatTab(t,{bound:false,...view});
  const out=await tab.send('ashlar-fix-cancel',{allocationUrl:TEMP_URL,undispatched:true});
  assert.deepEqual({owned:out.owned,canClose:out.canClose,ownership:out.ownership,blank:out.blank},{owned:true,canClose:true,ownership:'owned',blank:true});
 });
}
// Control: next to those controls, the user's title-only chip is still the one staged file.
for(const kind of ['review','fix'])test(`${kind}: the user's title-only chip next to the composer's titled controls is the only staged file: preserved as a draft`,async t=>{
 const {tab}=await collected(t,{kind,sendTitle:'Send prompt',controls:TITLED_CONTROLS.map(([, view])=>view.controls||'').join('')});
 await stageChip(tab.page,CHIP_SHAPES.find(([shape])=>shape==='a title-only chip')[1],'my-notes.pdf');
 assert.deepEqual(await tab.page.evaluate(()=>composerStagedFiles(null,{phase:'sent'})),['my-notes.pdf']);
 const out=await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL,secured:true});
 assert.deepEqual({...verdict(out),ownership:out.ownership},{canClose:false,reason:'repurposed',cause:'draft',ownership:'takenOver'});
});
for(const kind of ['review','fix'])test(`${kind}: a secured tab moved in-page to another conversation (old DOM still rendered) is the user's`,async t=>{
 const {tab}=await collected(t,{kind});
 assert.equal((await canClose(tab)).canClose,true,'control: still in its own conversation');
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 const out=await canClose(tab);
 assert.deepEqual({...verdict(out),identity:out.identity,conversation:out.conversation},{canClose:false,reason:'repurposed',cause:'navigated',identity:'changed',conversation:TEMP_URL});
});

// #77 (round 13) under the one release rule: a sent FIX journal that recorded no conversation (a
// legacy journal, or a send confirmed only after a reload) can never establish it, so its tab is
// never closed: "unestablished", slot freed (the worker preserves it at once). A REVIEW journal
// without one is `unpinned` (#82: a review sent on a new chat pins later, and the worker checks the
// page it observed), so the same page closes. A review's two exits answer the same verdict; a fix
// page's cancel exit carries none (#77: a cancel never closes a fix tab), it only releases the slot.
for(const kind of ['review','fix'])test(`${kind}: a sent journal that recorded no conversation ${kind==='fix'?'is never closed ("unestablished", slot freed)':'is unpinned: the worker decides by the page it observed'}`,async t=>{
 const tab=await chatTab(t,{kind,thread:userTurn()+answerTurn(),journal:sentJournal({conversation:undefined})});
 for(const type of ['ashlar-can-close','ashlar-fix-cancel']){
  const out=await tab.send(type,{allocationUrl:TEMP_URL});
  assert.deepEqual({canClose:out.canClose,ownership:out.ownership,identity:out.identity,unpinned:out.unpinned},
   kind==='fix'?(type==='ashlar-can-close'?{canClose:false,ownership:'unknown',identity:'unestablished',unpinned:undefined}:{canClose:undefined,ownership:undefined,identity:undefined,unpinned:undefined})
    :{canClose:true,ownership:'owned',identity:undefined,unpinned:true},type);
 }
 assert.equal(await tab.released(),kind==='fix'?'true':null);
});

// The query is not the page (#82: origin + path): ChatGPT's `?temporary-chat=true` names a mode, not
// another conversation, so a run bound on one form of the new-chat URL is still in its conversation
// on the other (json.js samePage). A FIX is the exception at its send only (#77): it is proven only
// when it was sent in the temporary chat (json.js fixSentInTemporaryChat), so a fix sent on the bare
// "/" is never collected, and its tab never closed, whatever the URL reads later.
const QUERY_FORMS=[[TEMP_URL,'https://chatgpt.com/'],['https://chatgpt.com/',TEMP_URL]];
test('fix: a run sent on https://chatgpt.com/ (not the temporary chat) is never collected, whatever its URL reads later; its tab is never closed',async t=>{
 const tab=await chatTab(t,{kind:'fix',url:'https://chatgpt.com/',thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(1600);
 await tab.page.evaluate(url=>history.replaceState(history.state,'',url),TEMP_URL);
 await finish(tab.page);await tab.page.clock.runFor(2400);
 const out=await tab.send('ashlar-harvest');
 assert.deepEqual({ok:out.ok,code:out.code},{ok:false,code:'taken_over'},'the run ends: the send-time identity is not the temporary chat');
 // its run ended on the permanent verdict (json.js endFixRun), so the tab is the user's for good
 assert.deepEqual(verdict(await canClose(tab)),{canClose:false,reason:'repurposed',cause:'ownership_unknown'});
 assert.equal(await tab.released(),'true','its managed slot is freed');
});
for(const kind of ['review','fix'])for(const [from,to] of QUERY_FORMS){
 if(kind==='fix'&&from!==TEMP_URL)continue; // a fix is sent only in the temporary chat (the row above)
 test(`${kind}: a secured tab bound on ${from} may still close once its URL reads ${to}`,async t=>{
  const {tab}=await collected(t,{kind,url:from});
  assert.equal(await pinnedIn(tab),from);
  await tab.page.evaluate(url=>history.replaceState(history.state,'',url),to);
  const out=await canClose(tab);
  assert.deepEqual({...verdict(out),conversation:out.conversation},{canClose:true,reason:'complete',conversation:from});
 });
 test(`${kind}: a run bound on ${from} still collects its answer once its URL reads ${to}`,async t=>{
  const tab=await chatTab(t,{kind,url:from,thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
  await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(1600);
  if(kind==='fix')assert.equal(await pinnedIn(tab),from,'a fix\'s conversation is the one its send recorded (never re-pinned at collect)');
  await tab.page.evaluate(url=>history.replaceState(history.state,'',url),to);
  await finish(tab.page);await tab.page.clock.runFor(2400);
  const out=await tab.send('ashlar-harvest');
  assert.equal(out.ok,true,`collected: ${JSON.stringify({code:out.code,proof:out.proof})}`);
 });
}

// A reloaded ACKed temporary chat renders nothing: blank on the page it was opened on, so it closes.
for(const kind of ['review','fix'])test(`${kind}: a secured temporary chat reloaded blank still closes${kind==='review'?'; a conversation page not rendered yet waits':''}`,async t=>{
 const {tab}=await collected(t,{kind});
 tab.served.thread='';
 await tab.reload();
 const out=await canClose(tab);
 assert.deepEqual({...verdict(out),blank:out.blank},{canClose:true,reason:'complete',blank:true});
 // (a fix is never secured on a conversation page: it is proven only in the temporary chat, #77)
 if(kind==='fix')return;
 // (a review sent on a conversation page records it at send: composer.js submissionConfirmed)
 const conv=await collected(t,{kind,url:CONV_URL,journal:sentJournal({conversation:CONV_URL})});
 conv.tab.served.thread='';await conv.tab.reload();
 assert.deepEqual(verdict(await canClose(conv.tab)),{canClose:false,reason:'pending',cause:'not_rendered'},'nothing rendered on a conversation page proves nothing: asked again');
});

/** The generating answer completes: Stop goes, the response actions render. */
const finish=page=>page.evaluate(actions=>{document.querySelector('[data-testid="stop-button"]').remove();document.querySelector('[data-testid="conversation-turn-2"]').insertAdjacentHTML('beforeend',actions);},actions);
const pinnedIn=tab=>tab.page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).conversation,`ashlar:submission:${tab.job}:${tab.run}`);
test('review: on a new chat that names no conversation yet, a run pins its conversation once the provider assigns one or its answer completes; never replaced',async t=>{
 // A temporary chat keeps its URL: pinned there when the answer completes (not while generating).
 const temp=await chatTab(t,{thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await temp.send('ashlar-run',{resume:true});await temp.page.clock.runFor(1600);
 assert.equal(await pinnedIn(temp),undefined,'not pinned on the new-chat page while generating');
 await finish(temp.page);await temp.page.clock.runFor(1600);
 assert.equal(await pinnedIn(temp),TEMP_URL,'pinned where its answer completed');
 assert.equal((await temp.send('ashlar-harvest')).conversation,TEMP_URL,'every reply reports the pinned conversation');
 // The provider assigns the conversation URL after the send (no user action): pinned there.
 const fresh=await chatTab(t,{url:'https://chatgpt.com/',thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await fresh.send('ashlar-run',{resume:true});await fresh.page.clock.runFor(1600);
 await fresh.page.evaluate(url=>history.replaceState(history.state,'',url),CONV_URL);await fresh.page.clock.runFor(1600);
 assert.equal(await pinnedIn(fresh),CONV_URL,'pinned in the conversation the provider assigned');
 // Once pinned, a later location never replaces it.
 await fresh.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);await fresh.page.clock.runFor(1600);
 await finish(fresh.page);await fresh.page.clock.runFor(1600);
 assert.equal(await pinnedIn(fresh),CONV_URL,'never re-pinned by a later location');
 assert.equal((await fresh.send('ashlar-can-close',{allocationUrl:TEMP_URL})).identity,'changed');
});
// Ashlar 4101062732: a review sent on a new chat pins only a provider move its page watched happen
// while the run was in flight (json.js newChatPin). A collector that first sees the run on another
// conversation page (the user moved in-page before its first poll, the old DOM still rendered; a
// resumed or reloaded page) never pins that URL, and an unpinned review is Ashlar's only on its new
// chat: both exits refuse it and the worker keeps the tab. An unpinned sent turn must be EXACTLY the
// prompt: the prompt plus the user's own text is an edit.
for(const generating of [true,false])test(`review: a new-chat review moved in-page to another conversation before its collector's first poll (${generating?'still generating':'answer complete'}, old DOM rendered) never pins it; neither exit returns owned`,async t=>{
 const tab=await chatTab(t,{thread:userTurn()+answerTurn({done:!generating}),...(generating?{after:stopButton}:{}),journal:sentJournal()});
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(1600);
 if(generating){await finish(tab.page);await tab.page.clock.runFor(1600);}
 await tab.page.clock.runFor(2400);
 assert.equal(await tab.page.evaluate(()=>__ashlarRunnerState.result?.ok),true,'its answer is collected (the harvest is not the release)');
 assert.equal(await pinnedIn(tab),undefined,'the user\'s conversation is never pinned');
 for(const type of ['ashlar-can-close','ashlar-fix-cancel']){
  const out=await tab.send(type,{allocationUrl:TEMP_URL});
  assert.deepEqual({owned:out.owned,canClose:out.canClose,ownership:out.ownership,identity:out.identity,cause:out.cause},
   {owned:false,canClose:false,ownership:'unknown',identity:'changed',cause:'navigated'},type);
 }
 assert.equal(await tab.released(),'true','the kept tab frees its managed slot');
});
test('review: a new-chat review whose sent turn the user edited to the prompt plus their own text before it pinned: never pinned, and neither exit returns owned',async t=>{
 const tab=await chatTab(t,{thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(1600);
 await tab.page.evaluate(text=>{document.querySelector('[data-message-id="user-A"] .whitespace-pre-wrap').textContent=text;},PROMPT+' Also check my own branch.');
 await finish(tab.page);await tab.page.clock.runFor(2400);
 assert.equal(await pinnedIn(tab),undefined,'not pinned: the turn is not exactly the prompt');
 for(const type of ['ashlar-can-close','ashlar-fix-cancel']){
  const out=await tab.send(type,{allocationUrl:TEMP_URL});
  assert.deepEqual({owned:out.owned,canClose:out.canClose,ownership:out.ownership,cause:out.cause},{owned:false,canClose:false,ownership:'takenOver',cause:'edited'},type);
 }
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
function wire(tab,{kind,server={value:'awaiting_chat'},onComplete,started=true,jobId=tab.job,runId=tab.run,state={},job:extra={},session,local}={}){
 const provider=tab.provider||'chatgpt';
 const job={jobId,...(kind==='fix'?{kind:'fix'}:{}),origin:'http://bridge',leaseId:'lease-A',prompt:PROMPT,providers:[provider],
  reasoning:{chatgpt:'pro',grok:'heavy'},states:{[provider]:{tabId:10,started,runId,...state}},...extra};
 const b=background({local:local||storage({origin:'http://bridge',token:'token',pendingReviewJobs:{[job.jobId]:job}}),session,
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
 return {b,job,sync,server,provider,state:()=>b.local.state.pendingReviewJobs[job.jobId]?.states[provider],
  tick:async({syncUrl=true}={})=>{if(syncUrl)sync();await b.tick();},
  // Past the bounded ownership wait (the worker reads Date.now; nothing waits on a timer).
  later:()=>{const RealDate=b.context.Date||Date;const at=RealDate.now()+3*60_000;b.context.Date=class extends RealDate{static now(){return at;}};}};
}
/** What review history receives: the last progress upload, through the server's own sanitizer. */
const uploadedSteps=w=>sanitizeProgressEvents(w.b.calls.filter(c=>c.action==='progress').at(-1)?.progress?.[w.provider||'chatgpt']?.events).map(e=>`${e.source}:${e.stage}`);
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
// Secured legs the user took over: preserved (never closed), released, and the job retires. Nobody
// cancelled them: the release also stops the page's run, but history never says it was cancelled.
for(const kind of ['review','fix'])for(const [name,cause,takeover] of TAKEOVERS)test(`worker, ${kind}: an ACKed tab with ${name} is preserved and released, and history says why`,async t=>{
 // (a fix answer is handed out only while its page proves the tab is Ashlar's, #77: the user takes
 // the fix tab over after the answer was harvested, before the bridge ACKs it)
 let page;
 const {tab,w}=await collectedLeg(t,{kind,onComplete:kind==='fix'?()=>takeover(page):undefined});
 page=tab.page;
 if(kind!=='fix')await takeover(tab.page);
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
 assert.deepEqual(w.b.closedTabs,[]);assert.equal(w.state(),undefined,'the job retired');
 assert.equal(await tab.released(),'true');
 const steps=uploadedSteps(w);
 for(const stage of ['page:context_changed',`worker:preserve_${cause}`,'worker:tab_preserved'])assert.ok(steps.includes(stage),`${stage} in ${steps}`);
 assert.equal(steps.includes('page:cancelled'),false,`a secured leg is never reported as cancelled: ${steps}`);
});
// Ashlar 4101062749: a review sent with an attachment named diff.patch, its result secured; the user
// then stages their own file with that name. A confirmed send took Ashlar's attachment out of the
// composer, so the chip is the user's draft: the name of the run's old upload is no exemption.
const withAttachment={journal:sentJournal({attachments:['diff.patch']})};
const ownUploads=page=>page.evaluate(()=>{__ashlarRunnerState.pendingAttachments=['diff.patch'];}); // as fillComposer left them
test('review: a secured tab where the user staged a file named like the run\'s sent attachment is preserved as a draft',async t=>{
 const {tab}=await collected(t,withAttachment);
 await ownUploads(tab.page);
 assert.deepEqual(verdict(await canClose(tab)),{canClose:true,reason:'complete'},'control: nothing staged');
 await tab.page.evaluate(html=>document.querySelector('form').insertAdjacentHTML('afterbegin',html),fileChip('diff.patch'));
 assert.deepEqual(verdict(await canClose(tab)),{canClose:false,reason:'repurposed',cause:'draft'});
 assert.equal(await tab.released(),'true');
});
test('worker, review: an ACKed tab where the user staged a file named like the run\'s sent attachment is preserved, never closed',async t=>{
 const {tab,w}=await collectedLeg(t,withAttachment);
 await ownUploads(tab.page);
 await tab.page.evaluate(html=>document.querySelector('form').insertAdjacentHTML('afterbegin',html),fileChip('diff.patch'));
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
 assert.deepEqual(w.b.closedTabs,[],'the user\'s staged file is not lost with the tab');assert.equal(w.state(),undefined,'the job retired');
 assert.ok(uploadedSteps(w).includes('worker:preserve_draft'),`${uploadedSteps(w)}`);
});
for(const kind of ['review','fix'])for(const [name,regenerate] of REGENERATIONS)test(`worker, ${kind}: an ACKed tab where ${name} is preserved, never closed`,async t=>{
 const {tab,w}=await collectedLeg(t,{kind});
 await regenerate(tab.page);
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'Ashlar\'s collected answer is delivered');
 assert.deepEqual(w.b.closedTabs,[],'the user\'s regeneration is not closed');assert.equal(w.state(),undefined,'the job retired');
 assert.equal(await tab.released(),'true');
 assert.ok(uploadedSteps(w).includes('worker:preserve_regenerated'),`${uploadedSteps(w)}`);
});
test('worker: an ACKed tab whose URL differs from its bound conversation only in the query closes',async t=>{
 const {tab,w}=await collectedLeg(t,{});
 assert.equal(await pinnedIn(tab),TEMP_URL);
 await tab.page.evaluate(url=>history.replaceState(history.state,'',url),'https://chatgpt.com/');
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
 assert.deepEqual(w.b.closedTabs,[10]);assert.equal(w.state(),undefined);
});
for(const syncUrl of [true,false])test(`worker: an ACKed tab moved in-page to another conversation is preserved (${syncUrl?'the tab URL already moved':'only the page knows'})`,async t=>{
 const {tab,w}=await collectedLeg(t,{});
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 await w.tick({syncUrl});
 assert.deepEqual(w.b.closedTabs,[]);assert.equal(w.state(),undefined);
 assert.ok(uploadedSteps(w).includes('worker:preserve_navigated'),'the preserve cause reaches history');
 assert.equal(await tab.released(),'true','the preserved tab frees its managed slot');
 assert.equal(w.b.messages.some(m=>m.type==='ashlar-can-close'),!syncUrl,syncUrl?'the worker saw the move itself: the page is not asked':'the page reports the move');
});

// ── A provider assigns the conversation's URL after the send (ChatGPT's bare new chat, or a
// temporary chat it does not honour: "/" becomes "/c/<id>"; Grok's home likewise). That is the job's
// own conversation, not a user's move: the secured or unwanted tab still closes.
const PROVIDER_MOVES=[
 ['ChatGPT, replaceState','chatgpt','https://chatgpt.com/','https://chatgpt.com/c/provider-assigned','replace'],
 ['ChatGPT temporary chat not honoured, pushState','chatgpt',TEMP_URL,'https://chatgpt.com/c/provider-assigned','push'],
 ['Grok','grok','https://grok.com/','https://grok.com/c/provider-assigned','replace'],
];
const assign=(page,url,how)=>page.evaluate(([url,how])=>{if(how==='push')history.pushState({},'',url);else history.replaceState(history.state,'',url);},[url,how]);
for(const [name,provider,from,to,how] of PROVIDER_MOVES){
 test(`worker, review (${name}): the provider assigns the conversation URL while generating; the ACKed tab closes`,async t=>{
  const tab=await chatTab(t,{provider,url:from,thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
  const w=wire(tab);
  await w.tick();await tab.page.clock.runFor(1600);
  await assign(tab.page,to,how);await tab.page.clock.runFor(800);
  await finish(tab.page);await tab.page.clock.runFor(2400);
  assert.equal(await tab.page.evaluate(()=>__ashlarRunnerState.result?.ok),true,'collected');
  await w.tick();
  assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
  assert.deepEqual(w.b.closedTabs,[10],`the secured tab is closed: ${uploadedSteps(w)}`);
  assert.equal(w.state(),undefined,'the job retired');
  assert.equal(await pinnedIn(tab),to,'pinned in the conversation the provider assigned');
 });
 for(const polled of [true,false])test(`worker, review (${name}): cancelled while generating after the provider assigned the conversation URL (${polled?'polled there':'not polled since'}); the tab closes`,async t=>{
  const tab=await chatTab(t,{provider,url:from,thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
  const w=wire(tab);
  await w.tick();await tab.page.clock.runFor(1600);
  await assign(tab.page,to,how);await tab.page.clock.runFor(800);
  if(polled)await w.tick();
  w.server.value='cancelled';
  await w.tick();
  assert.deepEqual(w.b.closedTabs,[10],`the unwanted tab is closed: ${uploadedSteps(w)}`);
  assert.equal(w.state(),undefined,'the job retired');
 });
}

// Ashlar 4101062732, the worker side: the page's collector never saw the new chat after the send, so
// the conversation page it answered on is no identity (it may be the user's): the ACKed tab is kept.
// So is one whose unpinned turn the user edited. Control: a review this page itself sent on the new
// chat, which the provider moved before the collector's first poll while it was still generating,
// pins where the provider put it and closes.
test('worker, review: a new-chat review whose tab moved to another conversation before its collector saw the new chat is preserved, never closed',async t=>{
 const tab=await chatTab(t,{thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 const w=wire(tab);
 await w.tick();await tab.page.clock.runFor(1600);
 await finish(tab.page);await tab.page.clock.runFor(2400);
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
 assert.deepEqual(w.b.closedTabs,[],'never closed');assert.equal(w.state(),undefined,'the job retired');
 assert.ok(uploadedSteps(w).includes('worker:preserve_navigated'),`${uploadedSteps(w)}`);
 assert.equal(await pinnedIn(tab),undefined);
});
test('worker, review: a new-chat review whose unpinned sent turn the user edited (prompt plus their text) is preserved, never closed',async t=>{
 const tab=await chatTab(t,{thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal()});
 const w=wire(tab);
 await w.tick();await tab.page.clock.runFor(1600);
 await tab.page.evaluate(text=>{document.querySelector('[data-message-id="user-A"] .whitespace-pre-wrap').textContent=text;},PROMPT+' Also check my own branch.');
 await finish(tab.page);await tab.page.clock.runFor(2400);
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[]);assert.equal(w.state(),undefined);
 assert.ok(uploadedSteps(w).includes('worker:preserve_edited'),`${uploadedSteps(w)}`);
});
test('worker, review (control): a review this page sent on the new chat, moved by the provider before its collector\'s first poll while generating, pins there and closes',async t=>{
 const tab=await chatTab(t,{composer:PROMPT,journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:[]}});
 const w=wire(tab);
 await w.tick();await tab.page.clock.runFor(600);
 assert.equal(await tab.clicks(),1,'this page clicked Send on the new chat');
 // The provider accepts the prompt: it assigns the conversation URL and renders the sent turn with a
 // generating answer before the collector's first poll.
 await tab.page.evaluate(([url,html,stop])=>{history.replaceState(history.state,'',url);document.getElementById('thread').innerHTML=html;
  document.getElementById('prompt-textarea').textContent='';document.body.insertAdjacentHTML('beforeend',stop);},[CONV_URL,userTurn()+answerTurn({done:false}),stopButton]);
 await tab.page.clock.runFor(1600);
 assert.equal(await pinnedIn(tab),CONV_URL,'pinned where the provider moved it while this page watched the run');
 await finish(tab.page);await tab.page.clock.runFor(2400);
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
 assert.deepEqual(w.b.closedTabs,[10],`closed: ${uploadedSteps(w)}`);assert.equal(w.state(),undefined);
});

// ── Legs nobody wants any more (cancelled, superseded, forgotten): the tab has no use either. The
// cancel exit stops the page (no send, no collect) and closes a REVIEW tab unless the user took it
// over. A FIX tab is closed only on the proven-success path (#77): a cancelled fix leg's page is
// stopped and released the same way, in the same tick, and its tab is kept (preserve_undelivered).
const generatingTab=(t,extra={})=>chatTab(t,{thread:userTurn()+answerTurn({done:false}),after:stopButton,journal:sentJournal(),...extra});
for(const kind of ['review','fix'])test(`worker, ${kind}: a leg cancelled while its answer is still generating is ${kind==='fix'?'preserved':'closed'} at once, and its page stops`,async t=>{
 const tab=await generatingTab(t,{kind});
 const w=wire(tab,{kind});
 await w.tick();await tab.page.clock.runFor(1600);
 assert.equal((await tab.runner()).running,true,'generating');
 w.server.value='cancelled';
 await w.tick();
 assert.deepEqual(w.b.closedTabs,kind==='fix'?[]:[10],`${kind==='fix'?'kept':'closed'} in the same tick, without waiting for the answer`);
 assert.equal(w.state(),undefined,'the job retired');
 const cancel=w.b.messages.find(m=>m.type==='ashlar-fix-cancel');
 assert.ok(cancel&&!cancel.undispatched&&(kind==='fix'?cancel.preserve===true:cancel.allocationUrl===TEMP_URL),
  kind==='fix'?'the cancel exit as a release (no verdict is asked)':'the cancel exit, naming the allocation page');
 await tab.page.clock.runFor(1000);
 assert.deepEqual(await tab.runner(),{running:false,code:'cancelled'},'the page collector stopped');
 assert.equal(await tab.clicks(),0);
 const steps=uploadedSteps(w);
 const end=kind==='fix'?['worker:preserve_undelivered','worker:tab_preserved']:['worker:tab_closed'];
 assert.ok(steps.includes('page:cancelled')&&end.every(stage=>steps.includes(stage)),`the stop and the ${kind==='fix'?'preserve':'close'} reach history: ${steps}`);
 if(kind==='fix')assert.equal(await tab.released(),'true','the kept tab frees its managed slot');
});
for(const kind of ['review','fix'])test(`worker, ${kind}: a leg cancelled while generating is preserved when the user staged a file in its composer`,async t=>{
 const tab=await generatingTab(t,{kind});
 const w=wire(tab,{kind});
 await w.tick();await tab.page.clock.runFor(1600);
 await stageFile(tab.page);
 w.server.value='cancelled';
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[],'the staged file is the user\'s draft');assert.equal(w.state(),undefined,'the job retired');
 // (a cancelled fix is kept whatever its page shows: its cause is the undelivered answer, #77)
 assert.ok(uploadedSteps(w).includes(kind==='fix'?'worker:preserve_undelivered':'worker:preserve_draft'));
});
for(const kind of ['review','fix'])test(`worker, ${kind}: a leg cancelled while its own attachment is still uploading is ${kind==='fix'?'preserved, its run stopped':'closed (its own file is not a draft)'}`,async t=>{
 const tab=await chatTab(t,{kind,composer:PROMPT,sendDisabled:true,uploading:true,chips:['diff.patch'],journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:['diff.patch']}});
 const w=wire(tab,{kind});
 await w.tick();await tab.page.clock.runFor(1000);
 assert.equal((await tab.runner()).running,true,'waiting for its attachment upload');
 w.server.value='cancelled';
 await w.tick();
 assert.deepEqual(w.b.closedTabs,kind==='fix'?[]:[10]);assert.equal(w.state(),undefined);
});
for(const kind of ['review','fix'])test(`worker, ${kind}: a leg cancelled after dispatch but before its prompt was sent is ${kind==='fix'?'preserved':'closed'}, and never sends it`,async t=>{
 const tab=await chatTab(t,{kind,composer:PROMPT,sendDisabled:true,uploading:true,journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:[]}});
 const w=wire(tab,{kind});
 await w.tick();await tab.page.clock.runFor(1000);
 assert.equal((await tab.runner()).running,true,'waiting for its attachment upload');
 w.server.value='cancelled';
 await w.tick();
 assert.deepEqual(w.b.closedTabs,kind==='fix'?[]:[10]);assert.equal(w.state(),undefined);
 await tab.enableSend();await tab.page.clock.runFor(2000);
 assert.equal(await tab.clicks(),0,'the cancelled prompt is never submitted');
});
/** The record allocateProviderTab writes when it creates tab 10 for this leg (this browser session). */
const createdHere=(job='job-A',run='run-A')=>storage({'ashlar:tab:10':{jobId:job,provider:'chatgpt',runId:run,closedKey:`ashlar:closed:${job}:chatgpt:${run}`,closing:false}});
for(const [name,view,expected] of [
 ['a blank temporary chat is closed',{},{closed:[10]}],
 ['a draft the user typed there is preserved',{composer:'my own question'},{closed:[]}],
 ['a file the user staged there is preserved',{chips:['my-notes.pdf']},{closed:[]}],
 ['a tab the user moved to another conversation is preserved',{url:OTHER_URL},{closed:[]}],
])test(`worker, review: cancelled before its run was dispatched: ${name}, and the job retires`,async t=>{
 const tab=await chatTab(t,{bound:false,...view});
 const w=wire(tab,{started:false,server:{value:'cancelled'},session:createdHere()});
 await w.tick();
 assert.deepEqual(w.b.closedTabs,expected.closed);assert.equal(w.state(),undefined,'retired, capacity released');
 assert.ok(w.b.messages.some(m=>m.type==='ashlar-fix-cancel'&&m.undispatched===true),'the unbound page answers only the undispatched claim');
 assert.equal(w.b.messages.some(m=>m.type==='ashlar-run'),false,'a cancelled run is never dispatched');
});
// A run message the worker gave up on (askPage bounds every page message) can still reach the page
// after its leg retired. The release told the unbound page in the tab created for the leg that the
// run was never dispatched, for either kind (a review's claim; a fix's refusal, which vouches for
// nothing and keeps the tab, #77), so that run binds the page stopped: never sent (#82), even when
// the stop marker cannot be written.
for(const kind of ['review','fix'])for(const persisted of [true,false])test(`worker, ${kind}: cancelled before its run was dispatched, a late run message for it never sends (${persisted?'stop marker written':'stop marker write fails'})`,async t=>{
 const tab=await chatTab(t,{kind,bound:false});
 if(!persisted)await tab.page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
  if(key.startsWith('ashlar:stopped:'))throw new DOMException('fixture quota exceeded','QuotaExceededError');return set.call(this,key,value);};});
 const w=wire(tab,{kind,started:false,server:{value:'cancelled'},session:createdHere(tab.job)});
 await w.tick();
 assert.deepEqual(w.b.closedTabs,kind==='fix'?[]:[10]);assert.equal(w.state(),undefined,'the leg retired');
 assert.ok(w.b.messages.some(m=>m.type==='ashlar-fix-cancel'&&m.undispatched===true&&(kind!=='fix'||m.preserve===true)),'the release says the run was never dispatched');
 assert.equal(await tab.page.evaluate(key=>sessionStorage.getItem(key),`ashlar:stopped:${tab.job}:${tab.run}`),persisted?'true':null);
 assert.equal(await tab.released(),null,'an unbound page has no binding to release');
 await tab.send('ashlar-run',{prompt:PROMPT,allocationUrl:TEMP_URL});await tab.page.clock.runFor(2000);
 assert.equal(await tab.clicks(),0,'the late run never sends');
 assert.deepEqual(await tab.runner(),{running:false,code:'cancelled'});
});
// Chrome tab ids are unique only within one browser session; the job registry survives a restart
// (storage.local), the record of the tabs this session created does not (storage.session). A leg
// allocated but never dispatched before a restart can therefore name the user's own tab.
for(const kind of ['review','fix'])for(const url of ['https://chatgpt.com/',TEMP_URL,'https://chatgpt.com/?model=gpt-5'])test(`worker, ${kind}: a cancelled undispatched leg never claims or closes the user's blank tab that reuses its tab id (${url})`,async t=>{
 const tab=await chatTab(t,{bound:false,url,kind});
 const w=wire(tab,{kind,started:false,server:{value:'cancelled'}});
 await w.tick();
 assert.equal(w.b.session.state['ashlar:tab:10'],undefined,'fixture: this browser session never created tab 10');
 assert.deepEqual(w.b.closedTabs,[]);
 assert.equal(w.b.messages.some(m=>m.undispatched===true),false,'the unbound page is never claimed as Ashlar\'s');
 // (a review is asked again within the ownership wait; a cancelled fix is kept at once, #77)
 if(kind==='review'){w.later();await w.tick();}
 assert.deepEqual(w.b.closedTabs,[],'never closed');assert.equal(w.state(),undefined,'the leg retires');
 assert.equal(w.b.messages.some(m=>m.preserve===true),false,'the user\'s page is never told to release a binding');
 assert.equal(w.b.messages.some(m=>m.type==='ashlar-run'),false);
});
test('sweep: a forgotten ("missing") undispatched leg never closes the user\'s blank tab that reuses its tab id',async t=>{
 const tab=await chatTab(t,{bound:false,url:'https://chatgpt.com/'});
 const w=wire(tab,{started:false,server:{value:'missing'}});
 await w.b.context.heartbeatTick();
 const res=await w.b.context.clearStuckJobs();
 assert.equal(res.ok,true);
 assert.deepEqual(w.b.closedTabs,[]);
 assert.equal(w.b.messages.some(m=>m.undispatched===true),false);
});
// Ashlar 4101623037 on a real page: a run message the worker gave up on (askPage) still bound the page,
// and its prompt was sent, but the leg never recorded started; then an extension reload cleared the
// record of the tab this session created for it. The page answers for its binding (ashlar-tab-status):
// the leg adopts it and observes it to the end. The prompt is never sent again, and no second tab opens.
for(const kind of ['review','fix'])test(`worker, ${kind}: after an extension reload, an undispatched leg whose tab holds its sent run adopts it, never sends it again, and delivers its answer`,async t=>{
 const tab=await generatingTab(t,{kind});
 const w=wire(tab,{kind,started:false}); // no session: the reload cleared it
 const created=[];const create=w.b.chrome.tabs.create;w.b.chrome.tabs.create=async options=>{created.push(options);return create(options);};
 await w.tick();await tab.page.clock.runFor(1600);
 assert.equal(w.state().started,true,'adopted');
 assert.ok(w.b.messages.some(m=>m.type==='ashlar-tab-status'),'the page was asked for its binding');
 await finish(tab.page);await tab.page.clock.runFor(2400);
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'its answer is delivered');
 assert.equal(await tab.clicks(),0,'the prompt is never sent again');
 assert.deepEqual(w.b.messages.filter(m=>m.type==='ashlar-run'&&m.resume!==true),[],'never a fresh run');
 assert.deepEqual(created,[],'no second tab');
});
// A background tab Chrome discarded while it waited (job 649: attachments_waiting for 10+ minutes)
// holds no page. It is woken once (the tab this browser session created, still on its page) and its
// reloaded page gives the verdict: what the provider keeps across a reload is still respected.
test('worker, fix: a cancelled leg\'s discarded tab is kept at once, never woken (a cancelled fix never reaches a verdict, #77)',async t=>{
 const tab=await chatTab(t,{kind:'fix',composer:PROMPT,sendDisabled:true,uploading:true,journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:[]}});
 const w=wire(tab,{kind:'fix'});
 await w.tick();await tab.page.clock.runFor(1000);
 assert.equal((await tab.runner()).running,true,'waiting for its attachment upload');
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 const reloads=[];
 w.b.chrome.tabs.reload=async id=>{reloads.push(id);};
 w.server.value='cancelled';
 await w.tick({syncUrl:false});
 assert.deepEqual(reloads,[],'never woken');assert.deepEqual(w.b.closedTabs,[]);assert.equal(w.state(),undefined,'the job retired');
 assert.ok(uploadedSteps(w).includes('worker:preserve_undelivered'));
 assert.ok(w.b.session.state['ashlar:preserved:fix-A:chatgpt:run-A'],'the preserved-run record releases it once its page answers again');
});
for(const kind of ['review'])for(const [name,restored,closed] of [['the reloaded temporary chat is blank: closed','',[10]],['the provider restores a draft on reload: preserved','my restored question',[]]])test(`worker, ${kind}: a cancelled leg's discarded tab is woken once: ${name}`,async t=>{
 const tab=await chatTab(t,{kind,composer:PROMPT,sendDisabled:true,uploading:true,journal:{phase:'prepared',expected:PROMPT,baseline:0,attachments:[]}});
 const w=wire(tab,{kind});
 await w.tick();await tab.page.clock.runFor(1000);
 assert.equal((await tab.runner()).running,true,'waiting for its attachment upload');
 // Chrome discards the tab: the worker sees only its URL and status until it is loaded again.
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 Object.assign(tab.served,{composer:restored,uploading:false,sendDisabled:false});
 const reloads=[];
 w.b.chrome.tabs.reload=async id=>{reloads.push(id);Object.assign(w.b.tabs.get(id),{discarded:false,status:'loading'});await tab.reload();};
 w.server.value='cancelled';
 await w.tick({syncUrl:false});
 assert.deepEqual(reloads,[10],'woken once');assert.deepEqual(w.b.closedTabs,[]);
 w.b.tabs.get(10).status='complete';
 await w.tick();
 assert.deepEqual(w.b.closedTabs,closed);assert.equal(w.state(),undefined,'the job retired');
 assert.deepEqual(reloads,[10]);
 assert.equal(await tab.clicks(),0,'the cancelled prompt is never sent from the woken page');
});
// Ashlar 4101062759: Chrome discards an ACTIVE review's tab while its answer is generating. The poll
// wakes the tab this browser session created once; the reloaded page resumes observing its sent run
// from its journal (never sends again), and the leg goes on to deliver and close. No second tab.
test('worker, review: a generating leg whose tab Chrome discarded is woken once; its reloaded page resumes the run (never sends again) and the answer is delivered',async t=>{
 const tab=await generatingTab(t);
 const w=wire(tab,{session:createdHere()});
 await w.tick();await tab.page.clock.runFor(1600);
 assert.equal((await tab.runner()).running,true,'generating');
 // Chrome discards the tab; the provider finishes the answer meanwhile (the reload renders it).
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 Object.assign(tab.served,{thread:userTurn()+answerTurn(),after:''});
 const reloads=[];
 w.b.chrome.tabs.reload=async id=>{reloads.push(id);Object.assign(w.b.tabs.get(id),{discarded:false,status:'loading'});await tab.reload();};
 const resumes=()=>w.b.messages.filter(m=>m.type==='ashlar-run'&&m.resume===true).length;
 const before=resumes();
 await w.tick({syncUrl:false});
 assert.deepEqual(reloads,[10],'woken once');
 w.b.tabs.get(10).status='complete';
 await w.tick();await tab.page.clock.runFor(2400);
 assert.equal(resumes()-before,1,'observation resumed once in the reloaded page');
 await w.tick();
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');
 assert.deepEqual(w.b.closedTabs,[10],`closed: ${uploadedSteps(w)}`);assert.equal(w.state(),undefined,'the job retired');
 assert.deepEqual(reloads,[10]);assert.equal(await tab.clicks(),0,'the prompt is never sent again');
 assert.equal(w.b.tabs.size,0,'no second tab was opened');
 assert.ok(uploadedSteps(w).includes('worker:tab_woken'),`${uploadedSteps(w)}`);
});
// Ashlar 4101062759 (R3): Chrome discards the tab again after its woken page resumed the run (a
// background tab reloaded in the background is a likely next candidate). That is a new discard: woken
// again, and the answer the provider finished meanwhile is delivered, never failed and thrown away.
test('worker, review: a generating leg whose tab Chrome discards again after its woken page resumed is woken again, and the answer is delivered',async t=>{
 const tab=await generatingTab(t,{url:CONV_URL,journal:sentJournal({conversation:CONV_URL})});
 const w=wire(tab,{session:createdHere()});
 await w.tick();await tab.page.clock.runFor(1600);
 const reloads=[];
 w.b.chrome.tabs.reload=async id=>{reloads.push(id);Object.assign(w.b.tabs.get(id),{discarded:false,status:'loading'});await tab.reload();};
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 await w.tick({syncUrl:false});
 w.b.tabs.get(10).status='complete';
 await w.tick();await tab.page.clock.runFor(2400);await w.tick();
 assert.equal((await tab.runner()).running,true,'the woken page resumed its run (still generating)');
 assert.equal(w.state().discardedAt,undefined,'its page shows the run\'s response: this discard is over');
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 Object.assign(tab.served,{thread:userTurn()+answerTurn(),after:''}); // the provider finished meanwhile
 await w.tick({syncUrl:false});
 assert.deepEqual(reloads,[10,10],'a new discard: woken again');
 w.b.tabs.get(10).status='complete';
 for(let i=0;i<3&&w.state();i++){await w.tick();await tab.page.clock.runFor(2400);}
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'the answer is delivered');
 assert.equal(w.b.calls.some(c=>c.action==='failure'),false,'never failed as tab_discarded');
 assert.deepEqual(w.b.closedTabs,[10],`closed once the answer was secured: ${uploadedSteps(w)}`);assert.equal(w.state(),undefined);
 assert.equal(await tab.clicks(),0,'the prompt is never sent again');
});
// R2 end to end: the review was collected but its delivery failed (the bridge was down); the user
// regenerated it to completion; Chrome discarded the tab; the bridge came back and ACKed the answer.
// The cleanup's own wake reloads the tab: its fresh page must still keep the user's regeneration.
test('worker, review: delivery delayed, the user regenerates, Chrome discards the tab, the cleanup wakes it: kept as regenerated, never closed',async t=>{
 let down=true;
 const tab=await chatTab(t,{url:CONV_URL,thread:userTurn()+answerTurn(),journal:sentJournal({conversation:CONV_URL})});
 const w=wire(tab,{session:createdHere(),onComplete:async()=>{if(down)throw Object.assign(new Error('bridge down'),{status:503});}});
 await w.tick();await tab.page.clock.runFor(2400);
 await w.tick();
 assert.equal(w.state().delivered,undefined,'fixture: the delivery failed');assert.equal(w.state().outcome?.ok,true,'the answer was collected');
 await tab.page.evaluate(pager=>{const a=document.querySelector('[data-message-author-role="assistant"]');a.dataset.messageId='answer-B';a.querySelector('#code').textContent='{"findings":[],"merge_recommendation":"COMMENT"}';document.querySelector('[aria-label="Response actions"]').insertAdjacentHTML('beforeend',pager);},pager);
 tab.served.thread=await tab.page.evaluate(()=>document.getElementById('thread').innerHTML);
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 const reloads=[];
 w.b.chrome.tabs.reload=async id=>{reloads.push(id);Object.assign(w.b.tabs.get(id),{discarded:false,status:'loading'});await tab.reload();};
 down=false;
 await w.tick({syncUrl:false});
 assert.ok(w.b.calls.some(c=>c.action==='complete'),'delivered');assert.deepEqual(reloads,[10],'the cleanup woke the tab');
 w.b.tabs.get(10).status='complete';
 await w.tick();
 assert.ok(w.b.messages.some(m=>m.type==='ashlar-can-close'&&m.secured===true),'the cleanup says the answer was secured');
 assert.deepEqual(w.b.closedTabs,[],'the tab the user regenerated in is never closed');assert.equal(w.state(),undefined,'the job retired');
 assert.ok(uploadedSteps(w).includes('worker:preserve_regenerated'),`${uploadedSteps(w)}`);
});
// Ashlar 4101062759, reopened: a page loaded again after a discard is not proof that the run goes on.
// A reload keeps the submission journal but not the page: the prompt Ashlar entered but never sent
// (its composer text and its file chip) is gone, so the resumed send waits for the chip forever and
// never clicks (job 649's shape); a temporary chat renders nothing for a sent run's collector. The
// discard's time limit holds until the page identifies the response bound to the run's sent turn:
// the leg fails (tab_discarded), is delivered and retires, and the cleanup rule releases the tab.
for(const [name,view,journal,reloaded] of [
 ['its attachment was still uploading (the reload serves an empty composer, no chip)',{composer:PROMPT,chips:['diff.patch'],uploading:true,sendDisabled:true},{phase:'prepared',expected:PROMPT,baseline:0,attachments:['diff.patch']},{composer:'',chips:[],uploading:false,sendDisabled:false}],
 ['its answer was generating in a temporary chat (the reload renders nothing)',{thread:userTurn()+answerTurn({done:false}),after:stopButton},sentJournal(),{thread:'',after:''}],
])test(`worker, review: a leg whose tab Chrome discarded while ${name} is woken once, then fails within the discard's time limit, never sends, and its tab is released`,async t=>{
 const tab=await chatTab(t,{...view,journal});
 const w=wire(tab,{session:createdHere()});
 await w.tick();await tab.page.clock.runFor(1600);
 assert.equal((await tab.runner()).running,true,'the run is going on');
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 Object.assign(tab.served,reloaded);
 const reloads=[];
 w.b.chrome.tabs.reload=async id=>{reloads.push(id);Object.assign(w.b.tabs.get(id),{discarded:false,status:'loading'});await tab.reload();};
 await w.tick({syncUrl:false});
 assert.deepEqual(reloads,[10],'woken once');
 w.b.tabs.get(10).status='complete';
 await w.tick();await tab.page.clock.runFor(5000);await w.tick();
 assert.equal((await tab.runner()).running,true,'the resumed run waits in the reloaded page');
 assert.equal(w.state().outcome,undefined,'within the time limit the page may still resume');
 w.later();await w.tick();await tab.page.clock.runFor(5000);
 const failure=w.b.calls.find(c=>c.action==='failure');
 assert.match(failure?.error||'',/^tab_discarded: .*woke it/,'the bounded failure is delivered');
 assert.equal(w.state(),undefined,`retired, capacity released: ${uploadedSteps(w)}`);
 assert.deepEqual(w.b.closedTabs,[10],'nothing of the user\'s in the reloaded page: the cleanup rule closes it');
 assert.deepEqual(reloads,[10]);assert.equal(await tab.clicks(),0,'the prompt is never sent from the woken page');
 assert.equal(w.b.messages.filter(m=>m.type==='ashlar-run'&&m.resume!==true).length,0,'never dispatched again');
});
// A fix's temporary chat is not restored by a reload, so a fix whose run was dispatched is never
// woken; if the user brings the tab back (Chrome reloads it), its collector has nothing to observe.
// Either way the leg ends in a bounded failure and the tab is kept (#77), its run stopped.
for(const [name,userReloads] of [['Ashlar never wakes it',false],['the user brings it back (Chrome reloads it) and the temporary chat renders nothing',true]])test(`worker, fix: a generating leg whose temporary chat Chrome discarded (${name}) ends in a bounded failure and its tab is kept`,async t=>{
 const tab=await generatingTab(t,{kind:'fix'});
 const w=wire(tab,{kind:'fix',session:createdHere('fix-A')});
 await w.tick();await tab.page.clock.runFor(1600);
 assert.equal((await tab.runner()).running,true,'generating');
 Object.assign(w.b.tabs.get(10),{status:'unloaded',discarded:true});
 Object.assign(tab.served,{thread:'',after:''});
 const reloads=[];
 w.b.chrome.tabs.reload=async id=>{reloads.push(id);};
 await w.tick({syncUrl:false});
 assert.deepEqual(reloads,[],'never woken by Ashlar');
 if(userReloads){await tab.reload();Object.assign(w.b.tabs.get(10),{discarded:false,status:'complete'});await w.tick();await tab.page.clock.runFor(2400);await w.tick();}
 assert.equal(w.state().outcome,undefined,'within the time limit');
 w.later();await w.tick({syncUrl:false});
 assert.ok(w.b.calls.some(c=>c.action==='failure'&&/^tab_discarded/.test(c.error)),'the bounded failure is delivered');
 assert.equal(w.state(),undefined,'retired, capacity released');
 assert.deepEqual(w.b.closedTabs,[],'a fix tab without a delivered answer is kept (#77)');assert.deepEqual(reloads,[]);
 assert.ok(uploadedSteps(w).includes('worker:preserve_undelivered'),`${uploadedSteps(w)}`);
 if(userReloads){await tab.page.clock.runFor(1000);assert.deepEqual(await tab.runner(),{running:false,code:'cancelled'},'the kept tab\'s run is stopped');}
});
test('worker: a cancelled leg whose page could not be reached before the server forgot the job ("missing") still closes',async t=>{
 const tab=await generatingTab(t);
 const w=wire(tab);
 await w.tick();await tab.page.clock.runFor(1600);
 const send=w.b.chrome.tabs.sendMessage;let blocked=true;
 w.b.chrome.tabs.sendMessage=(id,msg,callback)=>{
  if(blocked&&msg.type!=='ashlar-tab-status'){w.b.messages.push({id,...msg});w.b.chrome.runtime.lastError={message:'Could not establish connection. Receiving end does not exist.'};callback();w.b.chrome.runtime.lastError=null;return;}
  send(id,msg,callback);
 };
 w.server.value='cancelled';
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[],'the page could not be reached this tick');
 assert.equal(w.state().abandoned,true,'the abandonment is durable');
 blocked=false;w.server.value='missing';
 await w.b.context.heartbeatTick();
 assert.equal(w.b.local.state.pendingReviewJobs[w.job.jobId].serverStatus,'missing');
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[10]);assert.equal(w.state(),undefined);
});
test('worker: job-muf51f0g-1942\'s stored leg (cancelled, then forgotten; wedged page) closes on the next tick',async t=>{
 // The 1.1.22 record as stored: delivered with no outcome, closeRequested, the stale blocker; no
 // abandoned flag. Its page: a temporary chat, a sent journal without a pinned conversation, the
 // page journal ending in waiting_for_response, an error bubble with Retry, no Stop, no actions.
 const tab=await chatTab(t,{thread:userTurn()+'<div role="alert">Something went wrong. <button>Retry</button></div>',journal:sentJournal()});
 await tab.page.evaluate(key=>sessionStorage.setItem(key,JSON.stringify({sequence:4,events:['prompt_prepared','send_attempted','prompt_submitted','waiting_for_response']
  .map((stage,i)=>({source:'page',sequence:i+1,stage,at:1_700_000_000_000+i}))})),'ashlar:steps:job-A:run-A');
 await tab.reload(); // scripts freshly injected (an extension update), nothing running in the page
 const events=['tab_created','run_dispatched','cleanup_pending'].map((stage,i)=>({source:'worker',sequence:i+1,stage,at:1_700_000_000_000+i}));
 const w=wire(tab,{server:{value:'missing'},job:{serverStatus:'missing'},state:{delivered:true,cleanupPending:true,closeRequested:true,
  cleanupWaitReason:'page_completion_or_journal_pending',workerEvents:events,workerSequence:3}});
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[10]);assert.equal(w.state(),undefined,'the job retired');
 assert.ok(w.b.messages.some(m=>m.type==='ashlar-fix-cancel'&&m.allocationUrl===TEMP_URL),'the cancel exit, not can-close');
 const steps=uploadedSteps(w);
 assert.ok(steps.includes('page:cancelled')&&steps.includes('worker:tab_closed'),`the page's stop and the close reach review history: ${steps}`);
});
for(const mode of ['secured','cancelled'])test(`worker: a ${mode} leg whose tab now belongs to another job is never closed, and that job's page is untouched`,async t=>{
 const tab=await generatingTab(t,{job:'job-B',run:'run-B'});
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(1600);
 const other={jobId:'job-B',provider:'chatgpt',runId:'run-B',closedKey:'ashlar:closed:job-B:chatgpt:run-B',closing:false};
 const w=wire(tab,{jobId:'job-A',runId:'run-A',session:storage({'ashlar:tab:10':other}),
  ...(mode==='secured'?{state:{delivered:true,cleanupPending:true,outcome:{ok:true,raw:ANSWER,originalText:ANSWER}}}:{server:{value:'cancelled'}})});
 await w.tick();
 assert.deepEqual(w.b.closedTabs,[]);assert.ok(w.state(),'asked again first');
 w.later();await w.tick();
 assert.deepEqual(w.b.closedTabs,[],'never closed');assert.equal(w.state(),undefined,'leg A retired after the ownership wait');
 assert.deepEqual(w.b.session.state['ashlar:tab:10'],other,'job B\'s tab record is intact');
 assert.equal(w.b.messages.some(m=>m.type==='ashlar-fix-cancel'&&m.preserve===true),false,'job B\'s page is never told to release');
 assert.equal(await tab.released(),null);
 assert.deepEqual(await tab.page.evaluate(()=>({running:__ashlarRunnerState.running,stopped:__ashlarRunnerState.runStopped===true})),{running:true,stopped:false},'job B keeps running');
});
for(const [name,takeover,closed] of [['no user activity',null,[10]],['a follow-up turn',TAKEOVERS[0][2],[]]])test(`sweep: a freshly re-probed "missing" job with a live tab and ${name} is released and cleared`,async t=>{
 const tab=await generatingTab(t);
 const w=wire(tab);
 await w.tick();await tab.page.clock.runFor(1600);
 if(takeover)await takeover(tab.page);
 w.server.value='missing';
 await w.b.context.heartbeatTick();
 const res=await w.b.context.clearStuckJobs();
 assert.deepEqual({ok:res.ok,cleared:res.cleared},{ok:true,cleared:1});
 assert.deepEqual(w.b.closedTabs,closed);
});

// X2 (#85), real pages: a new ChatGPT run is typed and sent only on the new chat its tab was opened
// on, with no user turn there. The page refuses a run elsewhere (binding nothing, and fencing that
// run), and a run it accepted ends before its Send once the user moves the tab to their own
// conversation: nothing more is typed or clicked there.
const composerText=tab=>tab.page.evaluate(()=>document.getElementById('prompt-textarea').textContent);
for(const [what,view,cause] of [['on the user\'s conversation',{url:OTHER_URL},'navigated'],['holding a user turn',{thread:userTurn('user-X','my own question')},'user_turn'],
 ['holding the user\'s unsent text (Ashlar 4103758186)',{composer:'my unsent question'},'draft'],['holding a file the user staged (Ashlar 4103758186)',{chips:['my-notes.pdf']},'draft']])
 test(`fresh run: a page ${what} refuses a new run; nothing is bound, typed or clicked, and the run is fenced`,async t=>{
  const tab=await chatTab(t,{bound:false,...view});
  const out=await tab.send('ashlar-run',{prompt:PROMPT,allocationUrl:TEMP_URL});
  assert.deepEqual({ok:out.ok,code:out.code,cause:out.cause,jobId:out.jobId},{ok:false,code:'taken_over',cause,jobId:''});
  await tab.page.clock.runFor(2000);
  assert.equal(await tab.clicks(),0);assert.equal(await composerText(tab),view.composer||'','nothing typed');
  assert.equal(await tab.page.evaluate(()=>sessionStorage.getItem('ashlar:job')),null,'nothing bound');
  assert.equal(await tab.page.evaluate(key=>sessionStorage.getItem(key),`ashlar:stopped:${tab.job}:${tab.run}`),'true','the run is fenced');
 });
test('fresh run: the user moving the tab to their own conversation while the run waits for its composer: nothing is typed or clicked',async t=>{
 const tab=await chatTab(t,{bound:false});
 await tab.page.evaluate(()=>{document.getElementById('prompt-textarea').style.display='none';});
 assert.equal((await tab.send('ashlar-run',{prompt:PROMPT,allocationUrl:TEMP_URL})).code,'busy','accepted on its new chat');
 await tab.page.clock.runFor(1000);
 assert.equal((await tab.runner()).running,true,'waiting for the composer');
 await tab.page.evaluate(url=>{history.pushState({},'',url);document.getElementById('prompt-textarea').style.display='';},OTHER_URL);
 await tab.page.clock.runFor(3000);
 assert.equal(await composerText(tab),'','nothing typed');assert.equal(await tab.clicks(),0,'nothing clicked');
 assert.deepEqual(await tab.runner(),{running:false,code:'taken_over'});
});
test('fresh run: the user moving the tab between the fill and the click: Send is never clicked',async t=>{
 const tab=await chatTab(t,{bound:false,sendDisabled:true});
 assert.equal((await tab.send('ashlar-run',{prompt:PROMPT,allocationUrl:TEMP_URL})).code,'busy');
 await tab.page.clock.runFor(3000);
 assert.ok((await composerText(tab)).includes('Review fixture PR #1'),'the prompt was typed');
 assert.equal((await tab.runner()).running,true,'waiting for an enabled Send');
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 await tab.enableSend();await tab.page.clock.runFor(3000);
 assert.equal(await tab.clicks(),0,'never clicked on the user\'s conversation');
 assert.deepEqual(await tab.runner(),{running:false,code:'taken_over'});
});
// Ashlar 4103758194 (the legacy branch): a run that ended taken_over before its Send wrote no
// journal, so its release verdict fell to the journal-less branch, which recorded the user's own
// turn (a temporary chat keeps its URL on a send) as the page's finished state and said owned.
// The take-over is positive evidence and latches: the tab is kept, also once a draft is cleared.
for(const [what,act,undo,cause] of [
 ['sends their own message',p=>p.evaluate(html=>document.getElementById('thread').insertAdjacentHTML('beforeend',html),userTurn('user-X','my own question')),null,'user_turn'],
 ['types a draft, then clears it',p=>p.evaluate(()=>{const el=document.getElementById('prompt-textarea');el.textContent='my unsent question';el.style.display='';}),p=>p.evaluate(()=>{document.getElementById('prompt-textarea').textContent='';}),'draft'],
])test(`fresh run: the user ${what} in the new chat before Ashlar types: the release verdict keeps the tab (${cause})`,async t=>{
 const tab=await chatTab(t,{bound:false});
 await tab.page.evaluate(()=>{document.getElementById('prompt-textarea').style.display='none';});
 assert.equal((await tab.send('ashlar-run',{prompt:PROMPT,allocationUrl:TEMP_URL})).code,'busy');
 await tab.page.clock.runFor(1000);
 await act(tab.page);
 await tab.page.clock.runFor(3000);
 assert.deepEqual(await tab.runner(),{running:false,code:'taken_over'});
 if(undo)await undo(tab.page);
 const out=await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL,secured:true});
 assert.deepEqual({canClose:out.canClose,ownership:out.ownership,cause:out.cause},{canClose:false,ownership:'takenOver',cause});
 assert.equal(await tab.clicks(),0);
});
// Ashlar 4103758186: a file the user stages while the accepted run waits for an enabled Send is
// theirs: it stays staged, and Send is never clicked (it would go out with Ashlar's prompt).
test('fresh run: the user staging a file between the fill and the click: Send is never clicked, the file stays',async t=>{
 const tab=await chatTab(t,{bound:false,sendDisabled:true});
 assert.equal((await tab.send('ashlar-run',{prompt:PROMPT,allocationUrl:TEMP_URL})).code,'busy');
 await tab.page.clock.runFor(3000);
 assert.ok((await composerText(tab)).includes('Review fixture PR #1'),'the prompt was typed');
 assert.equal((await tab.runner()).running,true,'waiting for an enabled Send');
 await stageFile(tab.page);
 await tab.enableSend();await tab.page.clock.runFor(3000);
 assert.equal(await tab.clicks(),0,'never clicked with the user\'s file staged');
 assert.deepEqual(await tab.page.evaluate(()=>composerStagedFiles(null,null)),['my-notes.pdf'],'the file stays');
 assert.deepEqual(await tab.runner(),{running:false,code:'taken_over'});
});
// The steps before the typing act on the page too: the overlay dismissal, the model menu and the
// attachment upload. A move during any of them: nothing more is clicked there and no file is staged
// in the user's composer (their next send would upload it).
const MODEL_CONTROLS='<button type="button" class="__composer-pill" aria-haspopup="menu" style="width:80px;height:32px">Instant</button><input type="file" multiple>';
const ATTACHED_PROMPT=`${PROMPT}\n<<<ASHLAR_ATTACHMENTS_V2>>>\n${JSON.stringify([{name:'diff.patch',body:'diff'}])}\n<<<END_ASHLAR_ATTACHMENTS_V2>>>`;
const dialog=(id,label)=>`<div role="dialog" id="${id}" style="width:200px;height:100px"><button id="${id}-ok" style="width:60px;height:24px">${label}</button></div>`;
for(const [when,at,before,view] of [
 ['an overlay dismissal',100,['overlay'],{after:dialog('d1','OK')}],
 ['the model menu\'s wait',200,['pill'],{}],
 ['the wait after the model was picked',1000,['pill','model'],{}],
])test(`fresh run: the user moving the tab during ${when}: nothing more is clicked there and no file is staged`,async t=>{
 const tab=await chatTab(t,{bound:false,controls:MODEL_CONTROLS,...view});
 await tab.page.evaluate(()=>{
  window.pageClicks=[];
  document.querySelector('.__composer-pill').addEventListener('click',()=>{
   window.pageClicks.push('pill');
   document.body.insertAdjacentHTML('beforeend','<div role="menu"><div role="menuitem" id="xh" style="width:100px;height:24px">Extra high</div></div>');
   document.getElementById('xh').addEventListener('click',()=>window.pageClicks.push('model'));
  });
  // The first overlay's button opens another one (a second notice).
  document.getElementById('d1-ok')?.addEventListener('click',()=>{
   window.pageClicks.push('overlay');document.getElementById('d1').remove();
   document.body.insertAdjacentHTML('beforeend','<div role="dialog" id="d2" style="width:200px;height:100px"><button id="d2-ok" style="width:60px;height:24px">Got it</button></div>');
   document.getElementById('d2-ok').addEventListener('click',()=>{window.pageClicks.push('overlay-2');document.getElementById('d2').remove();});
  });
 });
 assert.equal((await tab.send('ashlar-run',{prompt:ATTACHED_PROMPT,allocationUrl:TEMP_URL})).code,'busy','accepted on its new chat');
 await tab.page.clock.runFor(at);
 assert.deepEqual(await tab.page.evaluate(()=>window.pageClicks),before,'the steps so far ran on the new chat');
 await tab.page.evaluate(url=>history.pushState({},'',url),OTHER_URL);
 await tab.page.clock.runFor(3000);
 assert.deepEqual(await tab.page.evaluate(()=>window.pageClicks),before,'nothing more clicked on the user\'s conversation');
 assert.equal(await tab.page.evaluate(()=>document.querySelector('input[type="file"]').files.length),0,'no file staged in the user\'s composer');
 assert.equal(await composerText(tab),'','nothing typed');assert.equal(await tab.clicks(),0,'Send never clicked');
 assert.deepEqual(await tab.runner(),{running:false,code:'taken_over'});
});
test('fresh run, control: a run left on its new chat types and clicks Send once',async t=>{
 const tab=await chatTab(t,{bound:false});
 assert.equal((await tab.send('ashlar-run',{prompt:PROMPT,allocationUrl:TEMP_URL})).code,'busy');
 await tab.page.clock.runFor(3000);
 assert.equal(await tab.clicks(),1);
});

// A leg whose page lost its binding after the dispatch (a new document without the run's session
// keys: ChatGPT reloaded the tab, or moved its new chat to /c/<id>), seen by a worker that restarted
// meanwhile (a suspended or stopped service worker reads its registry and session records again). The
// page answers unbound; the worker used to wait "for reconnection" forever. The tab this browser
// session dispatched the run into is re-bound as a resume: observed, never sent again.
for(const kind of ['review','fix'])test(`worker, ${kind}: a restarted worker re-binds the page that lost its binding in the tab it dispatched the run into`,async t=>{
 const tab=await chatTab(t,{kind,bound:false});
 const w=wire(tab,{kind,started:false,session:createdHere(tab.job)});
 await w.tick();await tab.page.clock.runFor(3000);
 assert.equal(await tab.clicks(),1,'the prompt was sent once');
 assert.equal(w.state().started,true);
 Object.assign(tab.served,{thread:userTurn()+answerTurn()});
 await tab.page.evaluate(()=>sessionStorage.clear());
 await tab.page.goto(kind==='fix'?TEMP_URL:CONV_URL);await tab.inject();
 const again=wire(tab,{kind,local:w.b.local,session:w.b.session});
 await again.tick();await tab.page.clock.runFor(2400);await again.tick();
 assert.ok(again.b.messages.some(m=>m.type==='ashlar-run'&&m.resume===true&&m.adoptLegacy===true),'the dispatched tab is re-bound as a resume');
 assert.equal(await tab.clicks(),0,'the re-bound page never sends the prompt again');
 assert.equal(again.b.messages.some(m=>m.type==='ashlar-run'&&m.resume!==true),false,'never a fresh run');
 assert.equal(again.state()?.connectionError,undefined,'no longer waiting for reconnection');
 // A review answer is collected and delivered. A fix answer is proven only with its send journal,
 // which the lost session took along: the re-bound page observes it until the fix deadline.
 if(kind==='review')assert.ok(again.b.calls.some(c=>c.action==='complete'),'the review is delivered');
 else assert.ok(again.state().pageEvents.some(e=>e.stage==='legacy_observation'),'the fix page observes its run again');
});
// Only the tab this browser session dispatched the run into is ever re-bound (no record after a
// browser restart: storage.session is gone).
test('worker: an unbound page in a tab with no dispatch record of the run is never re-bound',async t=>{
 const tab=await chatTab(t,{bound:false,url:CONV_URL,thread:userTurn()+answerTurn()});
 const w=wire(tab,{});
 await w.tick();await w.tick();
 assert.equal(w.b.messages.some(m=>m.type==='ashlar-run'&&m.adoptLegacy===true),false);
 assert.match(w.state().connectionError||'',/original job binding unavailable/);
});
// Control: a page that keeps its session binding across the move to /c/<id> (a reload) is found by
// the restarted worker as it is, and delivers; nothing is re-bound.
test('worker, review: a restarted worker harvests a run whose new chat moved to /c/<id> and reloaded after the dispatch',async t=>{
 const tab=await chatTab(t,{bound:false});
 const w=wire(tab,{started:false,session:createdHere(tab.job)});
 await w.tick();await tab.page.clock.runFor(3000);
 assert.equal(await tab.clicks(),1);
 Object.assign(tab.served,{thread:userTurn()+answerTurn()});
 await tab.page.goto(CONV_URL);await tab.inject();
 const again=wire(tab,{local:w.b.local,session:w.b.session});
 await again.tick();await tab.page.clock.runFor(2400);await again.tick();
 assert.ok(again.b.calls.some(c=>c.action==='complete'),`delivered: ${JSON.stringify(again.state())}`);
 assert.equal(again.b.messages.some(m=>m.adoptLegacy===true),false,'a bound page needs no re-binding');
 assert.equal(await tab.clicks(),0);
});
// No record proves the tab after a browser restart (storage.session is gone), so the unbound page is
// never re-bound: the leg waits for its binding, but only for BINDING_LOST_MS (the server's bound,
// #95), then fails locally and its failure is delivered, instead of reporting "disconnected" forever.
test('worker: a leg whose binding stays lost for 10 minutes fails binding_lost and is delivered',async t=>{
 const tab=await chatTab(t,{bound:false});
 const w=wire(tab,{started:false,session:createdHere(tab.job)});
 await w.tick();await tab.page.clock.runFor(3000);
 await tab.page.evaluate(()=>sessionStorage.clear());await tab.page.goto(CONV_URL);await tab.inject();
 const again=wire(tab,{local:w.b.local});
 await again.tick();
 assert.match(again.state().connectionError||'',/original job binding unavailable/);
 const RealDate=again.b.context.Date||Date;const at=RealDate.now()+9*60_000;
 again.b.context.Date=class extends RealDate{static now(){return at;}};
 await again.tick();
 assert.equal(again.state().outcome,undefined,'still within the bound');
 const late=at+2*60_000;again.b.context.Date=class extends RealDate{static now(){return late;}};
 await again.tick();
 const failed=again.b.calls.find(c=>c.action==='failure');
 assert.ok(failed&&/^binding_lost:/.test(failed.error),`the leg fails binding_lost: ${JSON.stringify(again.state())}`);
 assert.equal(await tab.clicks(),0,'nothing is sent again');
});
