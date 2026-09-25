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
  const el = await preparePresend("chatgpt", reasoning || "extra_high", deadline => waitUntilComposer(deadline));
  if (!el) throw new Error("ChatGPT composer not found");
  if (quotaHit()) throw quotaError();
  step("attachments_preparing");
  const submittedText = await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer, submittedText);
  return waitUntilReviewOrQuota("ChatGPT");
}

installReviewRunner("ChatGPT", (...args) => runPrompt(...args));
