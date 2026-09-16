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
    await sleep(15);
  }
}

function splitAttachments(raw) {
  const files = [];
  const prompt = String(raw || "")
    .replace(/<<<ATTACH:([^>\n]+)>>>\r?\n([\s\S]*?)<<<END_ATTACH>>>/g, (_m, name, body) => {
      files.push({ name: String(name).trim(), body });
      return "";
    })
    .trim();
  return { prompt, files };
}

async function attachFiles(files) {
  if (!files.length) return false;
  const input =
    document.querySelector("form[data-type='unified-composer'] input[type='file']") ||
    document.querySelector("form input[type='file'][multiple]") ||
    document.querySelector("input[type='file']");
  if (!(input instanceof HTMLInputElement)) return false;
  const dt = new DataTransfer();
  for (const f of files) {
    dt.items.add(new File([f.body], f.name, { type: "text/plain" }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(400);
  const hay = `${document.body?.innerText || ""} ${[...document.querySelectorAll("[data-file-name], [title]")].map((n) => n.getAttribute("data-file-name") || n.getAttribute("title") || n.textContent || "").join(" ")}`;
  return files.every((f) => hay.includes(f.name));
}

async function fillComposer(el, text) {
  const parts = splitAttachments(text);
  let body = parts.prompt || text;
  if (parts.files.length) {
    const attached = await attachFiles(parts.files);
    if (!attached) {
      body = [parts.prompt, ...parts.files.map((f) => `--- ${f.name}\n${f.body}`)].filter(Boolean).join("\n\n");
    }
  }
  if (!el) throw new Error("composer not found");
  el.focus();
  await sleep(50);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      "value",
    );
    proto?.set?.call(el, body);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (composerHas(el, body)) return body;
  }
  await insertPrompt(el, body);
  if (composerHas(el, body)) return body;
  const dt = new DataTransfer();
  dt.setData("text/plain", body);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  await sleep(50);
  if (composerHas(el, body)) return body;
  try {
    await navigator.clipboard.writeText(body);
    document.execCommand("paste");
    await sleep(50);
  } catch {
    /* clipboard may be blocked */
  }
  if (!composerHas(el, body)) throw new Error("composer did not accept the prompt");
  return body;
}

function normalizePrompt(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function submissionKey() {
  const state = globalThis.__ashlarRunnerState;
  if (!state?.jobId || !state.runId) throw new Error("submission requires a persisted job/run binding");
  return `ashlar:submission:${state.jobId}:${state.runId}`;
}

function savedSubmission() {
  const text = sessionStorage.getItem(submissionKey());
  if (!text) return null;
  let record;
  try { record = JSON.parse(text); } catch { throw new Error("submission journal is unreadable; preserve the original tab"); }
  if (!record || !["prepared", "attempted", "sent"].includes(record.phase) ||
      typeof record.expected !== "string" || !record.expected || !Number.isSafeInteger(record.baseline) || record.baseline < 0) {
    throw new Error("submission journal is invalid; no prompt was sent again");
  }
  return record;
}

async function readSubmissionJournal() {
  for (;;) {
    try { return savedSubmission(); }
    catch {
      // Local storage corruption does not establish that the provider failed.
      step("submission_unknown");
      await sleep(250);
    }
  }
}

function saveSubmission(record) {
  // A failed write must prevent the external click, not silently lose its identity.
  sessionStorage.setItem(submissionKey(), JSON.stringify(record));
}

function userTurns() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')];
}

function step(stage) {
  if (typeof recordReviewStep === "function") recordReviewStep(stage);
}

function actionableSend(button) {
  if (!(button instanceof HTMLElement) || !button.isConnected || button.hidden ||
      button.disabled || button.getAttribute("aria-disabled") === "true") return false;
  const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
  if (!rect.width || !rect.height || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""}`;
  return !/stop|abort|중지|停止/i.test(label);
}

function findEligibleSendButton(selectors) {
  const root = typeof composer === "function" ? composer()?.closest("form") || document : document;
  for (const selector of selectors) for (const button of root.querySelectorAll(selector)) {
    if (actionableSend(button)) return button;
  }
  return null;
}

function submissionConfirmed(record) {
  const turns = userTurns();
  // Composer clearing and Stop alone are not proof that THIS request was accepted.
  const match = turns.slice(record.baseline).find(turn => normalizePrompt(turn.textContent || turn.innerText).includes(record.expected));
  if (!record.expected || !match) return false;
  record.phase = "sent";
  record.submittedUsers = turns.indexOf(match) + 1;
  record.messageId = match.getAttribute("data-message-id") || "";
  saveSubmission(record);
  step("prompt_submitted");
  return true;
}

async function clickSend(findSend, findComposer, expectedText) {
  let record = await readSubmissionJournal();
  if (!record) {
    const expected = normalizePrompt(expectedText || readComposer(findComposer()));
    if (!expected) throw new Error("cannot submit an empty review prompt");
    record = {phase: "prepared", expected, baseline: userTurns().length};
    saveSubmission(record);
    step("prompt_prepared");
  }
  for (;;) {
    if (record.phase === "sent" || submissionConfirmed(record)) return;
    if (typeof quotaHit === "function" && quotaHit()) {
      const error = new Error("provider usage limit before submission"); error.code = "quota"; throw error;
    }
    if (record.phase === "attempted") {
      // Delivery is ambiguous. Never automatically replay a possibly accepted prompt.
      step("send_unconfirmed");
    } else {
      step("send_waiting");
      const editor = findComposer(), button = findSend();
      const form = editor?.closest("form");
      const uploadBusy = [...(form?.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-state="uploading"]') || [])]
        .some(node => node.getClientRects().length > 0);
      const otherTurn = userTurns().length !== record.baseline;
      if (!uploadBusy && !otherTurn && normalizePrompt(readComposer(editor)) === record.expected && actionableSend(button) &&
          !(typeof stopButtonVisible === "function" && stopButtonVisible())) {
        record.phase = "attempted";
        saveSubmission(record); // durable intent BEFORE invoking the site's handler
        step("send_attempted");
        try { button.click(); } catch { /* Ambiguous click stays observable, never replayed. */ }
      }
    }
    // Cadence only: no upload, send acknowledgement, queue or model deadline.
    await sleep(250);
  }
}

async function resumeSubmission(findSend, findComposer, prompt) {
  const record = await readSubmissionJournal();
  if (record) return clickSend(findSend, findComposer, record.expected);
  // Legacy pages have no durable send journal. Observe, but never guess and re-send.
  const expected = normalizePrompt(splitAttachments(prompt).prompt);
  for (;;) {
    const turns = userTurns();
    if (turns.length && (!expected || normalizePrompt(turns.at(-1).textContent || turns.at(-1).innerText).includes(expected))) {
      step("legacy_observation"); return;
    }
    step("submission_unknown");
    if (typeof quotaHit === "function" && quotaHit()) {
      const error = new Error("provider usage limit"); error.code = "quota"; throw error;
    }
    await sleep(250);
  }
}

async function waitUntilComposer() {
  for (;;) {
    if (typeof quotaHit === "function" && quotaHit()) {
      const e = new Error("usage limit");
      e.code = "quota";
      throw e;
    }
    const el = composer();
    if (el) return el;
    await sleep(250);
  }
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
