// Upload wait bound (live 1.1.35, a REVIEW run on a real aicc PR): the page recorded
// attachments_preparing, prompt_prepared, attachments_waiting, and then sat there for 13+ minutes
// without clicking Send. The send barrier waited, with no deadline, for a chip whose name equals
// each staged file's exactly, and for no progress element ANYWHERE in the form. Now chips match
// names as ChatGPT renders them (any case, truncated with an ellipsis, without the extension),
// progress is read only in the run's own chips, and the wait is bounded at 3 min: past it the run
// ends as attachment_failed naming what was not ready, with an HTML snapshot for diagnosis.
// Real Chromium pages served at a chatgpt.com URL, the manifest content scripts in manifest order,
// a fresh review run with the three staged files, and the page's clock installed.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

const MIN=60_000;
const MANIFEST=['composer.js','quota.js','overlay.js','model.js','json.js','content-chatgpt.js'];
const URL_='https://chatgpt.com/?temporary-chat=true';
const PROMPT='Review fixture PR #1 at abc123. Return the review JSON.';
const FILES=['ashlar-diff.patch','ashlar-snapshot.md','ashlar-policy.md'];
const ENVELOPE=`${PROMPT}\n<<<ASHLAR_ATTACHMENTS_V2>>>\n${JSON.stringify(FILES.map(name=>({name,body:`body of ${name}`})))}\n<<<END_ASHLAR_ATTACHMENTS_V2>>>\n`;
const stopButton='<button data-testid="stop-button" aria-label="Stop generating" style="width:32px;height:32px">Stop</button>';
const unifiedForm=`<form data-type="unified-composer"><div id="chips" style="display:flex"></div><input type="file" multiple style="width:1px;height:1px"><div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px"></div><div id="toolbar" style="display:flex"><button id="composer-submit-button" aria-label="Send prompt" style="width:32px;height:32px">send</button></div></form>`;

// The new home composer (live 1.1.36 snapshot): no data-type, three hidden file inputs in one form,
// the image/video one first, the "파일 등 추가" menu button, a ProseMirror textbox and a 보내기 Send.
// Like the page, only the 파일 첨부 input (no accept filter) turns text files into chips.
const homeForm=`<form class="relative flex flex-col gap-2" data-composer-placement="home" data-chatgpt-composer="" data-thread-find-composer="true"><div data-above-composer-portal="true" data-above-composer-conversation-id="chatgpt:local-chatgpt:c803197f-ee32-4978-be88-406380caf1e9"></div><div data-composer-layout="multiline" role="presentation"><div class="relative w-full flex-col gap-2 flex"><input id="_r_bn_" accept="image/*,video/*" aria-label="사진 또는 동영상 첨부" class="hidden" style="display:none" multiple="" type="file"><input id="_r_bm_" class="hidden" style="display:none" accept="image/*" aria-label="사진 첨부" multiple="" type="file"><input id="_r_bl_" class="hidden" style="display:none" aria-label="파일 첨부" multiple="" type="file"><div data-composer-body=""><div id="chips" data-composer-attachments="" style="display:flex"></div><div contenteditable="true" role="textbox" class="ProseMirror" aria-label="ChatGPT에게 물어보세요" id="prompt-textarea" style="width:300px;min-height:40px"></div><div id="toolbar" style="display:flex"><button type="button" aria-label="파일 등 추가" style="width:32px;height:32px">+</button><button type="button" id="composer-submit-button" aria-label="보내기" style="width:32px;height:32px">send</button></div></div></div></div></form>`;

/** How the page renders a staged file's chip. `display(name)`: the name the chip shows; `spin`: a
 * progress ring in the chip's card that never goes away. */
const card=(shown,type,spin='')=>`<div class="chip-card" style="display:flex;width:180px;height:40px"><div title="${shown}" style="width:120px;height:20px"><div class="truncate">${shown}</div><div>${type}</div></div>${spin}<button aria-label="Remove file" style="width:10px;height:10px">x</button></div>`;
const RENDER={
 exact:name=>card(name,'File'),
 // ChatGPT's own renderings: a changed case, a middle-truncated name, the name with its type apart.
 real:name=>({'ashlar-diff.patch':card('Ashlar-Diff.patch','File'),'ashlar-snapshot.md':card('ashlar-snaps…md','Document'),
  'ashlar-policy.md':card('ashlar-policy','Markdown')})[name],
 stuck:name=>name==='ashlar-snapshot.md'?card(name,'File','<svg class="animate-spin" role="progressbar" style="width:16px;height:16px"><circle r="4"></circle></svg>'):card(name,'File'),
};

