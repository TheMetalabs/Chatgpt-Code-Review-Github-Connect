function composer() {
  const selectors = [
    "textarea",
    '[contenteditable="true"][role="textbox"]',
    "div.ProseMirror[contenteditable='true']",
    '[contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (visible(el)) return el;
  }
  return null;
}

function sendButton() {
  return (
    document.querySelector('button[aria-label="Submit"]') ||
    document.querySelector('button[aria-label="Send"]') ||
    document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('button[type="submit"]')
  );
}

function quotaError() {
  const e = new Error("Grok usage limit");
  e.code = "quota";
  return e;
}

function clickLabel(re) {
  for (const el of document.querySelectorAll("button, a, [role='button']")) {
    const t = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.trim();
    if (re.test(t)) {
      el.click();
      return true;
    }
  }
  return false;
}

async function startFresh() {
  clickLabel(/temporary|private chat|incognito|ghost/i);
  await sleep(400);
  clickLabel(/new chat|new conversation/i);
  return waitUntilComposer();
}

async function runPrompt(prompt, reasoning) {
  const existing = harvestJson({ allowThin: true });
  if (existing && chatGenerationFinished()) return existing;
  if (assistantCorpus().length && !composer()) return waitUntilReviewOrQuota("Grok");
  await dismissOverlays();
  const el = await startFresh();
  await dismissOverlays();
  await selectReasoning("grok", reasoning || "heavy");
  await dismissOverlays();
  if (quotaHit()) throw quotaError();
  await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer);
  return waitUntilReviewOrQuota("Grok");
}

let running = false;
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "ashlar-harvest") {
    const raw = harvestJson({ allowThin: chatGenerationFinished() });
    sendResponse(raw ? { ok: true, raw } : { ok: false, error: "no json" });
    return true;
  }
  if (msg?.type !== "ashlar-run") return;
  if (running) {
    const raw = harvestJson({ allowThin: chatGenerationFinished() });
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
        code: e && e.code === "quota" ? "quota" : e && e.code === "empty" ? "empty" : undefined,
      }),
    )
    .finally(() => {
      running = false;
    });
  return true;
});
