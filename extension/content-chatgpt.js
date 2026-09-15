function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function composer() {
  return (
    document.querySelector("#prompt-textarea") ||
    document.querySelector('[data-testid="prompt-textarea"]') ||
    document.querySelector("div.ProseMirror[contenteditable='true']") ||
    document.querySelector('[contenteditable="true"]')
  );
}

function sendButton() {
  return (
    document.querySelector('[data-testid="send-button"]') ||
    document.querySelector('button[aria-label="Send prompt"]') ||
    document.querySelector('button[aria-label="Send"]')
  );
}

function quotaHit() {
  const t = (document.body?.innerText || "").slice(0, 16_000).toLowerCase();
  return /you've reached (the |your )?(limit|usage)|hit the (free plan )?limit|usage limit|rate limit|too many requests|try again later|limit resets|out of (credits|quota)|upgrade to (chatgpt|plus)|quota/.test(
    t,
  );
}

function quotaError() {
  const e = new Error("ChatGPT usage limit");
  e.code = "quota";
  return e;
}

async function setComposer(text) {
  const el = composer();
  if (!el) throw new Error("ChatGPT composer not found");
  el.focus();
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
    proto?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    if (!el.innerText.includes(text.slice(0, 40))) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
  }
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

async function waitComposer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (composer()) return;
    await sleep(300);
  }
  throw new Error("ChatGPT composer not found");
}

async function runPrompt(prompt) {
  await waitComposer();
  if (quotaHit()) throw quotaError();
  if (lastAssistant()) {
    throw new Error("ChatGPT tab was not a fresh session");
  }
  await setComposer(prompt);
  await sleep(200);
  const btn = sendButton();
  if (btn && !btn.disabled) btn.click();
  else {
    const el = composer();
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  const deadline = Date.now() + 180_000;
  let stable = "";
  let hits = 0;
  while (Date.now() < deadline) {
    await sleep(1200);
    if (quotaHit()) throw quotaError();
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
