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
  return waitFor(composer, 45_000, "Grok composer not found");
}

function lastAssistant() {
  const nodes = [...document.querySelectorAll("[data-message-author-role='assistant']")];
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

async function runPrompt(prompt, reasoning) {
  await dismissOverlays();
  const el = await startFresh();
  await dismissOverlays();
  await selectReasoning("grok", reasoning || "heavy");
  await dismissOverlays();
  if (quotaHit()) throw quotaError();
  await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer);
  const deadline = Date.now() + 300_000;
  let stable = "";
  let hits = 0;
  while (Date.now() < deadline) {
    await sleep(1200);
    const text = lastAssistant();
    if (!text) continue;
    const json = extractJson(text);
    if (!json || findingsJsonTooThin(json)) continue;
    if (json === stable) hits += 1;
    else {
      stable = json;
      hits = 1;
    }
    if (hits >= 2) return json;
  }
  throw new Error("Grok did not return JSON in time");
}

let running = false;
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type !== "ashlar-run") return;
  if (running) {
    sendResponse({ ok: false, error: "already running" });
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
