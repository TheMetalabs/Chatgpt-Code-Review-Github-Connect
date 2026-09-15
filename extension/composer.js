function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function visible(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 40 && r.height > 16;
}

function readComposer(el) {
  if (!el) return "";
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || "";
  return el.innerText || el.textContent || "";
}

function composerHas(el, text) {
  const got = readComposer(el).replace(/\s+/g, " ").trim();
  const want = String(text || "").replace(/\s+/g, " ").trim();
  if (!want) return false;
  if (want.length <= 48) return got.includes(want);
  return got.includes(want.slice(0, 48)) && got.includes(want.slice(-40)) && got.length >= Math.floor(want.length * 0.85);
}

async function insertPrompt(el, text) {
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);
  if (composerHas(el, text)) return;
  const chunk = 1500;
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  for (let i = 0; i < text.length; i += chunk) {
    document.execCommand("insertText", false, text.slice(i, i + chunk));
  }
}

async function fillComposer(el, text) {
  if (!el) throw new Error("composer not found");
  el.focus();
  await sleep(50);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      "value",
    );
    proto?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (composerHas(el, text)) return;
  }
  await insertPrompt(el, text);
  if (composerHas(el, text)) return;
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(50);
  if (composerHas(el, text)) return;
  try {
    await navigator.clipboard.writeText(text);
    document.execCommand("paste");
    await sleep(50);
  } catch {
    /* clipboard may be blocked */
  }
  if (!composerHas(el, text)) throw new Error("composer did not accept the prompt");
}

async function clickSend(findSend, findComposer) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const btn = findSend();
    const disabled = !btn || btn.disabled || btn.getAttribute("aria-disabled") === "true";
    if (btn && !disabled) {
      const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("data-testid") || ""}`.toLowerCase();
      if (/stop|abort/.test(label)) {
        await sleep(200);
        continue;
      }
      btn.click();
      return;
    }
    await sleep(200);
  }
  const el = findComposer();
  el?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }),
  );
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const el = fn();
    if (el) return el;
    await sleep(250);
  }
  throw new Error(label);
}
