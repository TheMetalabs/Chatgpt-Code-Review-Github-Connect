// Pre-send bounds (live 1.1.32, a REVIEW run for aicc PR #455 on chatgpt.com): the page recorded
// composer_waiting 24 s after dispatch and nothing more for 10+ minutes; it never reached
// attachments_preparing. Every stage between dispatch and typing is now bounded and records its own
// step; a stall fails the run as presend_stalled (with a local HTML snapshot for diagnosis), and a
// reasoning level that cannot be picked in time is skipped, never waited on.
// Real Chromium pages served at a chatgpt.com URL, the manifest content scripts in manifest order,
// a fresh (non-resume) run message as the worker sends it, and the page's clock installed.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

const MIN=60_000;
const MANIFEST=['turns.js','composer.js','quota.js','overlay.js','model.js','json.js','content-chatgpt.js'];
const URL_='https://chatgpt.com/?temporary-chat=true';
const PROMPT='Review fixture PR #1 at abc123. Return the review JSON.';
const stopButton='<button data-testid="stop-button" aria-label="Stop generating" style="width:32px;height:32px">Stop</button>';
/** menu: 'none' (no model pill), 'dead' (a pill whose menu never opens), 'works' (a pill whose menu
 * opens and switches the level). */
const pill=menu=>menu==='none'?'':`<button class="__composer-pill" aria-haspopup="menu" style="width:90px;height:30px">Thinking</button>`;
const composerForm=menu=>`<form data-type="unified-composer">${pill(menu)}<div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px"></div><button id="composer-submit-button" aria-label="Send prompt" style="width:32px;height:32px">send</button></form>`;

// The logged-out chatgpt.com landing of the #455 incident (live 1.1.33, ko locale), reduced to its
// auth entry points: header Log in / Sign up, the sidebar login panel, the unauthenticated composer
// form (a textarea the runner does not type into) and the cookie-preferences dialog.
const btn=(attrs,label)=>`<button type="button" ${attrs} style="width:120px;height:36px">${label}</button>`;
const loggedOutKo=`<main aria-label="ChatGPT" data-app-shell="">
 <aside><section data-sidebar-login-panel=""><h2>내게 맞춘 응답을 받으세요</h2>${btn('command="show-modal" commandfor="mobile-auth-dialog" data-mobile-auth-entry-action="login" data-mobile-auth-entry-point="sidebar_bottom_unit"','로그인')}</section></aside>
 <header><div data-header-auth-actions="">${btn('command="show-modal" commandfor="mobile-auth-dialog" data-login-button="" data-mobile-auth-entry-action="login"','로그인')}${btn('command="show-modal" commandfor="mobile-auth-dialog" data-mobile-auth-entry-action="signup"','무료로 회원가입')}</div></header>
 <div id="thread"></div>
 <form action="/unauth-mweb/conversation" data-logged-out="" data-mobile-composer="" method="post" style="width:600px;height:60px"><textarea aria-label="ChatGPT와 채팅" id="mobile-composer-prompt" name="prompt" placeholder="ChatGPT에게 물어보세요" style="width:500px;height:40px"></textarea></form>
</main>
<div role="dialog" aria-label="쿠키 기본 설정" style="width:400px;height:120px"><p>이 쿠키는 마케팅 캠페인의 효과를 측정하는 데 도움이 됩니다.</p>${btn('','모두 수락')}${btn('','필수 쿠키만')}</div>`;
// The same landing in en with no auth attributes at all, and a composer that matches the runner's
// selectors (the older logged-out UI): only the visible Log in / Sign up labels identify it.
const loggedOutEn=`<main id="thread"></main><div>${btn('','Log in')}${btn('','Sign up for free')}</div>${composerForm('none')}`;

