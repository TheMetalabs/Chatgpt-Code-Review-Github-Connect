// ChatGPT's 2026-09 transcript DOM (live 1.1.41 on chatgpt.com, a review sent and answered but seen
// as 0 user turns: send_unconfirmed). No node carries data-message-author-role or data-message-id:
// a message is a search unit keyed "<turn>:<n>:<role>" (data-content-search-unit-key). A user unit
// holds the bubble ([data-user-message-bubble]) and sits in a same-keyed wrapper that also holds
// the file cards (a titled name and the type "문서") and the message id
// (data-chatgpt-search-message-ids); "내가 한 말:" is an sr-only heading beside it. An assistant unit
// carries its ids itself ("<id> <id>"), its body data-chatgpt-selection-message-id, and the turn's
// actions (복사 · 응답 평가 · 응답 다시 생성) render beside it, outside every unit. A synthetic
// counterpart of that shape, never the captured page.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
import {unitTurn,unitAnswer,renderUnitAnswer} from './unit-dom.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

const PROMPT='Review fixture PR #1 at abc123. Return the review JSON.';
const ANSWER=JSON.stringify({findings:[],merge_recommendation:'APPROVE',investigated_safe:['fixture checked']},null,2);
const FILES=['ashlar-diff.patch','ashlar-snapshot.md'];

// ── The compatibility layer itself (composer.js), on both DOMs.
const OLD='<section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="old-user"><div class="whitespace-pre-wrap">old prompt</div></div></section>'+
 '<section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="old-answer"><div class="markdown"><p>old answer</p></div></div></section>'+
 '<section data-testid="conversation-turn-3"><div data-message-author-role="user"><div class="whitespace-pre-wrap">unkeyed</div></div></section>';
async function helperPage(t,html){
 const page=await browser.newPage();t.after(()=>page.close());
 await page.setContent(`<main>${html}</main>`);
 await page.addScriptTag({content:source('extension/turns.js')});await page.addScriptTag({content:source('extension/composer.js')});
 return page;
}
test('turn helpers, 2026-09 unit DOM: the user unit and the assistant unit, their roles and ids, and the bubble text without the heading, cards or controls',async t=>{
 const page=await helperPage(t,unitTurn({text:'line one\n  line two',files:FILES}));
 await renderUnitAnswer(page,unitAnswer({code:ANSWER}));
 assert.deepEqual(await page.evaluate(()=>{
  const users=userTurnEls(),answers=assistantTurnEls(),all=conversationTurnEls();
  return {users:users.map(el=>el.getAttribute('data-content-search-unit-key')),answers:answers.map(el=>el.getAttribute('data-content-search-unit-key')),
   order:all.map(turnRole),ids:all.map(turnMessageId),legacy:userTurns().length,has:hasUserTurn(),
   text:messagePromptText(users[0]),cards:turnAttachments(users[0],['ashlar-diff.patch','ashlar-snapshot.md']).shown};
 }),{users:['fallback-turn-0:0:user'],answers:['fallback-turn-0:2:assistant'],order:['user','assistant'],ids:['user-A','answer-A'],legacy:1,has:true,
  text:'line one\n  line two',cards:true});
 // An assistant unit with no ids of its own names its message by its body's selection id.
 assert.equal(await page.evaluate(()=>{const a=assistantTurnEls()[0];a.removeAttribute('data-chatgpt-search-message-ids');return turnMessageId(a);}),'answer-A');
 // A scoped lookup: the turn container holds the user and assistant units; the unit itself is its own.
 assert.deepEqual(await page.evaluate(()=>{const box=document.querySelector('[data-content-search-turn-key]');
  return [userTurnEls(box).length,assistantTurnEls(box).length,assistantTurnEls(assistantTurnEls()[0]).length];}),[1,1,0]);
});
test('turn helpers, pre-2026-09 DOM: exactly the role nodes and their data-message-id, as before',async t=>{
 const page=await helperPage(t,OLD);
 assert.deepEqual(await page.evaluate(()=>({users:userTurnEls().map(turnMessageId),answers:assistantTurnEls().map(turnMessageId),
  order:conversationTurnEls().map(turnRole),has:hasUserTurn(),text:userTurnEls().map(el=>messagePromptText(el)),
  same:userTurnEls().every((el,i)=>el===document.querySelectorAll('[data-message-author-role="user"]')[i])})),
  {users:['old-user',''],answers:['old-answer'],order:['user','assistant','user'],has:true,text:['old prompt','unkeyed'],same:true});
 assert.deepEqual(await page.evaluate(()=>[turnRole(document.querySelector('main')),turnMessageId(document.querySelector('main')),turnMessageId(null)]),['','','']);
});