async function chatTab(t,{render='exact',stray=false,local:initial={},home=false}={}){
 const composerForm=home?homeForm:unifiedForm;
 const page=await browser.newPage();t.after(()=>page.close());
 await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:`<html><body><main id="thread"></main>${composerForm}</body></html>`}));
 await page.clock.install();
 await page.goto(URL_);
 const chips=Object.fromEntries(FILES.map(name=>[name,RENDER[render](name)]));
 await page.evaluate(({initial,stopButton,chips,stray})=>{
  const local=new Map(Object.entries(initial));window.__local=local;
  const pick=keys=>Object.fromEntries(keys.filter(k=>local.has(k)).map(k=>[k,JSON.parse(JSON.stringify(local.get(k)))]));
  window.chrome={runtime:{onMessage:{addListener(fn){window.receiver=fn;},removeListener(){}}},
   storage:{local:{get:async keys=>pick(Array.isArray(keys)?keys:[keys]),set:async items=>{for(const [k,v] of Object.entries(items))local.set(k,JSON.parse(JSON.stringify(v)));}}}};
  window.sendClicks=0;
  document.querySelector('form').addEventListener('submit',e=>e.preventDefault());
  // A spinner that is not an upload: a busy tool button beside Send, there for the whole run.
  if(stray)document.getElementById('toolbar').insertAdjacentHTML('afterbegin','<span class="animate-spin" role="progressbar" aria-busy="true" style="width:16px;height:16px;display:inline-block"></span>');
  // The upload: each staged file's chip renders a moment after the input changes.
  for(const input of document.querySelectorAll('input[type=file]'))input.addEventListener('change',event=>{
   const accept=event.currentTarget.getAttribute('accept')||'';
   // An image/video input drops text files, with no chip (what the page did live).
   const names=[...event.currentTarget.files].filter(file=>!accept||accept.split(',').some(a=>file.type.startsWith(a.replace('*','')))).map(file=>file.name);
   setTimeout(()=>{for(const name of names)document.getElementById('chips').insertAdjacentHTML('beforeend',chips[name]);},500);
  });
  document.getElementById('composer-submit-button').addEventListener('click',event=>{
   window.sendClicks++;
   const text=document.getElementById('prompt-textarea').textContent;
   document.getElementById('thread').innerHTML=`<section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user" data-message-id="user-A"><div class="whitespace-pre-wrap">${text}</div></div></section>`;
   document.getElementById('prompt-textarea').textContent='';document.getElementById('chips').innerHTML='';
   event.currentTarget.remove();document.body.insertAdjacentHTML('beforeend',stopButton);
  });
 },{initial,stopButton,chips,stray});
 for(const file of MANIFEST)await page.addScriptTag({content:source('extension/'+file)});
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>{if(msg.type==='ashlar-run')msg.until=Date.now()+10_000;receiver(msg,null,resolve);}),
  {type,jobId:'job-A',runId:'run-A',provider:'chatgpt',...extra});
 return {page,send,
  start:()=>send('ashlar-run',{prompt:ENVELOPE,reasoning:'extra_high',allocationUrl:URL_}),
  steps:()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('ashlar:steps:job-A:run-A')||'{"events":[]}').events.map(e=>e.stage)),
  runner:()=>page.evaluate(()=>({running:__ashlarRunnerState.running,code:__ashlarRunnerState.result?.code,error:__ashlarRunnerState.result?.error})),
  local:key=>page.evaluate(key=>window.__local.get(key),key),
  view:()=>page.evaluate(()=>({sendClicks:window.sendClicks,sent:document.querySelector('[data-message-author-role="user"]')?.textContent||''})),
 };
}

test('chips named as ChatGPT renders them (case, truncated with an ellipsis, no extension) are ready: Send is clicked',async t=>{
 const tab=await chatTab(t,{render:'real'});
 await tab.start();
 await tab.page.clock.runFor(10_000);
 const steps=await tab.steps();t.diagnostic(JSON.stringify(steps));
 assert.ok(steps.includes('prompt_submitted'),`the prompt is not sent: ${JSON.stringify(steps)}`);
 assert.deepEqual(await tab.view(),{sendClicks:1,sent:PROMPT});
 assert.equal((await tab.runner()).running,true,'now collecting the answer');
 assert.equal(await tab.local('uploadWaitHtml'),undefined);
});

