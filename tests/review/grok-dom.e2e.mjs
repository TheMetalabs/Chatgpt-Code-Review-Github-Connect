// Grok's 2026-09 composer and transcript, built to the structure of the grok.com bundle and the live
// page (probed read-only 2026-09-29): form[data-composer]; the attachment list [role="list"] whose
// [role="listitem"] chips hold an "Open attachment" button with span.truncate (the file name); the
// editor in [data-testid="chat-input"]; the model picker div[data-query-bar-mode-select] >
// #model-select-trigger; submit data-testid=chat-submit (aria-label localized, often "제출"); and,
// while a reply streams, a strip with div[role="status"][aria-live] "Generating" (plus dots) and the
// stop button "Stop model response" (or "모델 응답 중지"). Bubbles are data-testid user-message /
// assistant-message. A synthetic page, never a live chat.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let browser;
before(async () => { browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox']}); });
after(async () => { await browser?.close(); });

const PROMPT = 'Review fixture PR #1 at abc123. Return the review JSON.';
const ANSWER = JSON.stringify({findings: [], merge_recommendation: 'APPROVE', investigated_safe: ['fixture checked']}, null, 2);
const MANIFEST = ['turns.js', 'composer.js', 'quota.js', 'overlay.js', 'model.js', 'json.js', 'site-grok.js', 'content-grok.js'];
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

/** Grok's streaming strip: the loader (role=status, "Generating" + three dots) and the stop button. */
function grokStrip(stop = 'Stop model response') {
  return `<div class="w-full flex justify-center" id="grok-strip"><div class="h-8 rounded-t-xl" style="display:flex;width:320px;height:32px">` +
    `<div role="status" aria-live="polite" id="grok-generating" style="display:inline-flex"><span>Generating</span><span><span>.</span><span>.</span><span>.</span></span></div>` +
    `<button type="button" id="grok-stop" aria-label="${stop}" style="width:32px;height:32px">x</button></div></div>`;
}
/** One Grok attachment chip (list item) showing `name`; `uploading` pulses it as Grok does before metadata. */
function grokChip(name, {uploading = false} = {}) {
  return `<div role="listitem" class="max-w-full"><div class="group/chip${uploading ? ' animate-pulse' : ''}" style="display:inline-flex;width:220px;height:32px">` +
    `<button type="button" aria-label="Open attachment" style="display:inline-flex;width:180px;height:32px"><svg width="16" height="16"></svg><span class="truncate">${name}</span></button>` +
    `<button type="button" aria-label="Remove" style="width:20px;height:20px">x</button></div></div>`;
}
function grokList(chips = []) {
  return `<div role="list" aria-label="Conversation attachments" style="display:flex">${chips.join('')}</div>`;
}

const COMPOSER = `<form data-composer="true">
  ${grokList([grokChip('ashlar-diff.patch')])}
  <button id="model-select-trigger" aria-label="Model select" style="width:88px;height:32px">Heavy</button>
  <textarea aria-label="Ask Grok anything" style="width:320px;height:48px"></textarea>
  <button type="submit" data-testid="chat-submit" aria-label="제출" title="Submit" style="width:64px;height:32px">제출</button>
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
    return {done: replyDoneVisible(), streaming: stopButtonVisible()};
  });
  assert.deepEqual(idle, {done: false, streaming: false});

  // Korean stop label and the hardcoded Generating banner both count, and neither finishes the answer.
  // The check does not record the stream. The poll's noteSawStream does, on this submission.
  const streaming = await page.evaluate(strip => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
    document.querySelector('[data-testid="chat-submit"]').remove();
    document.querySelector('form').insertAdjacentHTML('afterbegin', strip);
    const withButton = stopButtonVisible();
    const unmarked = savedSubmission().sawStream === true;
    noteSawStream(savedSubmission(), {stop: withButton, streaming: false});
    document.getElementById('grok-stop').remove();
    const bannerOnly = stopButtonVisible();
    return {withButton, bannerOnly, done: replyDoneVisible(), unmarked, marked: savedSubmission().sawStreamKey};
  }, grokStrip('모델 응답 중지'));
  assert.equal(streaming.withButton, true);
  assert.equal(streaming.bannerOnly, true);
  assert.equal(streaming.done, false);
  assert.equal(streaming.unmarked, false);
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

test('grok answer actions never finish an answer while the composer shows a stream (a regenerate under the old Copy)', async t => {
  const page = await openGrok(t, `<main>
    <div data-testid="user-message" id="response-user-A" role="article" aria-label="You">review</div>
    <div id="answer">
      <div data-testid="assistant-message" id="response-answer-A" role="article" aria-label="Grok">previous answer text</div>
      <button aria-label="Copy response" style="width:64px;height:32px">copy</button>
      <button aria-label="Like" style="width:32px;height:32px">like</button>
    </div>
  </main>${COMPOSER}`);
  const result = await page.evaluate(strip => {
    const before = replyDoneVisible();
    document.querySelector('form').insertAdjacentHTML('afterbegin', strip);
    const streaming = replyDoneVisible();
    document.getElementById('grok-strip').remove();
    return {before, streaming, after: replyDoneVisible()};
  }, grokStrip());
  assert.deepEqual(result, {before: true, streaming: false, after: true});
});

test('grok stream strip: the Generating status matches any case and spacing', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div></main>${COMPOSER}`);
  const out = await page.evaluate(strip => {
    document.querySelector('form').insertAdjacentHTML('afterbegin', strip);
    document.getElementById('grok-stop').remove();
    const seen = [];
    for (const text of ['GENERATING', '  generating\n  ...', 'Generating']) {
      document.getElementById('grok-generating').textContent = text;
      seen.push(grokStreamVisible(document));
    }
    document.getElementById('grok-generating').textContent = 'Generated';
    seen.push(grokStreamVisible(document));
    return seen;
  }, grokStrip());
  assert.deepEqual(out, [true, true, true, false]);
});