async function chatTab(t,{composer=true,menu='works',local:initial={},landing}={}){
 const page=await browser.newPage();t.after(()=>page.close());
 // A page that never renders a composer: a landing that keeps loading (an image and a script are
 // there so the snapshot shows they are stripped).
 const body=landing??(composer?`<main id="thread"></main>${composerForm(menu)}`
  :'<main id="thread"><div class="loading" style="width:200px;height:40px">Loading…<img src="x.png" alt=""><svg><path d="M0 0L9 9"></path></svg><script type="text/x-fixture">secret()</script></div></main>');
 await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:`<html><body>${body}</body></html>`}));
 await page.clock.install();
 await page.goto(URL_);
 await page.evaluate(({initial,stopButton,menu})=>{
  const local=new Map(Object.entries(initial));window.__local=local;
  const pick=keys=>Object.fromEntries(keys.filter(k=>local.has(k)).map(k=>[k,JSON.parse(JSON.stringify(local.get(k)))]));
  window.chrome={runtime:{onMessage:{addListener(fn){window.receiver=fn;},removeListener(){}}},
   storage:{local:{get:async keys=>pick(Array.isArray(keys)?keys:[keys]),set:async items=>{for(const [k,v] of Object.entries(items))local.set(k,JSON.parse(JSON.stringify(v)));}}}};
  window.sendClicks=0;window.menuItemClicks=[];
  document.querySelector('form')?.addEventListener('submit',e=>e.preventDefault());
  // The provider takes the prompt: the sent user turn renders, the composer clears, Stop replaces Send.
  document.getElementById('composer-submit-button')?.addEventListener('click',event=>{
   window.sendClicks++;
   const text=document.getElementById('prompt-textarea').textContent;
   document.getElementById('thread').innerHTML=`<section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user" data-message-id="user-A"><div class="whitespace-pre-wrap">${text}</div></div></section>`;
   document.getElementById('prompt-textarea').textContent='';
   event.currentTarget.remove();document.body.insertAdjacentHTML('beforeend',stopButton);
  });
  if(menu==='works')document.querySelector('.__composer-pill')?.addEventListener('click',event=>{
   const button=event.currentTarget;
   // Radix mounts the menu a moment after the click.
   setTimeout(()=>{
    document.body.insertAdjacentHTML('beforeend','<div role="menu" id="menu">'+['Medium','High','Extra high'].map(l=>`<div role="menuitem" style="width:120px;height:24px">${l}</div>`).join('')+'</div>');
    for(const item of document.querySelectorAll('#menu [role="menuitem"]'))item.addEventListener('click',()=>{
     window.menuItemClicks.push(item.textContent);button.textContent=item.textContent;document.getElementById('menu').remove();});
   },300);
  });
 },{initial,stopButton,menu});
 for(const file of MANIFEST)await page.addScriptTag({content:source('extension/'+file)});
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>{if(msg.type==='ashlar-run')msg.until=Date.now()+10_000;receiver(msg,null,resolve);}),
  {type,jobId:'job-A',runId:'run-A',provider:'chatgpt',...extra});
 return {page,send,
  start:()=>send('ashlar-run',{prompt:PROMPT,reasoning:'extra_high',allocationUrl:URL_}),
  steps:()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('ashlar:steps:job-A:run-A')||'{"events":[]}').events.map(e=>e.stage)),
  runner:()=>page.evaluate(()=>({running:__ashlarRunnerState.running,code:__ashlarRunnerState.result?.code,error:__ashlarRunnerState.result?.error})),
  local:key=>page.evaluate(key=>window.__local.get(key),key),
  typed:()=>page.evaluate(()=>[...document.querySelectorAll('textarea,[contenteditable="true"]')].map(el=>el.value??el.textContent).join('')),
  view:()=>page.evaluate(()=>({sendClicks:window.sendClicks,menuItemClicks:window.menuItemClicks,
   sent:document.querySelector('[data-message-author-role="user"]')?.textContent||'',pill:document.querySelector('.__composer-pill')?.textContent||''})),
 };
}

test('a page that never renders a composer fails as presend_stalled (composer) within 3 min, with an HTML snapshot',async t=>{
 const tab=await chatTab(t,{composer:false});
 assert.equal((await tab.start()).code,'busy');
 await tab.page.clock.runFor(2*MIN);
 assert.equal((await tab.runner()).running,true,'still inside the composer bound at 2 min');
 await tab.page.clock.runFor(MIN+5000);
 const out=await tab.runner();t.diagnostic(JSON.stringify(out));
 assert.equal(out.running,false,`the run is still waiting for a composer past its bound: ${JSON.stringify(await tab.steps())}`);
 assert.equal(out.code,'presend_stalled');assert.match(out.error,/"composer"/);
 const steps=await tab.steps();t.diagnostic(JSON.stringify(steps));
 assert.deepEqual(steps,['overlays_dismissing','composer_waiting','presend_stalled']);
 assert.equal((await tab.send('ashlar-harvest')).code,'presend_stalled','the worker harvests the failure and the job retries or settles');
 const snaps=await tab.local('presendStallHtml');
 assert.equal(snaps?.length,1,'one snapshot recorded');
 const [snap]=snaps;
 assert.deepEqual({job:snap.job,run:snap.run,stage:snap.stage,url:snap.url},{job:'job-A',run:'run-A',stage:'composer',url:'https://chatgpt.com/'});
 assert.equal(typeof snap.at,'number');
 assert.match(snap.html,/^<main id="thread">/);assert.match(snap.html,/Loading/);
 assert.doesNotMatch(snap.html,/<script|<img|<path|secret\(\)/,'scripts, images and svg paths are stripped');
});

