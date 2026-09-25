function composer() {
  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'form[data-type="unified-composer"] [contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (visible(el)) return el;
  }
  return null;
}

function sendButton() {
  return findEligibleSendButton(["#composer-submit-button", '[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[aria-label*="보내"]', 'button[aria-label*="전송"]', 'button[type="submit"]']);
}

/** A logged-out chatgpt.com landing (its header / sidebar / banner offer Log in and Sign up, its
 * composer form is the unauthenticated one). Attributes first; the ko/en button labels are the
 * fallback and need both a Log in and a Sign up control, so one stray word never matches. Only
 * visible controls count: a logged-in page keeps no hidden auth entry points that could trip it. */
function chatgptLoggedOut() {
  const ATTRS = ['[data-testid="login-button"]', '[data-testid="signup-button"]', "[data-login-button]",
    '[data-mobile-auth-entry-action="login"]', '[data-mobile-auth-entry-action="signup"]',
    '[data-mobile-auth-entry-action="login_or_signup"]', "form[data-logged-out]", 'form[action^="/unauth"]'];
  if (ATTRS.some(sel => [...document.querySelectorAll(sel)].some(visible))) return true;
  const label = el => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  const controls = [...document.querySelectorAll('button, a[href], [role="button"]')].filter(visible);
  if (controls.some(el => el.matches?.('a[href*="auth.openai.com"]') && /log ?in|sign ?up|로그인|회원가입/i.test(label(el) + " " + el.getAttribute("href")))) return true;
  const LOGIN = ["log in", "로그인"], SIGNUP = ["sign up", "sign up for free", "무료로 회원가입", "회원가입"];
  const labels = new Set(controls.map(label));
  return LOGIN.some(l => labels.has(l)) && SIGNUP.some(l => labels.has(l));
}

function throwIfLoggedOut() {
  if (!chatgptLoggedOut()) return;
  const e = new Error("ChatGPT is logged out in this Chrome profile; log in and retry (nothing was typed or sent)");
  e.code = "logged_out";
  throw e;
}

function quotaError() {
  const e = new Error("ChatGPT usage limit");
  e.code = "quota";
  return e;
}

async function runPrompt(prompt, reasoning, resume = false) {
  // A restarted worker must observe the existing request, never submit it again.
  if (resume) {
    await resumeSubmission(sendButton, composer, prompt);
    return waitUntilReviewOrQuota("ChatGPT");
  }
  // Every pre-send stage is bounded (composer.js preparePresend): a stall fails as presend_stalled.
  // A logged-out landing fails at once as logged_out: no stage can recover it (#455 waited 3 min).
  const el = await preparePresend("chatgpt", reasoning || "extra_high", deadline => waitUntilComposer(deadline, throwIfLoggedOut), throwIfLoggedOut);
  if (!el) throw new Error("ChatGPT composer not found");
  if (quotaHit()) throw quotaError();
  step("attachments_preparing");
  const submittedText = await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer, submittedText);
  return waitUntilReviewOrQuota("ChatGPT");
}

installReviewRunner("ChatGPT", (...args) => runPrompt(...args));