test('grok sign-in evidence is an X / Grok auth link outside the chat bubbles, never an unrelated /login link', async t => {
  const cases = [
    ['<a href="https://example.com/login" style="width:120px;height:32px">docs</a>', false],
    ['<a href="https://github.com/sign-in" style="width:120px;height:32px">gh</a>', false],
    ['<a href="https://example.com/login" style="display:inline-block;width:120px;height:32px">Log in</a>', false],
    ['<a href="https://example.com/sign-in" style="display:inline-block;width:120px;height:32px">Sign in</a>', false],
    ['<a href="https://example.com/signup" style="display:inline-block;width:120px;height:32px">Sign up</a>', false],
    ['<button type="button" style="width:120px;height:32px">Sign in</button>', true],
    ['<div data-testid="assistant-message" role="article"><a href="https://accounts.x.com/login" style="width:120px;height:32px">Log in</a></div>', false],
    ['<a href="https://accounts.x.com/i/flow/login" style="display:inline-block;width:120px;height:32px">x</a>', true],
    ['<a href="https://x.com/i/flow/login?redirect=grok" style="display:inline-block;width:120px;height:32px">x</a>', true],
    ['<a href="/sign-in?redirect=%2F" style="display:inline-block;width:120px;height:32px">go</a>', true],
  ];
  for (const [body, expected] of cases) {
    const page = await openGrok(t, body);
    assert.equal(await page.evaluate(() => grokLoggedOut()), expected, body);
  }
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
      globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
      sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
      const during = chatGenerationFinished();
      const writtenByCheck = savedSubmission().sawStream === true;
      noteSawStream(savedSubmission(), {stop: stopButtonVisible(), streaming: false});
      const marked = savedSubmission().sawStreamKey;
      document.getElementById('stop').remove();
      document.querySelector('main').insertAdjacentHTML('beforeend',
        '<div data-testid="assistant-message" id="response-answer-A" role="article">final answer text</div>');
      document.querySelector('form').insertAdjacentHTML('beforeend',
        '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
      return {during, writtenByCheck, marked, after: chatGenerationFinished()};
    });
    assert.deepEqual(out, {during: false, writtenByCheck: false, marked: 'user-A', after: true}, label);
  }
  // The same controls outside the composer (a transcript) are not this turn's stream, so the poll records nothing.
  const transcript = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div>
    <button type="button" data-testid="stop-button" style="width:64px;height:32px">x</button>
    <button type="button" aria-label="Stop generating" style="width:64px;height:32px">x</button></main>
    <form data-composer="true"><textarea style="width:320px;height:48px"></textarea></form>`);
  assert.equal(await transcript.evaluate(() => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
    noteSawStream(savedSubmission(), {stop: stopButtonVisible(), streaming: false});
    return savedSubmission().sawStream === true;
  }), false);
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

test('grok stream status is the composer\'s status strip and stop button, never the draft or an attachment name', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div></main>
    <form data-composer="true">${grokList(['Generating', 'Generating.txt', 'Stop', 'Stop model response', 'Abort'].map(name => grokChip(name)))}
      <div data-testid="chat-input"><div contenteditable="true" role="textbox" aria-label="Ask Grok anything" style="width:320px;min-height:48px"><p>Review this diff.</p><p>Generating</p><p>Stop model response</p></div></div>
      <button type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button>
    </form>`);
  const out = await page.evaluate(strip => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
    const idle = {grok: grokStreamVisible(), stop: stopButtonVisible(), marked: savedSubmission().sawStream ?? null,
      ready: attachmentStates(document.querySelector('form'), ['Generating.txt'])[0].state};
    document.querySelector('form').insertAdjacentHTML('afterbegin', strip);
    const streaming = {grok: grokStreamVisible(), marked: savedSubmission().sawStream ?? null};
    noteSawStream(savedSubmission(), {stop: stopButtonVisible(), streaming: false});
    const recorded = savedSubmission().sawStreamKey;
    document.getElementById('grok-stop').remove();
    const statusOnly = grokStreamVisible();
    document.getElementById('grok-generating').remove();
    return {idle, streaming, recorded, statusOnly, after: grokStreamVisible()};
  }, grokStrip());
  assert.deepEqual(out, {idle: {grok: false, stop: false, marked: null, ready: 'ready'}, streaming: {grok: true, marked: null}, recorded: 'user-A', statusOnly: true, after: false});
});

