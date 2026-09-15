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
  const selectors = [
    "#composer-submit-button",
    '[data-testid="send-button"]',
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function quotaError() {
  const e = new Error("ChatGPT usage limit");
  e.code = "quota";
  return e;
}

async function waitUntilReviewOrQuota() {
  let stable = "";
  let hits = 0;
  for (;;) {
    const json = harvestJson();
    if (quotaHit() && !json) throw quotaError();
    if (json) {
      if (json === stable) hits += 1;
      else {
        stable = json;
        hits = 1;
      }
      if (hits >= 2 && !stopButtonVisible()) return json;
    }
    await sleep(800);
  }
}

async function runPrompt(prompt, reasoning) {
  const existing = harvestJson();
  if (existing) return existing;
  if (assistantCorpus().length) return waitUntilReviewOrQuota();
  await dismissOverlays();
  await waitUntilComposer();
  await dismissOverlays();
  await selectReasoning("chatgpt", reasoning || "pro");
  await dismissOverlays();
  const el = composer();
  if (!el) throw new Error("ChatGPT composer not found");
  if (quotaHit()) throw quotaError();
  await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer);
  return waitUntilReviewOrQuota();
}

let running = false;
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "ashlar-harvest") {
    const raw = harvestJson();
    sendResponse(raw ? { ok: true, raw } : { ok: false, error: "no json" });
    return true;
  }
  if (msg?.type !== "ashlar-run") return;
  if (running) {
    const raw = harvestJson();
    sendResponse(raw ? { ok: true, raw } : { ok: false, error: "already running" });
    return true;
  }
  running = true;
  runPrompt(String(msg.prompt || ""), msg.reasoning)
    .then((raw) => sendResponse({ ok: true, raw }))
    .catch((e) =>
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        code: e && e.code === "quota" ? "quota" : undefined,
      }),
    )
    .finally(() => {
      running = false;
    });
  return true;
});
