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

function lastAssistant() {
  const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const last = nodes.at(-1);
  return last ? last.innerText.trim() : "";
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    JSON.parse(body.slice(start, end + 1));
    return body.slice(start, end + 1);
  } catch {
    return null;
  }
}

async function runPrompt(prompt) {
  await dismissOverlays();
  await waitFor(composer, 45_000, "ChatGPT composer not found");
  await dismissOverlays();
  const el = composer();
  if (!el) throw new Error("ChatGPT composer not found");
  if (quotaHit()) throw quotaError();
  await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer);
  const deadline = Date.now() + 180_000;
  let stable = "";
  let hits = 0;
  while (Date.now() < deadline) {
    await sleep(1200);
    const text = lastAssistant();
    if (!text) continue;
    const json = extractJson(text);
    if (json) {
      if (json === stable) hits += 1;
      else {
        stable = json;
        hits = 1;
      }
      if (hits >= 2) return json;
    }
  }
  throw new Error("ChatGPT did not return JSON in time");
}

let running = false;
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type !== "ashlar-run") return;
  if (running) {
    sendResponse({ ok: false, error: "already running" });
    return true;
  }
  running = true;
  runPrompt(String(msg.prompt || ""))
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