test('grok attachment chips are the attachment list items: not the model picker or a composer wrapper, with or without the editor', async t => {
  const picker = [
    '<div data-query-bar-mode-select="true"><button type="button" id="model-select-trigger" aria-label="모델 선택" style="width:88px;height:32px">자동</button></div>',
    '<div role="group" aria-label="Model" style="width:100px;height:32px"><button type="button" aria-label="Model select" style="width:88px;height:32px">Expert</button></div>',
  ];
  for (const model of picker) {
    const page = await openGrok(t, `<form data-composer="true"><div role="group" aria-label="Composer" title="Composer" style="width:400px;height:120px">
      ${grokList()}<div data-testid="chat-input"><textarea id="editor" style="width:320px;height:48px"></textarea></div>${model}</div></form>`);
    const out = await page.evaluate(({chips}) => {
      const form = document.querySelector('form');
      const empty = {chips: stagedChips(form).length, foreign: composerStagedFiles({}, {})};
      document.querySelector('[role="list"]').insertAdjacentHTML('beforeend', chips);
      const withFiles = composerStagedFiles({}, {});
      document.getElementById('editor').remove();
      const remount = {editor: composer(), foreign: composerStagedFiles({}, {})};
      form.querySelector('[data-testid="chat-input"]').insertAdjacentHTML('beforeend', '<textarea style="width:320px;height:48px"></textarea>');
      return {empty, withFiles, remount, mounted: composerStagedFiles({}, {}), sent: composerStagedFiles({}, {phase: 'sent', attachments: ['notes']})};
    }, {chips: ['notes', 'README', 'ashlar-diff.patch'].map(name => grokChip(name)).join('')});
    const all = ['notes', 'README', 'ashlar-diff.patch'];
    assert.deepEqual(out, {empty: {chips: 0, foreign: []}, withFiles: all, remount: {editor: null, foreign: all}, mounted: all, sent: all}, model);
  }
});

test('the run\'s own grok chip is ready once its pulse stops; a user file beside it stays foreign', async t => {
  const page = await openGrok(t, `<form data-composer="true">${grokList([grokChip('ashlar-diff.patch', {uploading: true}), grokChip('notes')])}
    <div data-testid="chat-input"><textarea style="width:320px;height:48px"></textarea></div></form>`);
  const out = await page.evaluate(() => {
    const form = document.querySelector('form');
    const before = attachmentStates(form, ['ashlar-diff.patch'])[0].state;
    form.querySelector('.animate-pulse').classList.remove('animate-pulse');
    return {before, after: attachmentStates(form, ['ashlar-diff.patch'])[0].state,
      foreign: composerStagedFiles({}, {phase: 'prepared', attachments: ['ashlar-diff.patch']})};
  });
  assert.deepEqual(out, {before: 'uploading', after: 'ready', foreign: ['notes']});
});

test('grok attachment names are never upload progress or a quota notice', async t => {
  const names = ['uploading.md', '업로드 중.txt', 'out of quota.txt', 'too many requests.md'];
  const page = await openGrok(t, `<form data-composer="true">${grokList()}
    <div data-testid="chat-input"><textarea style="width:320px;height:48px"></textarea></div>
    <button type="submit" data-testid="chat-submit" aria-label="Submit" style="width:64px;height:32px">Submit</button></form>`);
  // Chips go in from script: the fixture HTML is served without a charset (a Korean name would be mangled).
  const out = await page.evaluate(({names, chips}) => {
    const form = document.querySelector('form');
    form.querySelector('[role="list"]').insertAdjacentHTML('beforeend', chips);
    const before = {states: attachmentStates(form, names).map(entry => entry.state), ready: attachmentsReady(form, names), quota: quotaHit()};
    document.body.insertAdjacentHTML('beforeend', '<div role="alert" style="width:300px;height:40px">You\'ve reached your usage limit</div>');
    return {before, notice: quotaHit()};
  }, {names, chips: names.map(name => grokChip(name)).join('')});
  assert.deepEqual(out, {before: {states: names.map(() => 'ready'), ready: true, quota: false}, notice: true});
});

