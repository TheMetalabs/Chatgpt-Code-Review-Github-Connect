// #87: the review collector on a ChatGPT turn that ends without completion controls.
// Synthetic DOM only. The answer is shaped like the #77 R15-R17 reviews: 4 findings, 44 coverage
// rows, evidence that quotes normalizePrompt's source with nested quotes and a regex backslash.
// Field cases: 8 of 383 ChatGPT runs mounted their answer turn 1768-1772 s after the send
// (851, 876, 883, 1051, 1149, 1352, 1501, 1942). None ever completed: each stayed in
// `generating`, or fell back to `waiting_for_response` 138-212 s later and stayed until superseded.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

const MIN=60_000, HOUR=60*MIN;
const SRC='function normalizePrompt(text) { return String(text || "").replace(/\\s+/g, " ").trim(); }';
function review77({inlineFence=false,padTo=0}={}){
  const long=(s,n)=>(s+' ').repeat(Math.ceil(n/(s.length+1))).slice(0,n).trim();
  const finding=i=>({severity:i?'P2':'P1',file:'extension/composer.js',line:143+i,side:'RIGHT',
    title:'Fix readback accepts whitespace-collapsed text as byte-exact',
    failure_scenario:long('A fix prompt with two spaces is read back with one and still passes the equality gate.',800),
    root_cause:long('normalizePrompt collapses every whitespace run before comparing.',280),
    evidence:`extension/composer.js:188-189 "${SRC}"; extension/composer.js:143 "if (normalizePrompt(readComposer(el)) === normalizePrompt(body)) return body;"`,
    recommended_fix:inlineFence?'Ask for exactly one ```json fenced block and never emit ``` inside a string value.':long('Compare the raw readback for fix runs.',519),
    recommended_test:long('Round-trip a prompt with tabs, CRLF and double spaces.',391)});
  const value={merge_recommendation:'REQUEST_CHANGES',
    highest_risk:long('The fix path treats whitespace-collapsed text as byte-exact delivery.',207),
    investigated_safe:[long('Attachment envelope framing is JSON-escaped.',149),long('Send is journaled before the click.',149)],
    assumptions:Array.from({length:5},(_,i)=>long(`Assumption ${i}: only the supplied snapshot was read.`,200)),
    findings:[0,1,2,3].map(finding),
    coverage:Array.from({length:44},(_,i)=>({file:`extension/file-${i}.js`,status:i%2?'cleared':'not_cleared',
      reason:'Listed as changed, but no test source was supplied.'}))};
  if(padTo){const base=JSON.stringify(value,null,2).length;value.assumptions.push(long('Padding to an over-long answer.',Math.max(0,padTo-base)));}
  return JSON.stringify(value,null,2);
}

const user='<section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user" data-message-id="user-A"><div data-testid="collapsible-user-message-content"><div class="rich-text-user-turn markdown"><p>Review fixture.<br>Head: abc123</p><p>Only inspect changed files.</p></div></div></div></section>';
const actions='<div aria-label="응답 작업" role="group"><button data-testid="copy-turn-action-button" aria-label="응답 복사" style="width:32px;height:32px">copy</button></div>';
const codeBlock='<pre><div class="code-header">JSON<button aria-label="Copy">Copy</button></div><div><code class="language-json"></code></div></pre>';
const turn=(inner,{done=true}={})=>`<section data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="answer-A"><div class="markdown">${inner}</div></div>${done?actions:''}</section>`;

