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
    delete globalThis.__ashlarGrokSawStream;
    return {done: replyDoneVisible(), streaming: stopButtonVisible()};
  });
  assert.deepEqual(idle, {done: false, streaming: false});

  // Korean stop label and the hardcoded Generating banner both count, and neither finishes the answer.
  const streaming = await page.evaluate(strip => {
    document.querySelector('[data-testid="chat-submit"]').remove();
    document.querySelector('form').insertAdjacentHTML('afterbegin', strip);
    const withButton = stopButtonVisible();
    document.getElementById('grok-stop').remove();
    const bannerOnly = stopButtonVisible();
    return {withButton, bannerOnly, done: replyDoneVisible(), marked: globalThis.__ashlarGrokSawStream};
  }, grokStrip('모델 응답 중지'));
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

test('grok stream status is the composer\'s status strip and stop button, never the draft or an attachment name', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="response-user-A" role="article">review</div></main>
    <form data-composer="true">${grokList(['Generating', 'Generating.txt', 'Stop', 'Stop model response', 'Abort'].map(name => grokChip(name)))}
      <div data-testid="chat-input"><div contenteditable="true" role="textbox" aria-label="Ask Grok anything" style="width:320px;min-height:48px"><p>Review this diff.</p><p>Generating</p><p>Stop model response</p></div></div>
      <button type="submit" data-testid="chat-submit" aria-label="제출" style="width:64px;height:32px">제출</button>
    </form>`);
  const out = await page.evaluate(strip => {
    delete globalThis.__ashlarGrokSawStream;
    const idle = {grok: grokStreamVisible(), stop: stopButtonVisible(), marked: globalThis.__ashlarGrokSawStream ?? null,
      ready: attachmentStates(document.querySelector('form'), ['Generating.txt'])[0].state};
    document.querySelector('form').insertAdjacentHTML('afterbegin', strip);
    const streaming = {grok: grokStreamVisible(), marked: globalThis.__ashlarGrokSawStream ?? null};
    document.getElementById('grok-stop').remove();
    const statusOnly = grokStreamVisible();
    document.getElementById('grok-generating').remove();
    return {idle, streaming, statusOnly, after: grokStreamVisible()};
  }, grokStrip());
  assert.deepEqual(out, {idle: {grok: false, stop: false, marked: null, ready: 'ready'}, streaming: {grok: true, marked: 'user-A'}, statusOnly: true, after: false});
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
    delete globalThis.__ashlarGrokSawStream;
    const during = chatGenerationFinished();
    const marked = globalThis.__ashlarGrokSawStream;
    document.getElementById('stop').remove();
    const transcriptOnly = stopButtonVisible();
    document.getElementById('old-stop').remove();
    document.querySelector('main').insertAdjacentHTML('beforeend',
      '<div data-testid="assistant-message" id="response-answer-A" role="article">final answer text</div>');
    document.querySelector('form').insertAdjacentHTML('beforeend',
      '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
    return {during, marked, transcriptOnly, after: chatGenerationFinished()};
  });
  assert.deepEqual(out, {during: false, marked: 'user-A', transcriptOnly: false, after: true});
});

test('a grok stream seen before the user turn had an id still settles once it gets one; a later turn does not inherit it', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="u1" role="article">review</div></main>
    <form data-composer="true"><textarea style="width:320px;height:48px"></textarea>
    <button type="button" id="stop" aria-label="Stop model response" style="width:64px;height:32px">x</button></form>`);
  const out = await page.evaluate(() => {
    delete globalThis.__ashlarGrokSawStream;
    const during = chatGenerationFinished();
    const marked = globalThis.__ashlarGrokSawStream;
    // One update: the same bubble gets its id, the stop goes, the answer and the idle voice control mount.
    document.getElementById('u1').id = 'response-user-A';
    document.getElementById('stop').remove();
    document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="assistant-message" id="response-answer-A" role="article">final answer text</div>');
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
    const after = chatGenerationFinished();
    // A distinct later user turn with its own answer, never streamed: not done by the old observation.
    document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="user-message" role="article">next</div><div data-testid="assistant-message" role="article">another answer</div>');
    return {during, marked, after, next: chatGenerationFinished()};
  });
  assert.deepEqual(out, {during: false, marked: 'n:1', after: true, next: false});
});

test('an id-less grok stream observation is not inherited by a replacement bubble at the same count', async t => {
  const page = await openGrok(t, `<main><div data-testid="user-message" id="u1" role="article">review</div></main>
    <form data-composer="true"><textarea style="width:320px;height:48px"></textarea>
    <button type="button" id="stop" aria-label="Stop model response" style="width:64px;height:32px">x</button></form>`);
  const out = await page.evaluate(() => {
    delete globalThis.__ashlarGrokSawStream;
    chatGenerationFinished();
    const marked = globalThis.__ashlarGrokSawStream;
    document.getElementById('stop').remove();
    document.getElementById('u1').replaceWith(Object.assign(document.createElement('div'), {id: 'u2', textContent: 'other'}));
    document.getElementById('u2').setAttribute('data-testid', 'user-message');
    document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="assistant-message" role="article">an answer</div>');
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button" data-testid="bot-voice-call-start" style="width:64px;height:32px">voice</button>');
    return {marked, saw: grokSawCurrentStream(), done: chatGenerationFinished()};
  });
  assert.deepEqual(out, {marked: 'n:1', saw: false, done: false});
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