test('a grok chip is the run\'s own only under its exact name: an extensionless user file stays foreign, editor or not', async t => {
  const page = await openGrok(t, `<form data-composer="true">${grokList([grokChip('ashlar-diff.patch'), grokChip('ashlar-diff')])}
    <div data-testid="chat-input"><textarea id="editor" style="width:320px;height:48px"></textarea></div></form>`);
  const out = await page.evaluate(() => {
    const prepared = {phase: 'prepared', attachments: ['ashlar-diff.patch']};
    const [own, other] = document.querySelectorAll('[role="listitem"]');
    const matches = {own: chipShowsFile(own, 'ashlar-diff.patch'), other: chipShowsFile(other, 'ashlar-diff.patch')};
    const both = composerStagedFiles({}, prepared);
    document.getElementById('editor').remove();
    const unmounted = composerStagedFiles({}, prepared);
    own.remove();
    return {matches, both, unmounted, alone: composerStagedFiles({}, prepared)};
  });
  assert.deepEqual(out, {matches: {own: true, other: false}, both: ['ashlar-diff'], unmounted: ['ashlar-diff'], alone: ['ashlar-diff']});
});

test('a container holding the grok attachment list never reads a file name as a quota notice; real notice text in it still counts', async t => {
  const names = ['out of quota.txt', 'too many requests.md'];
  for (const wrap of ['<div class="card" id="box" style="width:400px;height:120px">', '<div role="dialog" id="box" style="width:400px;height:120px">']) {
    const page = await openGrok(t, `<form data-composer="true">${wrap}${grokList(names.map(name => grokChip(name)))}</div>
      <div data-testid="chat-input"><textarea style="width:320px;height:48px"></textarea></div></form>`);
    const out = await page.evaluate(() => {
      const before = quotaHit();
      document.getElementById('box').insertAdjacentText('beforeend', "You've reached your usage limit");
      return {before, notice: quotaHit()};
    });
    assert.deepEqual(out, {before: false, notice: true}, wrap);
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

test('grok fallback composer and model pill are signed-in evidence despite a Log in link', async t => {
  for (const label of ['Model select', '모델 선택']) {
    const page = await openGrok(t, `<form><textarea style="width:320px;height:48px"></textarea>
      <button type="button" id="pill" style="width:88px;height:32px">Expert</button></form>
      <a href="https://accounts.x.com/login" style="width:80px;height:24px">Log in</a>`);
    // Set from script: the fixture HTML is served without a charset, so a Korean attribute would be mangled.
    assert.deepEqual(await page.evaluate(label => { document.getElementById('pill').setAttribute('aria-label', label); return {editor: Boolean(composer()), pill: Boolean(grokPill()), loggedOut: grokLoggedOut()}; }, label),
      {editor: true, pill: true, loggedOut: false}, label);
  }
});

test('a transcript stop-button neither hides the grok composer stream nor counts as one', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div>
    <button type="button" id="old-stop" data-testid="stop-button" style="width:64px;height:32px">x</button></main>
    <form data-composer="true"><textarea style="width:320px;height:48px"></textarea>
    <button type="button" id="stop" aria-label="Stop model response" style="width:64px;height:32px">x</button></form>`);
  const out = await page.evaluate(() => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
    const during = chatGenerationFinished();
    const writtenByCheck = savedSubmission().sawStream === true;
    noteSawStream(savedSubmission(), {stop: stopButtonVisible(), streaming: false});
    const marked = savedSubmission().sawStreamKey;
    document.getElementById('stop').remove();
    const transcriptOnly = stopButtonVisible();
    document.getElementById('old-stop').remove();
    document.querySelector('main').insertAdjacentHTML('beforeend',
      '<div data-testid="assistant-message" id="response-answer-A" role="article">final answer text</div>');
    document.querySelector('form').insertAdjacentHTML('beforeend',
      '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
    return {during, writtenByCheck, marked, transcriptOnly, after: chatGenerationFinished()};
  });
  assert.deepEqual(out, {during: false, writtenByCheck: false, marked: 'user-A', transcriptOnly: false, after: true});
});

test('a grok stream seen before the user turn had an id still settles once it gets one; a later turn does not inherit it', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="u1" role="article">review</div></main>
    <form data-composer="true"><textarea style="width:320px;height:48px"></textarea>
    <button type="button" id="stop" aria-label="Stop model response" style="width:64px;height:32px">x</button></form>`);
  const out = await page.evaluate(() => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
    const during = chatGenerationFinished();
    noteSawStream(savedSubmission(), {stop: stopButtonVisible(), streaming: false});
    const marked = savedSubmission().sawStreamKey;
    // The same bubble gets its id, the stop goes, the answer and the idle voice control mount.
    document.getElementById('u1').id = 'response-user-A';
    document.getElementById('stop').remove();
    document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="assistant-message" id="response-answer-A" role="article">final answer text</div>');
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
    const after = chatGenerationFinished();
    noteSawStream(savedSubmission(), {stop: false, streaming: true});
    const upgraded = savedSubmission().sawStreamKey;
    // A distinct later user turn with its own answer, never streamed: not done by this send's mark.
    document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="user-message" role="article">next</div><div data-testid="assistant-message" role="article">another answer</div>');
    return {during, marked, after, upgraded, next: chatGenerationFinished()};
  });
  assert.deepEqual(out, {during: false, marked: 'n:1', after: true, upgraded: 'user-A', next: false});
});