test('the new home composer (image input first, 파일 첨부 last): all three review files become chips and Send is clicked',async t=>{
 const tab=await chatTab(t,{home:true});
 await tab.start();
 await tab.page.clock.runFor(10_000);
 const steps=await tab.steps();t.diagnostic(JSON.stringify(steps));
 const staged=await tab.page.evaluate(()=>[...document.querySelectorAll('input[type=file]')].map(i=>[i.getAttribute('aria-label'),[...i.files].map(f=>f.name)]));
 t.diagnostic(JSON.stringify(staged));
 assert.deepEqual(staged.find(([label])=>label==='파일 첨부')?.[1],FILES,'the review files go to the 파일 첨부 input');
 assert.ok(steps.includes('prompt_submitted'),`the prompt is not sent: ${JSON.stringify(steps)} ${JSON.stringify(await tab.runner())}`);
 assert.deepEqual(await tab.view(),{sendClicks:1,sent:PROMPT});
 assert.equal(await tab.local('uploadWaitHtml'),undefined);
});

test('a stray spinner outside the chips does not hold the send',async t=>{
 const tab=await chatTab(t,{stray:true});
 await tab.start();
 await tab.page.clock.runFor(10_000);
 const steps=await tab.steps();t.diagnostic(JSON.stringify(steps));
 assert.ok(steps.includes('prompt_submitted'),`the prompt is not sent: ${JSON.stringify(steps)}`);
 assert.equal((await tab.view()).sendClicks,1);
});

test('a chip that never finishes uploading: attachment_failed at 3 min, naming it, with a snapshot of the form',async t=>{
 const tab=await chatTab(t,{render:'stuck'});
 await tab.start();
 await tab.page.clock.runFor(10_000);
 assert.equal((await tab.steps()).at(-1),'attachments_waiting');
 await tab.page.clock.runFor(2*MIN);
 assert.equal((await tab.runner()).running,true,'still inside the upload bound');
 await tab.page.clock.runFor(MIN);
 const out=await tab.runner();t.diagnostic(JSON.stringify(out));
 assert.equal(out.running,false,`still waiting past the upload bound: ${JSON.stringify(await tab.steps())}`);
 assert.equal(out.code,'attachment_failed');
 assert.match(out.error,/within 3 minutes/);
 assert.match(out.error,/not ready ashlar-snapshot\.md \(uploading\);/);
 assert.match(out.error,/chips found .*ashlar-diff\.patch.*ashlar-snapshot\.md.*ashlar-policy\.md/);
 assert.match(out.error,/progress in a chip/);
 assert.equal((await tab.view()).sendClicks,0,'nothing was sent');
 assert.equal((await tab.send('ashlar-harvest')).code,'attachment_failed','the worker harvests the failure');
 const snaps=await tab.local('uploadWaitHtml');
 assert.equal(snaps?.length,1,'one snapshot recorded');
 const [snap]=snaps;
 assert.deepEqual({job:snap.job,run:snap.run,url:snap.url,notReady:snap.notReady,progressInChips:snap.progressInChips},
  {job:'job-A',run:'run-A',url:'https://chatgpt.com/',notReady:['ashlar-snapshot.md (uploading)'],progressInChips:true});
 assert.match(snap.html,/^<form data-type="unified-composer">/);
 assert.match(snap.html,/title="ashlar-snapshot.md"/);
});

test('uploadWaitHtmlOff:true records no snapshot; snapshots keep the last 3',async t=>{
 const off=await chatTab(t,{render:'stuck',local:{uploadWaitHtmlOff:true}});
 await off.start();await off.page.clock.runFor(3*MIN+15_000);
 assert.equal((await off.runner()).code,'attachment_failed');
 assert.equal(await off.local('uploadWaitHtml'),undefined);
 const old=Array.from({length:3},(_,i)=>({job:'old',run:`r${i}`,at:i,url:'u',html:'x'}));
 const tab=await chatTab(t,{render:'stuck',local:{uploadWaitHtml:old}});
 await tab.start();await tab.page.clock.runFor(3*MIN+15_000);
 assert.deepEqual((await tab.local('uploadWaitHtml')).map(s=>s.run),['r1','r2','run-A']);
});
