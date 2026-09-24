// Tab release (#82), real Chromium pages: once a review or fix leg's result is secured (or nobody
// wants it: cancelled / forgotten), its chat tab has no further use and is closed; the ONLY reason
// to keep it is positive evidence the user took it over (a follow-up turn, a draft that is not
// Ashlar's prompt, an edit of Ashlar's prompt, another conversation or site). ChatGPT's own redraws
// of the answer (a finishing code fence, labels, re-keyed ids, streaming flags) are not user activity.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
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
 return {page,served,send,inject,
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