test('a grok stream mark is this submission, not a global: another send does not inherit the counted turn', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="u1" role="article">review</div></main>
    <form data-composer="true"><textarea style="width:320px;height:48px"></textarea>
    <button type="button" id="stop" aria-label="Stop model response" style="width:64px;height:32px">x</button></form>`);
  const out = await page.evaluate(() => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
    noteSawStream(savedSubmission(), {stop: stopButtonVisible(), streaming: false});
    const marked = savedSubmission().sawStreamKey;
    document.getElementById('stop').remove();
    document.getElementById('u1').replaceWith(Object.assign(document.createElement('div'), {id: 'u2', textContent: 'review follow-up'}));
    document.getElementById('u2').setAttribute('data-testid', 'user-message');
    document.getElementById('u2').setAttribute('role', 'article');
    document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="assistant-message" role="article">an answer</div>');
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
    const sameSend = grokSawCurrentStream();
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'other', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:other', JSON.stringify({phase: 'sent', expected: 'review', baseline: 0}));
    return {marked, sameSend, other: grokSawCurrentStream()};
  });
  assert.deepEqual(out, {marked: 'n:1', sameSend: true, other: false});
});

test('a hidden grok private pill earlier in the page never masks the visible one', async t => {
  const hiddenPill = style => `<a href="/c#private" ${style} class="w-[86px]"><div data-testid="pi-incognito"></div><div data-testid="pi-incognito-fill" class="opacity-0"></div><span>개인</span></a>`;
  const variants = ['style="display:none;width:86px;height:40px"', 'style="display:inline-flex;visibility:hidden;width:86px;height:40px"', 'aria-hidden="true" style="display:inline-flex;width:86px;height:40px"'];
  for (const hidden of variants) {
    for (const on of [true, false]) {
      const page = await openGrok(t, `${hiddenPill(hidden)}${privatePill(on)}<form data-composer="true"><textarea style="width:320px;height:48px"></textarea></form>`);
      const out = await page.evaluate(async onPill => {
        const clicks = [];
        for (const a of document.querySelectorAll('a')) a.addEventListener('click', e => {
          e.preventDefault();
          clicks.push(a.getAttribute('style') || '');
          setTimeout(() => { a.outerHTML = onPill; }, 200);
        });
        await startFresh(Date.now() + 5000);
        return {clicks: clicks.length, visibleClicked: clicks.every(style => style.startsWith('display:inline-flex;width:86px')), on: grokPrivateOn()};
      }, privatePill(true));
      assert.deepEqual(out, {clicks: on ? 0 : 1, visibleClicked: true, on: true}, `${hidden} on=${on}`);
    }
  }
});

test('review on the grok DOM: the sent turn is confirmed, the stream is not collected, then the fenced JSON is', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('https://grok.com/**', route => route.fulfill({status: 200, contentType: 'text/html', body: pageHtml(
    `<main id="thread"></main><form data-composer="true"><button id="model-select-trigger" aria-label="Model select" style="width:88px;height:32px">Heavy</button><textarea id="prompt" aria-label="Ask Grok anything" style="width:320px;height:48px">${PROMPT}</textarea><button id="chat-submit" type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button></form>`)}));
  await page.clock.install();
  await page.goto(HOME);
  await page.evaluate(({prompt, strip}) => {
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
      document.querySelector('form').insertAdjacentHTML('afterbegin', strip);
    });
  }, {prompt: PROMPT, strip: grokStrip()});
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
  const marked = await journal();
  assert.equal(marked.sawStream, true, 'the poll recorded the stream on this submission');
  assert.equal(marked.sawStreamKey, 'user-A');

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

// grok.com private composer and a finished answer, captured 2026-09-30. Message text is replaced.
// The response id sits on the wrapper that also holds the action row. The last answer's controls
// are opacity 1; an earlier answer's are opacity 0. The empty composer still renders a disabled
// Submit, and its attachment list is present and empty.
// Not on that page, so not in this fixture: a file chip, an upload in progress, an upload error,
// a Generating strip, a regenerate streaming under the previous answer, a quota notice.
const CAPTURED_IDLE = `<form data-composer="true">
  <input class="hidden" multiple type="file" name="files">
  <div role="list" aria-label="대화 첨부파일" class="hidden"></div>
  <div data-testid="chat-input"><div contenteditable="true" role="textbox" aria-label="Ask Grok anything" class="tiptap ProseMirror" style="width:320px;height:48px"><p class="is-empty"></p></div></div>
  <button type="button" data-testid="attach-button" aria-label="첨부" style="width:40px;height:40px"></button>
  <div data-query-bar-mode-select="true"><button type="button" id="model-select-trigger" aria-label="모델 선택" style="width:88px;height:40px">전문가</button></div>
  <button type="button" aria-label="받아쓰기 (⌃D)" style="width:40px;height:40px"></button>
  <button type="submit" data-testid="chat-submit" aria-label="제출" disabled style="width:40px;height:40px"></button>
</form>`;
function capturedAnswer(id, {visible}) {
  const opacity = visible ? '1' : '0';
  return `<div id="response-${id}"><div data-testid="assistant-message" role="article" aria-label="Grok"><p>xx</p></div>
    <div class="action-buttons"><button type="button" aria-label="응답 복사" style="opacity:${opacity};width:32px;height:32px"></button>
    <button type="button" aria-label="Like" style="opacity:${opacity};width:32px;height:32px"></button>
    <button type="button" aria-label="Dislike" style="opacity:${opacity};width:32px;height:32px"></button>
    <button type="button" aria-label="Regenerate" style="opacity:${opacity};width:32px;height:32px"></button>
    <button type="button" aria-label="More actions" style="opacity:${opacity};width:32px;height:32px"></button></div></div>`;
}
test('captured grok.com DOM: idle private composer and a finished answer, earlier actions invisible', async t => {
  const page = await openGrok(t, `<main>
    <div data-testid="user-message" role="article" aria-label="당신"><p>x</p></div>
    ${capturedAnswer('prev', {visible: false})}
    <div data-testid="user-message" id="response-user-live" role="article" aria-label="당신"><p>x</p></div>
    ${capturedAnswer('last', {visible: true})}
  </main>${CAPTURED_IDLE}`);
  const out = await page.evaluate(() => {
    const answers = [...document.querySelectorAll('[data-testid="assistant-message"]')];
    return {
      roles: conversationTurnEls().map(turnRole),
      ids: answers.map(turnMessageId),
      pill: grokPill()?.id || '',
      editor: composer()?.getAttribute('role') || '',
      send: sendButton()?.getAttribute('data-testid') || '',
      chips: fileChips(document.querySelector('form')).length,
      streaming: stopButtonVisible(),
      quota: quotaHit(),
      loggedOut: grokLoggedOut(),
      done: replyDoneVisible(),
      earlier: replyDoneVisible(document.getElementById('response-prev')),
    };
  });
  assert.deepEqual(out, {
    roles: ['user', 'assistant', 'user', 'assistant'],
    ids: ['prev', 'last'],
    pill: 'model-select-trigger',
    editor: 'textbox',
    send: '',
    chips: 0,
    streaming: false,
    quota: false,
    loggedOut: false,
    done: true,
    earlier: false,
  });
});

test('Grok idle completion uses the polled submission, not stale persisted stream evidence', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A">review</div><div data-testid="assistant-message" id="response-answer-A">answer text</div></main>${COMPOSER}`);
  const out = await page.evaluate(async () => {
    const stale = {phase: 'sent', expected: 'review', baseline: 0, submittedUsers: 1, messageId: 'user-A', sawStream: true, sawStreamKey: 'user-A'};
    const active = {...stale, sawStream: false, sawStreamKey: undefined};
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok', confirmedSubmission: {key: 'ashlar:submission:job:run', record: active}};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify(stale));
    const staleDone = (await pollBoundResponse()).done;
    active.sawStream = true;
    active.sawStreamKey = 'user-A';
    const activeDone = (await pollBoundResponse()).done;
    active.expected = 'different prompt';
    const wrongPrompt = replyDoneVisible();
    active.expected = 'review';
    delete active.sawStreamKey;
    const missingKey = replyDoneVisible();
    document.querySelector('[data-testid="assistant-message"]').insertAdjacentHTML('beforeend', '<button aria-label="Copy response">copy</button>');
    return {staleDone, activeDone, wrongPrompt, missingKey, actionDone: replyDoneVisible()};
  });
  assert.deepEqual(out, {staleDone: false, activeDone: true, wrongPrompt: false, missingKey: false, actionDone: true});
});

