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

async function waitForReviewJson(ms) {
  const first = harvestJson();
  if (first) return first;
  const deadline = Date.now() + ms;
  let stable = "";
  let hits = 0;
  while (Date.now() < deadline) {
    await sleep(800);
    const json = harvestJson();
    if (!json) continue;
    if (json === stable) hits += 1;
    else {
      stable = json;
      hits = 1;
    }
    if (hits >= 2) return json;
  }
  return harvestJson();
}

async function runPrompt(prompt, reasoning) {
  const existing = harvestJson();
  if (existing) return existing;
  if (assistantCorpus().length) {
    const json = await waitForReviewJson(300_000);
    if (json) return json;
    throw new Error("ChatGPT did not return JSON in time");
  }
  await dismissOverlays();
  await waitFor(composer, 45_000, "ChatGPT composer not found");
  await dismissOverlays();
  await selectReasoning("chatgpt", reasoning || "pro");
  await dismissOverlays();
  const el = composer();
  if (!el) throw new Error("ChatGPT composer not found");
  if (quotaHit()) throw quotaError();
  await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer);
  const json = await waitForReviewJson(300_000);
  if (json) return json;
  throw new Error("ChatGPT did not return JSON in time");
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