test('presendStallHtmlOff:true records no snapshot; the run still fails as presend_stalled',async t=>{
 const tab=await chatTab(t,{composer:false,local:{presendStallHtmlOff:true}});
 await tab.start();await tab.page.clock.runFor(3*MIN+5000);
 assert.equal((await tab.runner()).code,'presend_stalled');
 assert.equal(await tab.local('presendStallHtml'),undefined);
});

test('snapshots keep the last 3 and are capped at 200 KB',async t=>{
 const old=Array.from({length:3},(_,i)=>({job:'old',run:`r${i}`,stage:'composer',at:i,url:'u',html:'x'}));
 const tab=await chatTab(t,{composer:false,local:{presendStallHtml:old}});
 await tab.page.evaluate(()=>document.querySelector('.loading').insertAdjacentHTML('beforeend','<p>'+'y'.repeat(300_000)+'</p>'));
 await tab.start();await tab.page.clock.runFor(3*MIN+5000);
 const snaps=await tab.local('presendStallHtml');
 assert.deepEqual(snaps.map(s=>s.run),['r1','r2','run-A']);
 assert.equal(snaps.at(-1).html.length,200_000);
});

test('a model menu that never opens: reasoning_skipped within its bound, then the run types and sends with the current model',async t=>{
 const tab=await chatTab(t,{menu:'dead'});
 await tab.start();
 await tab.page.clock.runFor(30_000);
 assert.equal((await tab.view()).sendClicks,0,'still waiting for the menu inside its bound');
 await tab.page.clock.runFor(35_000);
 const steps=await tab.steps();t.diagnostic(JSON.stringify(steps));
 assert.deepEqual(steps.slice(0,steps.indexOf('attachments_preparing')+1),
  ['overlays_dismissing','composer_waiting','composer_ready','overlays_dismissing','reasoning_selecting','reasoning_skipped','overlays_dismissing','attachments_preparing']);
 assert.ok(steps.includes('prompt_submitted'),`the prompt is sent: ${JSON.stringify(steps)}`);
 const view=await tab.view();
 assert.equal(view.sendClicks,1);assert.equal(view.sent,PROMPT);assert.equal(view.pill,'Thinking','the current model is kept');
 assert.equal((await tab.runner()).running,true,'now collecting the answer');
 assert.equal(await tab.local('presendStallHtml'),undefined,'a skipped level is not a stall');
});

test('a normal page: the level is picked, the prompt typed and sent, with a step for each pre-send stage',async t=>{
 const tab=await chatTab(t);
 await tab.start();
 await tab.page.clock.runFor(5000);
 const steps=await tab.steps();t.diagnostic(JSON.stringify(steps));
 assert.deepEqual(steps.slice(0,steps.indexOf('attachments_preparing')+1),
  ['overlays_dismissing','composer_waiting','composer_ready','overlays_dismissing','reasoning_selecting','overlays_dismissing','attachments_preparing']);
 assert.ok(steps.includes('prompt_submitted'));
 const view=await tab.view();
 assert.deepEqual(view,{sendClicks:1,menuItemClicks:['Extra high'],sent:PROMPT,pill:'Extra high'});
 assert.equal((await tab.runner()).running,true);
});

for(const [name,landing] of [['ko, auth attributes',loggedOutKo],['en, labels only, with a composer',loggedOutEn]])
test(`a logged-out landing (${name}) fails as logged_out within seconds; nothing is typed or sent (#455)`,async t=>{
 const tab=await chatTab(t,{landing});
 assert.equal((await tab.start()).code,'busy');
 await tab.page.clock.runFor(5000);
 const out=await tab.runner();t.diagnostic(JSON.stringify(out));
 assert.equal(out.running,false,`still waiting on a logged-out page: ${JSON.stringify(await tab.steps())}`);
 assert.equal(out.code,'logged_out');
 assert.match(out.error,/ChatGPT is logged out in this Chrome profile; log in and retry/);
 const steps=await tab.steps();t.diagnostic(JSON.stringify(steps));
 assert.equal(steps.at(-1),'logged_out');
 for(const s of ['composer_ready','attachments_preparing','prompt_prepared','send_attempted'])assert.ok(!steps.includes(s),`${s} reached on a logged-out page`);
 assert.equal(await tab.typed(),'','nothing typed');
 assert.equal((await tab.view()).sendClicks,0);
 assert.equal((await tab.send('ashlar-harvest')).code,'logged_out','the worker harvests the failure');
 assert.equal(await tab.local('presendStallHtml'),undefined,'a logged-out page is not a stall');
});