// Live 2026-10-02 (aicc #619/#620, 1.1.61): both Grok legs spent exactly 60 s in reasoning_selecting and
// skipped it (the pill still read 빠른), then clicked Send with <main> aria-hidden behind an open layer and
// nothing was sent (send_unconfirmed). Grok's model pill is a Radix trigger: it opens on pointerdown, so a
// bare click() never opened the menu. A Radix menu hides <main> while open and closes on Escape.
const RADIX = `<main id="m"><p>home</p></main><form data-composer="true">${'${'}grokList([])}
  <div data-query-bar-mode-select="true"><button id="model-select-trigger" aria-label="모델 선택" aria-haspopup="menu" aria-expanded="false" style="width:88px;height:32px"><span>빠른</span></button></div>
  <textarea aria-label="Ask Grok anything" style="width:320px;height:48px"></textarea>
  <button type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button></form>`;
async function radixPage(t, {items = ['빠른', '전문가'], stuck = false} = {}) {
  const page = await openGrok(t, RADIX.replace("${grokList([])}", grokList([])));
  await page.evaluate(({items, stuck}) => {
    const pill = document.getElementById('model-select-trigger'), main = document.getElementById('m');
    const close = () => { document.getElementById('menu')?.remove(); main.removeAttribute('aria-hidden'); pill.setAttribute('aria-expanded', 'false'); };
    window.opens = 0;
    pill.addEventListener('pointerdown', () => {
      window.opens++;
      main.setAttribute('aria-hidden', 'true'); pill.setAttribute('aria-expanded', 'true');
      document.body.insertAdjacentHTML('beforeend', `<div data-radix-popper-content-wrapper><div role="menu" id="menu" style="width:160px;height:80px">${items.map(i => `<div role="menuitem" style="width:150px;height:24px">${i}</div>`).join('')}</div></div>`);
      for (const el of document.querySelectorAll('[role="menuitem"]')) el.addEventListener('click', () => { pill.querySelector('span').textContent = el.textContent; close(); });
    });
    if (!stuck) document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }, {items, stuck});
  return page;
}

