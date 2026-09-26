// Live 1.1.47 (#93 job-muhzslc5-829, aicc #439 job-mui1u6wu-883): two reviews sat in
// waiting_for_response for 100-158 min while others posted in 4. Their chrome.storage copy held the
// 883 page 5 s and 60 s after its Send: ChatGPT's 2026-09 unit DOM, the sent turn confirmed, the
// answer thinking under an agent-turn marker with no assistant unit yet. Both were review-loop round
// prompts quoting the head as `f02ec26` / `5c0bf56`, which the page renders as <code>f02ec26</code>:
// the send was confirmed by composer.js reviewTurnHolds (Markdown-tolerant), but the collector bound
// the answer only to a turn holding the prompt's raw text, so no answer was ever bound, the generating
// lease never started, and nothing bounded the wait. Synthetic counterparts of that page, never the
// captured one.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
import {esc,unitAnswer,renderUnitAnswer} from './unit-dom.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

const MIN=60_000;
const PROMPT='You are Ashlar. Code review only.\n\n<<<UNTRUSTED_USER_LINE>>>\nAshlar review-loop continues — requesting the next review (round 2 on `f02ec26`).\n<<<END>>>\n\nReturn the review JSON.';
const ANSWER=JSON.stringify({findings:[],merge_recommendation:'APPROVE',investigated_safe:['fixture checked']},null,2);
// The sent turn as the 2026-09 page renders it: its `code` spans become <code>, the backticks gone.
const rendered=text=>esc(text).replace(/`([^`]+)`/g,'<code>$1</code>');
const userTurn=`<div data-turn-key="user-A"><div data-content-search-turn-key="fallback-turn-0"><div class="contents"><div class="flex flex-col" data-fixture-blocks><div class="block"><h4 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden">내가 한 말:</h4><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="user-A"><div data-content-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble="true"><div class="overflow-hidden" data-search-result-target=""><div class="text-size-chat whitespace-pre-wrap" dir="auto">${rendered(PROMPT)}</div></div><span aria-hidden="true" class="block">…</span><button type="button" aria-expanded="false" data-thread-find-skip="true"><span>더 보기</span></button></div></div></div></div></div></div></div></div>`;
// What the captured page showed while the model thought: an agent-turn marker and a "생각 중" activity
// header with interim notes, no assistant unit.
const thinking=`<div class="block" id="thinking"><span hidden="" data-chatgpt-agent-turn-start=""></span><div class="min-w-0"><button type="button" aria-expanded="true"></button><span><span>생각 중</span></span><div><div dir="auto" data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary"><p>검토 범위 정리 완료</p></div></div></div></div>`;
const stopButton='<button type="button" aria-label="중지" style="width:36px;height:36px">s</button>';

async function pageFor(t,{off=false}={}){
  const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',r=>r.abort());
  const page=await context.newPage();
  await page.setContent(`<main id="turns">${userTurn}</main><form data-type="unified-composer"><div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px"></div><span id="controls">${stopButton}</span></form>`);
  await page.clock.install();
  await page.evaluate(off=>{
    const saved=new Map();Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
    const local=off?{responseWaitHtmlOff:true}:{};
    window.__ashlarRunnerState={jobId:'A',runId:'run-A',provider:'chatgpt',running:true};
    window.chrome={runtime:{onMessage:{addListener(){},removeListener(){}}},storage:{local:{
      get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in local).map(k=>[k,structuredClone(local[k])])),
      set:async v=>{Object.assign(local,structuredClone(v));}}}};
    window.__local=local;
  },off);
  for(const file of ['turns.js','composer.js','quota.js','model.js','json.js'])await page.addScriptTag({content:source('extension/'+file)});
  await page.evaluate(()=>{window.composer=()=>document.querySelector('#prompt-textarea');});
  await page.evaluate(html=>document.querySelector('[data-fixture-blocks]').insertAdjacentHTML('beforeend',html),thinking);
  return page;
}
// Same outcome path as installReviewRunner: resolve -> result, reject -> {code} and its step.
async function collect(page){await page.evaluate(prompt=>{
  saveSubmission({phase:'sent',expected:normalizePrompt(prompt),baseline:0,submittedUsers:1,messageId:'user-A',attemptedAt:Date.now()});
  window.received=null;
  waitUntilReviewOrQuota('ChatGPT').then(raw=>window.received={raw},e=>{
    recordReviewStep(e?.code==='stalled'?'lease_expired_generating':e?.code==='response_timeout'?'response_timeout':'error');
    window.received={code:e?.code||'error',error:e.message};
  });
},PROMPT);}
const snap=page=>page.evaluate(()=>({received:window.received,observation:__ashlarRunnerState.observation?.state,
  stages:(__ashlarRunnerState.steps?.events||[]).map(e=>e.stage),saved:window.__local.responseWaitHtml||null}));
async function answer(page){
  await page.evaluate(()=>{document.querySelector('#thinking').remove();document.querySelector('#controls').innerHTML='';});
  await renderUnitAnswer(page,unitAnswer({code:ANSWER}));
}

test('new DOM: a sent prompt whose `code` spans render as <code> binds, and its answer is collected',async t=>{
  const page=await pageFor(t);
  // The send barrier's rule confirms this turn; the collector must bind the same turn.
  assert.deepEqual(await page.evaluate(prompt=>{const u=userTurnEls()[0],sub={phase:'sent',expected:normalizePrompt(prompt),baseline:0,submittedUsers:1,messageId:'user-A'};
    return {holds:reviewTurnHolds(messagePromptText(u),sub.expected),identified:boundReviewResponse(sub).identified,integrity:journaledTurnIntegrity(sub,userTurnEls())};},PROMPT),
    {holds:true,identified:true,integrity:'exact'});
  await collect(page);await page.clock.runFor(2400);
  assert.equal((await snap(page)).received,null,'still thinking');
  await answer(page);await page.clock.runFor(2400);
  const s=await snap(page);t.diagnostic(JSON.stringify(s.stages));
  assert.equal(s.received?.raw,ANSWER);assert.equal(s.stages.at(-1),'response_collected');
});

test('guard: a long thinking run whose answer lands at 28 min is still collected',async t=>{
  const page=await pageFor(t);await collect(page);
  for(let i=0;i<28;i+=1)await page.clock.runFor(MIN);
  assert.equal((await snap(page)).received,null);
  await answer(page);await page.clock.runFor(2400);
  const s=await snap(page);
  assert.equal(s.received?.raw,ANSWER);assert.equal(s.saved,null);
});
