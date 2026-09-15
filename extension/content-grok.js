function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function composer() {
  return (
    document.querySelector("textarea") ||
    document.querySelector('[contenteditable="true"]') ||
    document.querySelector("div.ProseMirror")
  );
}

function sendButton() {
  return (
    document.querySelector('button[aria-label="Submit"]') ||
    document.querySelector('button[aria-label="Send"]') ||
    document.querySelector('button[type="submit"]')
  );
}

function quotaHit() {
  const t = (document.body?.innerText || "").slice(0, 16_000).toLowerCase();
  return /you've reached (the |your )?(limit|usage)|hit the (free plan )?limit|usage limit|rate limit|too many requests|try again later|limit resets|out of (credits|quota)|come back later|temporarily (unavailable|limited)|quota/.test(
    t,
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
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (composer()) return;
    await sleep(300);
  }
  throw new Error("Grok composer not found");
}

async function setComposer(text) {
  const el = composer();
  if (!el) throw new Error("Grok composer not found");
  el.focus();
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
    proto?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  }
}

function lastAssistant() {
  const nodes = [
    ...document.querySelectorAll("[data-message-author-role='assistant'], [data-message-id], main article"),
  ];
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
  await startFresh();
  if (quotaHit()) throw quotaError();
  await setComposer(prompt);
  await sleep(200);
  const btn = sendButton();
  if (btn && !btn.disabled) btn.click();
  else composer()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