test('grok model pill (Radix): opened by pointerdown, Expert selected, and the menu is closed afterwards', async t => {
  const page = await radixPage(t);
  const out = await page.evaluate(async () => ({r: await selectReasoning('grok', 'heavy', Date.now() + 5000), pill: grokPill().textContent.trim(),
    hidden: document.getElementById('m').getAttribute('aria-hidden'), blocking: grokBlockingLayer(), opens: window.opens}));
  assert.deepEqual(out, {r: 'selected', pill: '전문가', hidden: null, blocking: false, opens: 1}, JSON.stringify(out));
});

test('grok model pill (Radix): no matching item is skipped quickly and leaves no menu open', async t => {
  const page = await radixPage(t, {items: ['빠른']});
  const out = await page.evaluate(async () => { const t0 = Date.now(); const r = await selectReasoning('grok', 'expert', Date.now() + 20_000);
    return {r, ms: Date.now() - t0, blocking: grokBlockingLayer()}; });
  assert.equal(out.r, 'skipped'); assert.equal(out.blocking, false);
  assert.ok(out.ms < 5000, `skipped without waiting out the deadline: ${out.ms} ms`);
});

test('grok pre-send: a layer that will not close blocks the send and is captured in the snapshot', async t => {
  const page = await radixPage(t, {stuck: true});
  const out = await page.evaluate(async () => {
    document.getElementById('model-select-trigger').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    const closed = await closeGrokLayers(800);
    return {closed, blocking: grokBlockingLayer(), snap: snapshotHtml().includes('role="menu"')};
  });
  assert.deepEqual(out, {closed: false, blocking: true, snap: true});
});

test('grok pre-send: a stale aria-hidden on <main> with no open layer does not block the send', async t => {
  const page = await radixPage(t);
  const out = await page.evaluate(async () => { document.getElementById('m').setAttribute('aria-hidden', 'true');
    return {blocking: grokBlockingLayer(), closed: await closeGrokLayers(300)}; });
  assert.deepEqual(out, {blocking: false, closed: true});
});

// Live 2026-10-02 (aicc #639, 1.1.62): right after Send, Grok opened its age-verification dialog (captured
// with the layer snapshot: role=dialog data-analytics-name="age_verification", "나이를 확인해 주세요",
// a YYYY input and 계속하기), consumed the prompt and sent nothing; the run waited 60 s (send_unconfirmed).
const AGE_DIALOG = `<div role="dialog" data-state="open" data-analytics-name="age_verification" style="width:320px;height:160px"><h2>나이를 확인해 주세요</h2><p>태어난 연도를 선택하세요.</p><input inputmode="numeric" maxlength="4" placeholder="YYYY" aria-label="출생 연도" value=""><button type="button"><span>계속하기</span></button></div>`;
const AGE_DIALOG_NO_BUTTON = AGE_DIALOG.replace(/<button.*<\/button>/, '');
test('grok age verification that cannot be answered ends the run at once with what to do, and nothing is filled', async t => {
  const page = await radixPage(t);
  const out = await page.evaluate(async dialog => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'attempted', expected: 'review prompt', baseline: 0, attemptedAt: Date.now(), attachments: []}));
    document.body.insertAdjacentHTML('beforeend', dialog);
    const t0 = Date.now();
    let err;
    try { await clickSend(sendButton, composer, 'review prompt'); } catch (e) { err = e; }
    return {code: err?.code, message: err?.message, ms: Date.now() - t0, year: document.querySelector('[aria-label="출생 연도"]').value};
  }, AGE_DIALOG_NO_BUTTON);
  assert.equal(out.code, 'age_verification', JSON.stringify(out));
  assert.match(out.message, /verify the account's age.*could not be confirmed/);
  assert.ok(out.ms < 5000, `at once, not after 60 s: ${out.ms} ms`);
  assert.equal(out.year, '', 'no confirm button: nothing is filled');
});