// ── The whole review flow on the unit DOM: the page clicks Send, confirms the sent turn, collects
// the fenced JSON answer, and the release verdict closes the tab (a follow-up turn keeps it).
const TEMP_URL='https://chatgpt.com/?temporary-chat=true';
const MANIFEST=['turns.js','composer.js','quota.js','overlay.js','model.js','json.js','content-chatgpt.js'];
async function unitTab(t){
 const page=await browser.newPage();t.after(()=>page.close());
 await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',
  body:`<html><body><main id="thread"></main><form data-type="unified-composer"><div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px">${PROMPT}</div><button id="composer-submit-button" aria-label="Send prompt" style="width:32px;height:32px">send</button></form></body></html>`}));
 await page.clock.install();
 await page.goto(TEMP_URL);
 await page.evaluate(({prompt,turn})=>{
  sessionStorage.setItem('ashlar:job','job-A');sessionStorage.setItem('ashlar:run','run-A');
  sessionStorage.setItem('ashlar:submission:job-A:run-A',JSON.stringify({phase:'prepared',expected:prompt,baseline:0,attachments:[]}));
  window.chrome={runtime:{onMessage:{addListener(fn){window.receiver=fn;},removeListener(){}}}};
  window.sendClicks=0;document.querySelector('form').addEventListener('submit',e=>e.preventDefault());
  // ChatGPT's Send: the sent turn renders in the unit DOM (with the review's two file cards) and Stop shows.
  document.getElementById('composer-submit-button').addEventListener('click',()=>{
   window.sendClicks++;const editor=document.getElementById('prompt-textarea');
   document.getElementById('thread').insertAdjacentHTML('beforeend',turn.replace('__TEXT__',editor.textContent.replace(/&/g,'&amp;').replace(/</g,'&lt;')));
   editor.textContent='';document.body.insertAdjacentHTML('beforeend','<button data-testid="stop-button" aria-label="Stop streaming" style="width:32px;height:32px">Stop</button>');
  });
 },{prompt:PROMPT,turn:unitTurn({text:'__TEXT__',files:FILES})});
 for(const file of MANIFEST)await page.addScriptTag({content:source('extension/'+file)});
 const send=(type,extra={})=>page.evaluate(msg=>new Promise(resolve=>{if(msg.type==='ashlar-run')msg.until=Date.now()+10_000;receiver(msg,null,resolve);}),{type,jobId:'job-A',runId:'run-A',provider:'chatgpt',...extra});
 const journal=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('ashlar:submission:job-A:run-A')||'null'));
 const steps=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('ashlar:steps:job-A:run-A')||'{"events":[]}').events.map(e=>e.stage));
 return {page,send,journal,steps};
}
test('review on the 2026-09 unit DOM: the sent turn is confirmed, the fenced JSON answer is collected, and the release verdict closes the tab',async t=>{
 const tab=await unitTab(t);
 await tab.send('ashlar-run',{resume:true});await tab.page.clock.runFor(3000);
 assert.equal(await tab.page.evaluate(()=>window.sendClicks),1,'sent once');
 const j=await tab.journal();
 assert.deepEqual([j.phase,j.submittedUsers,j.messageId],['sent',1,'user-A'],`the sent unit is the run's turn: ${JSON.stringify(await tab.steps())}`);
 // The answer streams, then finishes: Stop goes away and the turn's actions render beside the unit.
 await renderUnitAnswer(tab.page,unitAnswer({code:ANSWER.slice(0,20)}),{done:false});await tab.page.clock.runFor(1600);
 assert.equal((await tab.send('ashlar-harvest')).ok,false,'not collected while it streams');
 await tab.page.evaluate(({code,actions})=>{document.querySelector('[data-testid="stop-button"]').remove();
  document.querySelector('#code').textContent=code;document.querySelector('[data-fixture-blocks]').insertAdjacentHTML('afterend',actions);},
  {code:ANSWER,actions:unitAnswer({code:ANSWER}).actions});
 await tab.page.clock.runFor(3200);
 const out=await tab.send('ashlar-harvest');
 assert.equal(out.ok,true,`collected: ${JSON.stringify(out)} ${JSON.stringify(await tab.steps())}`);
 assert.deepEqual(JSON.parse(out.raw),JSON.parse(ANSWER));
 assert.ok(!/ChatGPT 답변|내가 한 말/.test(out.responseText||''),'the sr-only headings are not the answer');
 assert.equal(await tab.page.evaluate(()=>__ashlarRunnerState.nativeCompletion?.responseId),'answer-A','bound to the answer unit\'s id');
 const verdict=out=>({canClose:out.canClose,reason:out.reason,...(out.cause?{cause:out.cause}:{})});
 assert.deepEqual(verdict(await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL})),{canClose:true,reason:'complete'});
 // The user's own follow-up in the same DOM is a takeover: kept.
 await tab.page.evaluate(html=>document.getElementById('thread').insertAdjacentHTML('beforeend',html),unitTurn({turn:1,id:'user-B',text:'my own question'}));
 assert.deepEqual(verdict(await tab.send('ashlar-can-close',{allocationUrl:TEMP_URL})),{canClose:false,reason:'repurposed',cause:'user_turn'});
});
