// Grok's 2026-09 composer and transcript (grok.com bundle): form[data-composer], submit
// data-testid=chat-submit (aria-label localized, often "제출"), bubbles data-testid
// user-message / assistant-message, and a stream that removes Submit and shows "Stop model
// response" (or "모델 응답 중지") plus a leaf "Generating". A synthetic page, never a live chat.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let browser;
before(async () => { browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox']}); });
after(async () => { await browser?.close(); });

const PROMPT = 'Review fixture PR #1 at abc123. Return the review JSON.';
const ANSWER = JSON.stringify({findings: [], merge_recommendation: 'APPROVE', investigated_safe: ['fixture checked']}, null, 2);
const MANIFEST = ['turns.js', 'composer.js', 'quota.js', 'overlay.js', 'model.js', 'json.js', 'content-grok.js'];
const HOME = 'https://grok.com/';

function pageHtml(body) {
  return `<!doctype html><html><body>${body}</body></html>`;
}
async function openGrok(t, body, url = HOME) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('https://grok.com/**', route => route.fulfill({status: 200, contentType: 'text/html', body: pageHtml(body)}));
  await page.goto(url);
  await page.evaluate(() => { window.chrome = {runtime: {onMessage: {addListener(fn) { window.receiver = fn; }, removeListener() {}}}}; });
  for (const file of MANIFEST) await page.addScriptTag({content: source('extension/' + file)});
  return page;
}

const COMPOSER = `<form data-composer="true">
  <button id="model-select-trigger" aria-label="Model select" style="width:88px;height:32px">Heavy</button>
  <textarea aria-label="Ask Grok anything" style="width:320px;height:48px"></textarea>
  <button type="submit" data-testid="chat-submit" aria-label="제출" title="Submit" style="width:64px;height:32px">제출</button>
  <span>ashlar-diff.patch</span>
  <a href="https://accounts.x.com/login" style="width:80px;height:24px">Log in</a>
</form>
<button type="submit" id="decoy" aria-label="Send" style="width:64px;height:32px">Send</button>`;

test('grok transcript, stream, and composer: roles, code, submit, and done only after a real stream or an answer action', async t => {
  const page = await openGrok(t, `<main>
    <div data-testid="user-message" id="response-user-A" role="article" aria-label="You">please stop and review</div>
    <div id="answer">
      <div data-testid="assistant-message" id="response-answer-A" role="article" aria-label="Grok">
        <div class="chat-code-block"><code>${ANSWER}</code><button aria-label="Copy" style="width:64px;height:32px">copy code</button></div>
      </div>
      <button aria-label="Copy response" style="width:64px;height:32px">copy</button>
    </div>
  </main>${COMPOSER}`);
  const first = await page.evaluate(() => {
    const bubble = document.querySelector('[data-testid="assistant-message"]');
    const form = document.querySelector('form');
    return {
      roles: conversationTurnEls().map(turnRole),
      ids: conversationTurnEls().map(turnMessageId),
      blocks: assistantCodeBlocks(bubble),
      send: sendButton()?.getAttribute('data-testid') || '',
      pill: grokPill()?.id || '',
      loggedOut: grokLoggedOut(),
      streaming: stopButtonVisible(),
      done: replyDoneVisible(),
      rootIsAnswer: currentAssistantRoot()?.id === 'answer',
      file: attachmentStates(form, ['ashlar-diff.patch'])[0].state,
    };
  });
  assert.deepEqual(first.roles, ['user', 'assistant']);
  assert.deepEqual(first.ids, ['user-A', 'answer-A']);
  assert.ok(first.blocks.some(block => block.includes('"APPROVE"')), first.blocks.join('\n'));
  assert.equal(first.send, 'chat-submit');
  assert.equal(first.pill, 'model-select-trigger');
  assert.equal(first.loggedOut, false);
  assert.equal(first.streaming, false);
  assert.equal(first.done, true);
  assert.equal(first.rootIsAnswer, true);
  assert.equal(first.file, 'ready');

  // A code-block Copy, and Submit still showing before any stop control, is not a finished answer.
  const idle = await page.evaluate(() => {
    document.querySelector('[aria-label="Copy response"]').remove();
    delete globalThis.__ashlarGrokSawStream;
    return {done: replyDoneVisible(), streaming: stopButtonVisible()};
  });
  assert.deepEqual(idle, {done: false, streaming: false});

  // Korean stop label and the hardcoded Generating banner both count, and neither finishes the answer.
  const streaming = await page.evaluate(() => {
    document.querySelector('[data-testid="chat-submit"]').remove();
    document.querySelector('form').insertAdjacentHTML('beforeend',
      '<button type="button" id="grok-stop" aria-label="모델 응답 중지" style="width:64px;height:32px">x</button><span id="grok-generating">Generating</span>');
    const withButton = stopButtonVisible();
    document.getElementById('grok-stop').remove();
    const bannerOnly = stopButtonVisible();
    return {withButton, bannerOnly, done: replyDoneVisible(), marked: globalThis.__ashlarGrokSawStream};
  });
  assert.equal(streaming.withButton, true);
  assert.equal(streaming.bannerOnly, true);
  assert.equal(streaming.done, false);
  assert.equal(streaming.marked, 'user-A');

  // Stream ended and Submit is gone in favour of the voice control: the answer that streamed is done.
  const settled = await page.evaluate(() => {
    document.getElementById('grok-generating').remove();
    document.querySelector('form').insertAdjacentHTML('beforeend',
      '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
    return {streaming: stopButtonVisible(), done: replyDoneVisible()};
  });
  assert.deepEqual(settled, {streaming: false, done: true});

  // The live idle control has no bot-voice-call-start test id. Its aria is enough.
  const liveVoice = await page.evaluate(() => {
    document.querySelector('[data-testid="bot-voice-call-start"]').remove();
    document.querySelector('form').insertAdjacentHTML('beforeend',
      '<button type="button" aria-label="음성 모드 시작 (⌘⇧O)" style="width:40px;height:40px"></button>');
    return replyDoneVisible();
  });
  assert.equal(liveVoice, true);
});

function privatePill(on) {
  const href = on ? '/c' : '/c#private';
  const aria = on ? '기본 채팅으로 전환' : 'Switch to Private Chat';
  const fill = on ? 'absolute inset-0' : 'absolute inset-0 opacity-0';
  const outline = on ? 'absolute inset-0 opacity-0' : 'absolute inset-0';
  return `<a href="${href}" aria-label="${aria}" style="display:inline-flex;width:86px;height:40px"><div data-testid="pi-incognito" class="${outline}"></div><div data-testid="pi-incognito-fill" class="${fill}"></div><span>개인</span></a>`;
}

test('a signed-out grok landing is logged out; a private home is left alone; a normal home clicks the top-bar private chat', async t => {
  const signedOut = await openGrok(t, '<a href="https://accounts.x.com/login" style="width:120px;height:32px">Log in</a>');
  assert.equal(await signedOut.evaluate(() => grokLoggedOut()), true);
  const bare = await openGrok(t, '<button style="width:80px;height:32px">가입하기</button><p>Welcome</p>');
  assert.equal(await bare.evaluate(() => grokLoggedOut()), false);

  const decoys = `<form data-composer="true"><textarea style="width:320px;height:48px"></textarea></form>
    <button type="button" style="width:180px;height:32px">Unavailable in Private Chats</button>
    <button type="button" style="width:180px;height:32px">Create New Private Chat</button>
    <button type="button" style="width:120px;height:32px">New Chat</button>`;
  // effect: 'none' (canceled click, mode unchanged) or 'private' (the click turns private chat on).
  const record = (page, {effect = 'private', deadline = 5000} = {}) => page.evaluate(async ({effect, deadline, onPill}) => {
    const clicks = [];
    for (const el of document.querySelectorAll('a, button')) {
      el.addEventListener('click', event => {
        event.preventDefault();
        clicks.push((el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim());
        if (effect !== 'private') return;
        // Grok's mode change lands a little after the click.
        setTimeout(() => {
          document.querySelector('[data-testid="pi-incognito"]')?.closest('a')?.remove();
          document.body.insertAdjacentHTML('afterbegin', onPill);
        }, 300);
      });
    }
    try {
      await startFresh(Date.now() + deadline);
      return {clicks, ok: true, private: grokPrivateOn()};
    } catch (e) {
      return {clicks, ok: false, code: e.code || e.message, stage: e.stage || ''};
    }
  }, {effect, deadline, onPill: privatePill(true)});
  const already = await openGrok(t, `${privatePill(true)}${decoys}`);
  assert.equal(await already.evaluate(() => grokPrivateOn()), true);
  assert.deepEqual(await record(already), {clicks: [], ok: true, private: true});

  const home = await openGrok(t, `${privatePill(false)}${decoys}`);
  assert.equal(await home.evaluate(() => grokPrivateOn()), false);
  assert.deepEqual(await record(home), {clicks: ['Switch to Private Chat'], ok: true, private: true});

  const convo = await openGrok(t, decoys, 'https://grok.com/c/fixture');
  assert.deepEqual(await record(convo), {clicks: ['Create New Private Chat'], ok: true, private: true});

  // A canceled or ineffective click is never taken as private: one click, then reject before send.
  const stuck = await openGrok(t, `${privatePill(false)}${decoys}`);
  assert.deepEqual(await record(stuck, {effect: 'none', deadline: 1500}),
    {clicks: ['Switch to Private Chat'], ok: false, code: 'presend_stalled', stage: 'private_chat'});

  // A normal home with a composer and no private control at all rejects instead of sending there.
  const bareHome = await openGrok(t, '<form data-composer="true"><textarea style="width:320px;height:48px"></textarea></form>');
  assert.deepEqual(await record(bareHome, {deadline: 1500}),
    {clicks: [], ok: false, code: 'presend_stalled', stage: 'private_chat'});
});

test('grok private-chat entry: the stop fence runs before every click', async t => {
  for (const body of [privatePill(false), '<button type="button" style="width:180px;height:32px">Create New Private Chat</button>']) {
    // Already stopped at the start: nothing is clicked.
    const stopped = await openGrok(t, body);
    assert.deepEqual(await stopped.evaluate(async () => {
      let clicks = 0;
      for (const el of document.querySelectorAll('a, button')) el.addEventListener('click', e => { e.preventDefault(); clicks++; });
      globalThis.throwIfStopped = () => { throw new Error('stopped'); };
      try { await startFresh(Date.now() + 2000); return {clicks, error: ''}; } catch (e) { return {clicks, error: e.message}; }
    }), {clicks: 0, error: 'stopped'});

    // Polling without a control, then the guard starts throwing as the control appears: zero clicks.
    const later = await openGrok(t, '<p>loading</p>');
    assert.deepEqual(await later.evaluate(async html => {
      let clicks = 0;
      let stop = false;
      globalThis.throwIfStopped = () => { if (stop) throw new Error('taken over'); };
      setTimeout(() => {
        stop = true;
        document.body.insertAdjacentHTML('beforeend', html);
        for (const el of document.querySelectorAll('a, button')) el.addEventListener('click', e => { e.preventDefault(); clicks++; });
      }, 300);
      try { await startFresh(Date.now() + 2000); return {clicks, error: ''}; } catch (e) { return {clicks, error: e.message}; }
    }, body), {clicks: 0, error: 'taken over'});
  }
});

test('a generic stop label in the grok composer records the stream, so an idle composer later settles', async t => {
  const stops = ['Stop generating', 'Stop streaming', 'Abort'].map(label => `aria-label="${label}"`).concat('data-testid="stop-button"');
  for (const label of stops) {
    const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div></main>
      <form data-composer="true"><textarea style="width:320px;height:48px"></textarea>
      <button type="button" id="stop" ${label} style="width:64px;height:32px">x</button></form>`);
    const out = await page.evaluate(() => {
      delete globalThis.__ashlarGrokSawStream;
      const during = chatGenerationFinished();
      const marked = globalThis.__ashlarGrokSawStream;
      document.getElementById('stop').remove();
      document.querySelector('main').insertAdjacentHTML('beforeend',
        '<div data-testid="assistant-message" id="response-answer-A" role="article">final answer text</div>');
      document.querySelector('form').insertAdjacentHTML('beforeend',
        '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
      return {during, marked, after: chatGenerationFinished()};
    });
    assert.deepEqual(out, {during: false, marked: 'user-A', after: true}, label);
  }
  // The same controls outside the composer (a transcript) never record a Grok stream.
  const transcript = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div>
    <button type="button" data-testid="stop-button" style="width:64px;height:32px">x</button>
    <button type="button" aria-label="Stop generating" style="width:64px;height:32px">x</button></main>
    <form data-composer="true"><textarea style="width:320px;height:48px"></textarea></form>`);
  assert.equal(await transcript.evaluate(() => { delete globalThis.__ashlarGrokSawStream; stopButtonVisible(); return globalThis.__ashlarGrokSawStream ?? null; }), null);
});

test('grok composer lookup stays inside an existing composer form until its editor mounts', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">
      <textarea id="edit" style="width:320px;height:48px">my draft edit</textarea></div></main>
    <form data-composer="true"><button type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button></form>`);
  const out = await page.evaluate(async () => {
    const before = composer()?.id ?? null;
    let settled = 'pending';
    waitUntilComposer(Date.now() + 5000).then(el => { settled = el.id; }, e => { settled = e.code || e.message; });
    await new Promise(r => setTimeout(r, 400));
    const whileAbsent = settled;
    document.querySelector('form').insertAdjacentHTML('afterbegin', '<div id="real" contenteditable="true" role="textbox" style="width:320px;height:48px"></div>');
    await new Promise(r => setTimeout(r, 1500));
    return {before, whileAbsent, after: composer()?.id, settled, draft: document.getElementById('edit').value};
  });
  assert.deepEqual(out, {before: null, whileAbsent: 'pending', after: 'real', settled: 'real', draft: 'my draft edit'});
  // No composer form at all: a transcript edit box is still never the composer.
  const legacy = await openGrok(t, `<main><div data-testid="user-message" role="article"><textarea style="width:320px;height:48px"></textarea></div></main>`);
  assert.equal(await legacy.evaluate(() => composer()), null);
});

test('grok private-chat entry never clicks past its deadline', async t => {
  for (const body of [privatePill(false), '<button type="button" style="width:180px;height:32px">Create New Private Chat</button>']) {
    const page = await openGrok(t, body);
    assert.deepEqual(await page.evaluate(async () => {
      let clicks = 0;
      for (const el of document.querySelectorAll('a, button')) el.addEventListener('click', e => { e.preventDefault(); clicks++; });
      try { await startFresh(Date.now() - 1); return {clicks, code: ''}; } catch (e) { return {clicks, code: e.code, stage: e.stage}; }
    }), {clicks: 0, code: 'presend_stalled', stage: 'private_chat'});
    // The control appears only after the deadline passed during a polling sleep: still no click.
    const late = await openGrok(t, '<p>loading</p>');
    assert.deepEqual(await late.evaluate(async html => {
      let clicks = 0;
      setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend', html);
        for (const el of document.querySelectorAll('a, button')) el.addEventListener('click', e => { e.preventDefault(); clicks++; });
      }, 500);
      try { await startFresh(Date.now() + 300); return {clicks, code: ''}; } catch (e) { return {clicks, code: e.code}; }
    }, body), {clicks: 0, code: 'presend_stalled'});
  }
});

test('grok draft text that reads Generating is not a stream; a real banner outside the editor is', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div></main>
    <form data-composer="true">
      <div contenteditable="true" aria-label="Ask Grok anything" style="width:320px;min-height:48px"><p>Review this diff.</p><p>Generating</p><p>more prompt text</p></div>
      <button type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button>
    </form>`);
  const out = await page.evaluate(() => {
    delete globalThis.__ashlarGrokSawStream;
    const draft = {grok: grokStreamVisible(), stop: stopButtonVisible(), marked: globalThis.__ashlarGrokSawStream ?? null};
    document.querySelector('form').insertAdjacentHTML('beforeend', '<span id="banner">Generating</span>');
    return {draft, banner: grokStreamVisible()};
  });
  assert.deepEqual(out, {draft: {grok: false, stop: false, marked: null}, banner: true});
});

test('a grok model-picker wrapper is neither a staged chip nor the user\'s file; a real file beside it still is', async t => {
  for (const wrapper of ['<div role="group" aria-label="Model">', '<div title="Model">']) {
    const page = await openGrok(t, `<form data-composer="true">
      ${wrapper}<button type="button" id="model-select-trigger" aria-label="Model select" style="width:88px;height:32px">Expert</button></div>
      <textarea aria-label="Ask Grok anything" style="width:320px;height:48px"></textarea>
      <button type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button>
    </form>`);
    const out = await page.evaluate(() => {
      const form = document.querySelector('form');
      const empty = {chips: stagedChips(form).length, foreign: composerStagedFiles({}, {})};
      form.insertAdjacentHTML('afterbegin', '<div role="group" aria-label="notes.txt" style="width:120px;height:32px">notes.txt</div>');
      return {empty, withFile: composerStagedFiles({}, {})};
    });
    assert.deepEqual(out, {empty: {chips: 0, foreign: []}, withFile: ['notes.txt']}, wrapper);
  }
});

test('an off-state grok pill with an SVG icon is not private; the click that turns it on is taken once', async t => {
  const svgPill = on => `<a href="${on ? '/c' : '/c#private'}" aria-label="Private" style="display:inline-flex;width:86px;height:40px"><svg data-testid="pi-incognito" class="${on ? 'absolute opacity-0' : 'absolute'}" width="20" height="20"></svg><svg data-testid="pi-incognito-fill" class="${on ? 'absolute' : 'absolute opacity-0'}" width="20" height="20"></svg><span>개인</span></a>`;
  const page = await openGrok(t, `${svgPill(false)}<form data-composer="true"><textarea style="width:320px;height:48px"></textarea></form>`);
  const out = await page.evaluate(async on => {
    const off = grokPrivateOn();
    let clicks = 0;
    const link = document.querySelector('a');
    link.addEventListener('click', e => { e.preventDefault(); clicks++; setTimeout(() => { link.outerHTML = on; }, 200); });
    await startFresh(Date.now() + 5000);
    return {off, clicks, on: grokPrivateOn()};
  }, svgPill(true));
  assert.deepEqual(out, {off: false, clicks: 1, on: true});
});

test('grok model selection skips a disabled Build entry and falls back to Expert', async t => {
  for (const disabled of ['disabled', 'aria-disabled="true"', 'data-disabled=""']) {
    const page = await openGrok(t, `<form data-composer="true"><button type="button" id="model-select-trigger" aria-label="Model select" style="width:88px;height:32px">Fast</button><textarea style="width:320px;height:48px"></textarea></form>`);
    const out = await page.evaluate(async disabled => {
      const pill = document.getElementById('model-select-trigger');
      const clicked = [];
      pill.addEventListener('click', () => {
        document.body.insertAdjacentHTML('beforeend', `<div role="menu"><button role="menuitem" id="build" ${disabled} style="width:120px;height:32px">Build</button><button role="menuitem" id="expert" style="width:120px;height:32px">Expert</button></div>`);
        for (const el of document.querySelectorAll('[role="menuitem"]')) el.addEventListener('click', () => { clicked.push(el.id); pill.textContent = el.textContent; });
      });
      const result = await selectReasoning('grok', 'build', Date.now() + 5000);
      return {result, clicked, pill: pill.textContent};
    }, disabled);
    assert.deepEqual(out, {result: 'selected', clicked: ['expert'], pill: 'Expert'}, disabled);
  }
});

test('review on the grok DOM: the sent turn is confirmed, the stream is not collected, then the fenced JSON is', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('https://grok.com/**', route => route.fulfill({status: 200, contentType: 'text/html', body: pageHtml(
    `<main id="thread"></main><form data-composer="true"><button id="model-select-trigger" aria-label="Model select" style="width:88px;height:32px">Heavy</button><textarea id="prompt" aria-label="Ask Grok anything" style="width:320px;height:48px">${PROMPT}</textarea><button id="chat-submit" type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button></form>`)}));
  await page.clock.install();
  await page.goto(HOME);
  await page.evaluate(({prompt}) => {
    sessionStorage.setItem('ashlar:job', 'job-A');
    sessionStorage.setItem('ashlar:run', 'run-A');
    sessionStorage.setItem('ashlar:submission:job-A:run-A', JSON.stringify({phase: 'prepared', expected: prompt, baseline: 0, attachments: []}));
    window.chrome = {runtime: {onMessage: {addListener(fn) { window.receiver = fn; }, removeListener() {}}}};
    window.sendClicks = 0;
    document.querySelector('form').addEventListener('submit', e => e.preventDefault());
    document.getElementById('chat-submit').addEventListener('click', () => {
      window.sendClicks++;
      const editor = document.getElementById('prompt');
      const text = editor.value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      document.getElementById('thread').insertAdjacentHTML('beforeend', `<div data-testid="user-message" id="response-user-A" role="article" aria-label="You">${text}</div>`);
      editor.value = '';
      document.getElementById('chat-submit').remove();
      document.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button" id="grok-stop" aria-label="Stop model response" style="width:64px;height:32px">x</button><span id="grok-generating">Generating</span>');
    });
  }, {prompt: PROMPT});
  for (const file of MANIFEST) await page.addScriptTag({content: source('extension/' + file)});
  const send = (type, extra = {}) => page.evaluate(msg => new Promise(resolve => { if (msg.type === 'ashlar-run') msg.until = Date.now() + 10_000; receiver(msg, null, resolve); }), {type, jobId: 'job-A', runId: 'run-A', provider: 'grok', ...extra});
  const journal = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('ashlar:submission:job-A:run-A') || 'null'));
  const steps = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('ashlar:steps:job-A:run-A') || '{"events":[]}').events.map(e => e.stage));

  await send('ashlar-run', {resume: true, prompt: PROMPT});
  await page.clock.runFor(3000);
  assert.equal(await page.evaluate(() => window.sendClicks), 1, 'sent once');
  const sent = await journal();
  assert.deepEqual([sent.phase, sent.submittedUsers, sent.messageId], ['sent', 1, 'user-A'], JSON.stringify(await steps()));

  await page.evaluate(html => document.getElementById('thread').insertAdjacentHTML('beforeend', html),
    '<div id="answer"><div data-testid="assistant-message" id="response-answer-A" role="article" aria-label="Grok"><pre><code id="code">{"findings":</code></pre></div></div>');
  await page.clock.runFor(1600);
  assert.equal((await send('ashlar-harvest')).ok, false, 'not collected while Generating is up');
  assert.ok((await steps()).includes('generating'), JSON.stringify(await steps()));

  await page.evaluate(code => {
    document.getElementById('grok-stop').remove();
    document.getElementById('grok-generating').remove();
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button id="chat-submit" type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button>');
    document.getElementById('code').textContent = code;
    document.getElementById('answer').insertAdjacentHTML('beforeend', '<button aria-label="Copy response" style="width:64px;height:32px">copy</button>');
  }, ANSWER);
  await page.clock.runFor(3200);
  const out = await send('ashlar-harvest');
  assert.equal(out.ok, true, `collected: ${JSON.stringify(out)} ${JSON.stringify(await steps())}`);
  assert.deepEqual(JSON.parse(out.raw), JSON.parse(ANSWER));
  assert.equal(await page.evaluate(() => __ashlarRunnerState.nativeCompletion?.responseId), 'answer-A');
  const verdict = result => ({canClose: result.canClose, reason: result.reason, ...(result.cause ? {cause: result.cause} : {})});
  assert.deepEqual(verdict(await send('ashlar-can-close', {allocationUrl: HOME})), {canClose: true, reason: 'complete'});
  await page.evaluate(() => document.getElementById('thread').insertAdjacentHTML('beforeend', '<div data-testid="user-message" id="response-user-B" role="article">my own question</div>'));
  assert.deepEqual(verdict(await send('ashlar-can-close', {allocationUrl: HOME})), {canClose: false, reason: 'repurposed', cause: 'user_turn'});
});