async function pageFor(t,html=''){
  const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',r=>r.abort());
  const page=await context.newPage();
  await page.setContent(`<main id="turns">${html}</main><form data-type="unified-composer"><div contenteditable="true" id="prompt-textarea" style="width:300px;min-height:40px"></div><span id="controls"></span></form>`);
  await page.clock.install();
  await page.evaluate(()=>{
    const saved=new Map();Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
    window.__ashlarRunnerState={jobId:'A',runId:'run-A',provider:'chatgpt',running:true};
    window.chrome={runtime:{onMessage:{addListener(){},removeListener(){}}}};
  });
  for(const file of ['composer.js','quota.js','model.js','json.js'])await page.addScriptTag({content:source('extension/'+file)});
  await page.evaluate(()=>{window.composer=()=>document.querySelector('#prompt-textarea');});
  return page;
}
// Same outcome path as installReviewRunner: resolve -> result, reject -> {code}.
async function collect(page){await page.evaluate(()=>{
  saveSubmission({phase:'sent',expected:'Review fixture. Head: abc123 Only inspect changed files.',baseline:0,submittedUsers:1,messageId:'user-A'});
  window.received=null;
  waitUntilReviewOrQuota('ChatGPT').then(raw=>window.received={raw},e=>{
    recordReviewStep(e?.code==='quota'?'quota':e?.code==='stalled'?'lease_expired_generating':'error');
    window.received={code:e?.code||'error',error:e.message};
  });
});}
const snap=page=>page.evaluate(()=>({received:window.received,observation:__ashlarRunnerState.observation?.state,
  stages:(__ashlarRunnerState.steps?.events||[]).map(e=>e.stage)}));
const setCode=(page,text,nth=0)=>page.locator('code').nth(nth).evaluate((el,v)=>el.textContent=v,text);
const stop=on=>`document.querySelector('#controls').innerHTML=${JSON.stringify(on?'<button data-testid="stop-button" aria-label="Stop streaming" style="width:36px;height:36px">stop</button>':'')}`;
const mount=(page,inner,opts)=>page.evaluate(html=>document.querySelector('#turns').insertAdjacentHTML('beforeend',html),turn(inner,opts));