// 2026-10-02, the owner's instruction: the dialog is answered with the registered year (2000) and its
// confirm button, nothing else; then the consumed prompt is looked for and Send is clicked again.
test('grok age verification is answered with 2000 and 계속하기, and a prompt left in the composer is sent again', async t => {
  const page = await radixPage(t);
  const out = await page.evaluate(async dialog => {
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    sessionStorage.setItem('ashlar:submission:job:run', JSON.stringify({phase: 'attempted', expected: 'review prompt', baseline: 0, attemptedAt: Date.now(), attachments: []}));
    document.querySelector('textarea').value = 'review prompt';
    document.body.insertAdjacentHTML('beforeend', dialog);
    const dlg = document.querySelector('[role="dialog"]'), year = dlg.querySelector('input');
    window.answered = null; window.sends = 0;
    dlg.querySelector('button').addEventListener('click', () => { window.answered = year.value; dlg.remove(); });
    document.querySelector('[data-testid="chat-submit"]').addEventListener('click', e => { e.preventDefault(); window.sends++; });
    const steps = []; const orig = globalThis.step; globalThis.step = name => { steps.push(name); return orig(name); };
    clickSend(sendButton, composer, 'review prompt').catch(() => {});
    const end = Date.now() + 15000;
    while (window.sends < 1 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    return {answered: window.answered, sends: window.sends, dialog: !!document.querySelector('[role="dialog"]'), confirmed: steps.includes('age_confirmed')};
  }, AGE_DIALOG);
  assert.deepEqual(out, {answered: '2000', sends: 1, dialog: false, confirmed: true});
});

test('grok age dialog: only the year input and its own confirm button are touched', async t => {
  const page = await radixPage(t);
  const out = await page.evaluate(async dialog => {
    document.body.insertAdjacentHTML('beforeend', dialog + '<button id="other">계속하기</button>');
    let other = 0; document.getElementById('other').addEventListener('click', () => other++);
    const before = confirmAgeDialog();
    const dlg = document.querySelector('[role="dialog"]');
    dlg.querySelector('button').addEventListener('click', () => dlg.remove());
    return {ok: await before, other, none: await confirmAgeDialog()};
  }, AGE_DIALOG);
  assert.deepEqual(out, {ok: true, other: 0, none: false});
});

// The text fallback only detects an age-like dialog: a year is typed only where Grok marks the dialog as
// the age check or the field itself is shaped like a year; any other dialog's input stays untouched.
test('grok age dialog: a text-matched dialog with an unrelated input gets no year', async t => {
  const page = await radixPage(t);
  const out = await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" data-state="open" style="width:300px;height:120px"><p>Tell us your birth year for the survey</p><input aria-label="free text" value=""><button type="button">확인</button></div>');
    let clicks = 0; document.querySelector('[role="dialog"] button').addEventListener('click', () => clicks++);
    const ok = await confirmAgeDialog();
    return {ok, value: document.querySelector('[aria-label="free text"]').value, clicks, stillAge: !!ageDialog()};
  });
  assert.deepEqual(out, {ok: false, value: '', clicks: 0, stillAge: true});
});

// Grok 2026-10-02: the live page is read step by step (as ChatGPT's was). Each stage of a Grok run keeps
// one snapshot of <main> plus its open layers in chrome.storage.local "stageHtml" (bounded).
test('each stage of a Grok run keeps one HTML snapshot with its open layers', async t => {
  const page = await radixPage(t);
  const out = await page.evaluate(async () => {
    const local = new Map(); window.chrome.storage = {local: {get: async keys => Object.fromEntries([].concat(keys).filter(k => local.has(k)).map(k => [k, local.get(k)])), set: async o => { for (const [k, v] of Object.entries(o)) local.set(k, v); }}};
    globalThis.__ashlarRunnerState = {jobId: 'job', runId: 'run', provider: 'grok'};
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" data-state="open" style="width:100px;height:50px">age</div>');
    step('prompt_prepared'); step('prompt_prepared'); step('send_waiting');
    await globalThis.__ashlarStageHtmlWrites;
    const list = local.get('stageHtml') || [];
    return {stages: list.map(e => e.stage), layer: list[0]?.html.includes('role="dialog"')};
  });
  assert.deepEqual(out, {stages: ['prompt_prepared', 'send_waiting'], layer: true});
});
