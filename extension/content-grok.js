/** Grok's query bar is form[data-composer]. Returning users get a lazy tiptap editor; the first paint
 * and the fallback are a textarea ("Ask Grok anything" / localized). Prefer the one inside the form
 * so a transcript contenteditable is never typed into. */
function composer() {
  const form = document.querySelector('form[data-composer]');
  const selectors = [
    "textarea",
    '[contenteditable="true"][role="textbox"]',
    "div.ProseMirror[contenteditable='true']",
    ".tiptap[contenteditable='true']",
    '[contenteditable="true"]',
  ];
  const roots = form ? [form, document] : [document];
  for (const root of roots) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (visible(el)) return el;
    }
  }
  return null;
}

/** Submit is button[data-testid="chat-submit"]. Its aria-label is localized ("Submit" / "제출"),
 * and while a response streams the button is not in the DOM (the abort control replaces it). */
function sendButton() {
  return findEligibleSendButton([
    'button[data-testid="chat-submit"]',
    'button[aria-label="Submit"]',
    'button[aria-label="제출"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="보내"]',
    'button[type="submit"]',
  ]);
}

/** Logged out only with no composer and no model pill, plus a visible sign-in control. A false
 * positive pauses the grok lane; a miss ends as presend_stalled instead, which is recoverable. */
function grokLoggedOut() {
  if (document.querySelector('form[data-composer], #model-select-trigger')) return false;
  const controls = [...document.querySelectorAll("a[href], button, [role='button']")].filter(el => typeof visible === "function" ? visible(el) : el);
  const hrefOf = el => el.getAttribute("href") || "";
  if (controls.some(el => /accounts\.x\.com|x\.com\/i\/flow\/login|\/sign-in|\/login/i.test(hrefOf(el)))) return true;
  const label = el => (el.textContent || "").replace(/\s+/g, " ").trim();
  const exact = new Set(["Log in", "Sign in", "Sign up", "로그인", "가입"]);
  return controls.some(el => exact.has(label(el)));
}

function throwIfLoggedOut() {
  if (!grokLoggedOut()) return;
  const e = new Error("Grok is logged out in this Chrome profile; log in and retry (nothing was typed or sent)");
  e.code = "logged_out";
  throw e;
}

function quotaError() {
  const e = new Error("Grok usage limit");
  e.code = "quota";
  return e;
}

/** Click a control whose accessible name is exactly one of `labels` (case-insensitive). A substring
 * match would hit "Unavailable in Private Chats" while looking for a private chat. */
function clickExact(labels) {
  const want = new Set(labels.map(label => label.toLowerCase()));
  for (const el of document.querySelectorAll("button, a, [role='button']")) {
    if (typeof visible === "function" && !visible(el)) continue;
    const aria = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!want.has(aria) && !want.has(text)) continue;
    el.click();
    return true;
  }
  return false;
}

/** Top-bar personal private chat (the incognito pill labeled 개인 / Private). The word is the same
 * in both states. Off links to /c#private; on links to /c and shows the filled hat (no opacity-0).
 * Clicking the on state leaves private chat, so that control is never used to "start fresh". */
function grokPrivateToggle() {
  const icon = document.querySelector("[data-testid='pi-incognito'], [data-testid='pi-incognito-fill']");
  const link = icon?.closest?.("a");
  if (!link) return null;
  const box = link.getBoundingClientRect?.();
  if (box && (box.width < 24 || box.height < 24)) return null;
  return link;
}

function grokPrivateOn() {
  const link = grokPrivateToggle();
  const fill = link?.querySelector?.("[data-testid='pi-incognito-fill']");
  if (!fill) return false;
  return !/\bopacity-0\b/.test(fill.className || "");
}

/** A review tab must be the top-bar private chat, the way ChatGPT opens ?temporary-chat=true.
 * Home with a composer is not enough: a new https://grok.com/ tab starts as a normal chat and
 * would land in the sidebar. One click only — a second click turns private mode off. A normal
 * "New Chat" is not a fallback; that control clears incognito. Resolves only once private mode is
 * confirmed; a missing or ineffective control rejects before anything is staged, typed, or sent.
 * The stop fence runs before every click, so a stopped or taken-over run never touches the tab. */
async function startFresh(deadline) {
  const end = typeof deadline === "number" ? deadline : Date.now() + 60_000;
  const lookUntil = Math.min(end, Date.now() + 3_000);
  let tried = false;
  for (;;) {
    globalThis.throwIfStopped?.();
    throwIfLoggedOut();
    if (grokPrivateOn()) break;
    if (!tried) {
      const enter = grokPrivateToggle();
      const href = enter?.getAttribute("href") || "";
      globalThis.throwIfStopped?.();
      if (enter && href.includes("#private")) {
        enter.click();
        tried = true;
      } else if (clickExact([
        "Create New Private Chat", "New Incognito Chat", "Switch to Private Chat",
        "새 비공개 채팅", "개인 비공개 채팅", "비공개 채팅으로 전환", "비공개 채팅",
      ])) {
        tried = true;
      }
    }
    if (!tried && Date.now() >= lookUntil) throw presendStalled("private_chat");
    if (Date.now() >= end) throw presendStalled("private_chat");
    await sleep(200);
  }
  return waitUntilComposer(end, throwIfLoggedOut);
}

async function runPrompt(prompt, reasoning, resume = false) {
  // A restarted worker must observe the existing request, never submit it again.
  if (resume) {
    await resumeSubmission(sendButton, composer, prompt);
    return waitUntilReviewOrQuota("Grok");
  }
  const el = await preparePresend("grok", reasoning || "expert", deadline => startFresh(deadline), throwIfLoggedOut);
  if (!el) throw new Error("Grok composer not found");
  if (quotaHit()) throw quotaError();
  step("attachments_preparing");
  const submittedText = await fillComposer(el, prompt);
  await dismissOverlays();
  await clickSend(sendButton, composer, submittedText);
  return waitUntilReviewOrQuota("Grok");
}

installReviewRunner("Grok", (...args) => runPrompt(...args));