test('control: a completed #77-shaped answer in one fenced block is collected',async t=>{
  const raw=review77(),page=await pageFor(t,user+turn(codeBlock));await setCode(page,raw);await collect(page);
  await page.clock.runFor(2400);const s=await snap(page);t.diagnostic(JSON.stringify(s.stages));
  assert.equal(s.received?.raw,raw);assert.deepEqual(s.stages.slice(-2),['json_observed','response_collected']);
});
test('content: ``` inside a JSON string cannot close a fence (not at line start); still collected',async t=>{
  const raw=review77({inlineFence:true}),page=await pageFor(t,user+turn(codeBlock));await setCode(page,raw);await collect(page);
  await page.clock.runFor(2400);assert.equal((await snap(page)).received?.raw,raw);
});
test('content: even a renderer-split fence is decided by completion controls, never left generating',async t=>{
  const raw=review77({inlineFence:true}),cut=raw.indexOf('```');
  const paragraph=raw.slice(cut+3,raw.lastIndexOf('```')).replace(/\\(["\\/])/g,'$1'); // CommonMark drops backslash escapes in prose
  const page=await pageFor(t,user+turn(`${codeBlock}<p></p>${codeBlock}`));
  await setCode(page,raw.slice(0,cut),0);await page.locator('section[data-turn="assistant"] .markdown p').evaluate((el,v)=>el.textContent=v,paragraph);await setCode(page,raw.slice(raw.lastIndexOf('```')+3),1);
  await collect(page);await page.clock.runFor(2400);const s=await snap(page);t.diagnostic(JSON.stringify(s));
  assert.equal(s.stages.at(-1),'response_completed_json_invalid');assert.equal(s.received,null);
});
test('content: an over-long (600k) answer has no length cap in the collector',async t=>{
  const raw=review77({padTo:600_000}),page=await pageFor(t,user+turn(codeBlock));await setCode(page,raw);await collect(page);
  await page.clock.runFor(2400);assert.equal((await snap(page)).received?.raw,raw);
});

// Field shape A (851, 883, 1051, 1501, 1942): reasoning hits the ~29.5 min wall, the answer turn mounts
// under Stop, Stop goes away after ~200 s, and the turn never gets copy/feedback controls.
test('field A: turn mounted at the reasoning wall, Stop gone, no completion controls -> fails as stalled',async t=>{
  const page=await pageFor(t,user);await page.evaluate(stop(true));await collect(page);
  await page.clock.runFor(2400);await page.clock.fastForward(29.5*MIN);await page.clock.runFor(2400);
  assert.equal((await snap(page)).stages.at(-1),'waiting_for_response','thinking: no bound answer yet');
  await mount(page,'<p></p>',{done:false});await page.clock.runFor(2400);
  assert.equal((await snap(page)).stages.at(-1),'generating');
  await page.clock.runFor(200_000);
  await page.evaluate(stop(false));
  await page.locator('[data-message-author-role="assistant"]').evaluate(el=>el.insertAdjacentHTML('beforeend',
    '<div class="text-token-text-error">Something went wrong while generating the response.</div><button>Retry</button>'));
  await page.clock.runFor(2400);
  const mid=await snap(page);t.diagnostic('after Stop vanished: '+JSON.stringify(mid));
  assert.equal(mid.stages.at(-1),'waiting_for_response');assert.equal(mid.observation,'generating_or_queued');
  await page.clock.runFor(16*MIN);
  const end=await snap(page);t.diagnostic('16 min later: '+JSON.stringify(end));
  assert.equal(end.received?.code,'stalled',`collector still pending 16 min after the turn stopped changing: ${JSON.stringify(end)}`);
  assert.equal(end.stages.at(-1),'lease_expired_generating');
});
// Field shape B (876, 1149, 1352): the mounted turn keeps Stop visible and never changes.
test('field B: turn mounted under a Stop that never clears, no text change -> fails as stalled',async t=>{
  const page=await pageFor(t,user);await page.evaluate(stop(true));await collect(page);
  await page.clock.runFor(2400);await page.clock.fastForward(29.5*MIN);
  await mount(page,'<p></p>',{done:false});await page.clock.runFor(2400);
  await page.clock.runFor(16*MIN);
  const end=await snap(page);t.diagnostic(JSON.stringify(end));
  assert.equal(end.received?.code,'stalled',`collector still pending: ${JSON.stringify(end)}`);
});

// Field shape B with a status label that re-renders in place (a ticking timer) inside the frozen turn.
test('field B+: a ticking status label inside a frozen turn is not progress -> fails as stalled',async t=>{
  const page=await pageFor(t,user);await page.evaluate(stop(true));await collect(page);
  await page.clock.fastForward(29.5*MIN);
  await mount(page,'<p><span id="status">Reasoning 29m 30s</span></p>',{done:false});
  await page.evaluate(()=>{let s=1770;setInterval(()=>{s+=1;document.querySelector('#status').textContent=`Reasoning ${Math.floor(s/60)}m ${s%60}s`;},1000);});
  await page.clock.runFor(16*MIN);
  const end=await snap(page);t.diagnostic(JSON.stringify(end));
  assert.equal(end.received?.code,'stalled',`collector still pending: ${JSON.stringify(end)}`);
});

// Guards: the lease never shortens a live generation.
test('guard: 29 min of thinking with no bound answer is not a stall',async t=>{
  const page=await pageFor(t,user);await page.evaluate(stop(true));await collect(page);
  for(let i=0;i<29;i+=1)await page.clock.runFor(MIN);
  assert.equal((await snap(page)).received,null);
  const raw=review77();await mount(page,codeBlock,{done:false});await setCode(page,raw);await page.evaluate(stop(false));
  await page.locator('section[data-turn="assistant"]').evaluate((el,html)=>el.insertAdjacentHTML('beforeend',html),actions);
  await page.clock.runFor(2400);assert.equal((await snap(page)).received?.raw,raw);
});
test('guard: a slow answer that keeps growing for 60 min under Stop is not a stall',async t=>{
  const raw=review77(),page=await pageFor(t,user);await page.evaluate(stop(true));await collect(page);
  await mount(page,codeBlock,{done:false});
  for(let i=1;i<=15;i+=1){await setCode(page,raw.slice(0,Math.floor(raw.length*i/16)));await page.clock.runFor(4*MIN);}
  assert.equal((await snap(page)).received,null);
  await setCode(page,raw);await page.evaluate(stop(false));
  await page.locator('section[data-turn="assistant"]').evaluate((el,html)=>el.insertAdjacentHTML('beforeend',html),actions);
  await page.clock.runFor(2400);assert.equal((await snap(page)).received?.raw,raw);
});

// A host sleep or a frozen tab stops polling mid-answer. The first poll after resume still sees the
// pre-pause answer, before ChatGPT reconnects: the pause is not the answer failing to progress.
const sleepMidAnswer=async(t,raw)=>{
  const page=await pageFor(t,user);await page.evaluate(stop(true));await collect(page);
  await mount(page,codeBlock,{done:false});await setCode(page,raw.slice(0,raw.length>>1));await page.clock.runFor(2400);
  assert.equal((await snap(page)).stages.at(-1),'generating');
  await page.clock.fastForward(20*MIN);await page.clock.runFor(2400);
  const resumed=await snap(page);t.diagnostic('first polls after a 20 min sleep: '+JSON.stringify(resumed));
  assert.equal(resumed.received,null,`the sleep counted as no progress: ${JSON.stringify(resumed)}`);
  return page;
};
test('guard: a 20 min host sleep mid-answer is not a stall; the resumed answer is collected',async t=>{
  const raw=review77(),page=await sleepMidAnswer(t,raw);
  await setCode(page,raw);await page.evaluate(stop(false));
  await page.locator('section[data-turn="assistant"]').evaluate((el,html)=>el.insertAdjacentHTML('beforeend',html),actions);
  await page.clock.runFor(2400);assert.equal((await snap(page)).received?.raw,raw);
});
test('guard: after a sleep, an answer that never progresses again still fails 15 min after resume',async t=>{
  const page=await sleepMidAnswer(t,review77());
  await page.clock.runFor(14*MIN);assert.equal((await snap(page)).received,null);
  await page.clock.runFor(2*MIN);assert.equal((await snap(page)).received?.code,'stalled');
});
// Chrome wakes a hidden tab's timers about once a minute; a stalled turn does not mutate the DOM,
// so its polls come that far apart. Those gaps are live observation, not a suspended host.
test('guard: polls throttled to one per 2 min still count toward the lease',async t=>{
  const page=await pageFor(t,user);await page.evaluate(stop(true));await collect(page);
  await mount(page,'<p></p>',{done:false});await page.clock.runFor(2400);
  for(let i=0;i<7;i+=1)await page.clock.fastForward(2*MIN);
  assert.equal((await snap(page)).received,null);
  for(let i=0;i<2;i+=1)await page.clock.fastForward(2*MIN);
  const end=await snap(page);t.diagnostic(JSON.stringify(end));assert.equal(end.received?.code,'stalled');
});

// The runner's own outcome path (installReviewRunner's catch), not the collect() mirror above: the
// worker harvests `stalled` as the leg's terminal result, and the journal ends with the lease step.
async function runViaRunner(page,{kind}={}){await page.evaluate(kind=>{
  window.__ashlarRunnerState.running=false;
  window.chrome.runtime.onMessage={addListener:fn=>window.runnerMessage=fn,removeListener(){}};
  installReviewRunner('ChatGPT',async()=>{
    saveSubmission({phase:'sent',expected:'Review fixture. Head: abc123 Only inspect changed files.',baseline:0,submittedUsers:1,messageId:'user-A'});
    return waitUntilReviewOrQuota('ChatGPT');
  });
  window.message=type=>new Promise(resolve=>runnerMessage({type,kind,jobId:'A',runId:'run-A',provider:'chatgpt',prompt:'x'},null,resolve));
  return message('ashlar-run');
},kind);}
test('runner: an expired lease ends the review leg as a stalled result with the lease step',async t=>{
  const page=await pageFor(t,user);await page.evaluate(stop(true));await runViaRunner(page);
  await page.clock.fastForward(29.5*MIN);await mount(page,'<p></p>',{done:false});await page.clock.runFor(2400);
  assert.equal((await page.evaluate(()=>message('ashlar-harvest'))).code,'busy');
  await page.clock.runFor(16*MIN);
  const result=await page.evaluate(()=>message('ashlar-harvest'));t.diagnostic(JSON.stringify({code:result.code,error:result.error}));
  assert.equal(result.code,'stalled');assert.equal(result.ok,false);
  assert.equal(result.progress.events.at(-1).stage,'lease_expired_generating');
});
