function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wake on page changes even when background-tab timer cadence is throttled.
 * The timer is only a fallback observation cadence, never a failure deadline. */
function waitForPageChange(ms = 800) {
  if (typeof MutationObserver !== "function") return sleep(ms);
  return new Promise(resolve => {
    let timer;
    const finish = () => { observer.disconnect(); clearTimeout(timer); document.removeEventListener("visibilitychange", finish); resolve(); };
    const observer = new MutationObserver(finish);
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["data-message-id", "disabled", "aria-disabled", "aria-busy", "data-state", "data-streaming-response-status", "style", "class"]});
    document.addEventListener("visibilitychange", finish, {once: true});
    timer = setTimeout(finish, ms);
  });
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

/** An element's text for a LOSSLESS comparison (a fix prompt): a textarea's value; in a rich editor
 * every text node verbatim, each block (P, DIV, PRE, LI, ...) one line and each <br> a line break,
 * except the <br> that ends a block (the editor's placeholder that keeps an empty or newline-ended line
 * visible). innerText is not lossless there: it separates <p> blocks by a blank line (ChatGPT's
 * composer holds one <p> per line) and collapses spaces outside pre-wrap. */
function losslessText(el) {
  if (!el) return "";
  if ((typeof HTMLTextAreaElement === "function" && el instanceof HTMLTextAreaElement) ||
      (typeof HTMLInputElement === "function" && el instanceof HTMLInputElement)) return el.value || "";
  const read = (node, block) => {
    const parts = [];
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) parts.push({text: child.nodeValue || ""});
      else if (child.nodeType !== 1 || child.matches('script, style, [hidden], [aria-hidden="true"]')) continue;
      else if (child.tagName === "BR") parts.push({text: "\n", br: true});
      else {
        const inner = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE)$/.test(child.tagName);
        parts.push({text: read(child, inner), block: inner});
      }
    }
    if (block && parts.at(-1)?.br) parts.pop();
    return parts.map((part, i) => (i && (part.block || parts[i - 1].block) ? "\n" : "") + part.text).join("");
  };
  return read(el, true);
}

/** The form a FIX prompt is verified in, before Send (the composer draft) and after it (the sent turn):
 * its exact text, with only the provider's known transport changes undone. Line endings become LF (a
 * textarea and the provider store CRLF as LF), and whitespace at the two ends of the whole prompt is
 * dropped (the provider trims a sent message; a fix prompt starts and ends with Ashlar's instructions,
 * never with source). Every other character, whitespace included, must match: a fix prompt inlines
 * source whose spaces are content. A review prompt keeps normalizePrompt. */
function fixPromptForm(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

/** Whether the composer holds the fix prompt whose fixPromptForm is `exact`, read losslessly. */
function composerHoldsFix(el, exact) {
  return typeof exact === "string" && fixPromptForm(losslessText(el)) === exact;
}

/** A fix draft that matches its prompt only once whitespace is collapsed was changed by the editor:
 * typing it again yields the same, and sending it would deliver other source. The run ends before Send. */
function fixPromptAltered() {
  const error = new Error("the composer changed the fix prompt's whitespace; it was not sent");
  error.code = "prompt_altered";
  return error;
}

function composerHas(el, text) {
  const got = readComposer(el).replace(/\s+/g, " ").trim();
  const want = String(text || "").replace(/\s+/g, " ").trim();
  if (!want) return false;
  if (want.length <= 48) return got.includes(want);
  return got.includes(want.slice(0, 48)) && got.includes(want.slice(-40)) && got.length >= Math.floor(want.length * 0.85);
}

function selectComposerContents(el) {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) { el.select(); return; }
  const range = document.createRange(); range.selectNodeContents(el);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
}

async function insertPrompt(el, text) {
  selectComposerContents(el);
  document.execCommand("insertText", false, text);
  if (composerHas(el, text)) return;
  // Keep edits scoped to this input even if another UI element had the selection.
  selectComposerContents(el);
  document.execCommand("delete", false, null);
  for (let i = 0; i < text.length; i += 1500) {
    if (!el.isConnected) return; // caller re-finds a remounted composer
    document.execCommand("insertText", false, text.slice(i, i + 1500));
    await Promise.resolve();
  }
}

function splitAttachments(raw) {
  const source = String(raw || "");
  // One JSON line is a transport envelope, NOT model text. JSON escaping prevents
  // source files (including this parser) from terminating their own attachments.
  const frame = /(?:^|\r?\n)<<<ASHLAR_ATTACHMENTS_V2>>>\r?\n([^\r\n]*)\r?\n<<<END_ASHLAR_ATTACHMENTS_V2>>>[ \t\r\n]*$/.exec(source);
  if (frame) {
    let files;
    try { files = JSON.parse(frame[1]); } catch { throw new Error("invalid attachment envelope"); }
    if (!Array.isArray(files) || files.some(file => !file || typeof file.name !== "string" ||
        !file.name.trim() || /[\r\n]/.test(file.name) || typeof file.body !== "string")) {
      throw new Error("invalid attachment entries");
    }
    return {prompt: source.slice(0, frame.index).trim(), files};
  }
  if (/^<<<ASHLAR_ATTACHMENTS_V2>>>/m.test(source)) throw new Error("incomplete attachment envelope");
  // Read queued legacy prompts too. A quoted marker inside JS/TS is not a line
  // delimiter; the old unanchored lazy regex leaked entire snapshot tails.
  const files = [];
  const prompt = source.replace(/^<<<ATTACH:([^>\r\n]+)>>>\r?\n([\s\S]*?)^<<<END_ATTACH>>>[ \t]*(?=\r?$)/gm,
    (_m, name, body) => { files.push({name: name.trim(), body: body.replace(/\r?\n$/, "")}); return ""; }).trim();
  return {prompt, files};
}

/** The text to type and the files to upload for this run's prompt. A FIX run's prompt is delivered
 * VERBATIM, byte-exact: it inlines whole source files, so a line that looks like an attachment
 * envelope (a `<<<ASHLAR_ATTACHMENTS_V2>>>` sentinel, a legacy `<<<ATTACH:…>>>` block) is file
 * content, never transport, and nothing is uploaded or trimmed. Only a review prompt carries
 * attachments (splitAttachments). The run's kind is set by ashlar-run before the runner starts. */
function promptParts(raw) {
  return globalThis.__ashlarRunnerState?.kind === "fix" ? {prompt: String(raw ?? ""), files: []} : splitAttachments(raw);
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
  // Input filling does not depend on upload completion. Send has its own
  // named-chip + progress + enabled-control gate in the current composer form.
  return true;
}

async function fillComposer(el, text) {
  const parts = promptParts(text);
  let body = parts.prompt || (parts.files.length ? "" : text);
  const state = globalThis.__ashlarRunnerState;
  // A fix prompt must be held exactly (fixPromptForm, read losslessly); a review prompt normalized.
  const exact = state?.kind === "fix" ? fixPromptForm(body) : null;
  const holds = editor => exact === null ? normalizePrompt(readComposer(editor)) === normalizePrompt(body) : composerHoldsFix(editor, exact);
  // Held only once whitespace is collapsed: the editor changed the fix prompt (fixPromptAltered).
  const altered = editor => exact !== null && normalizePrompt(readComposer(editor)) === normalizePrompt(body);
  if (state) state.pendingAttachments = [];
  if (parts.files.length) {
    // The stop fence, in the same task as the upload: no file is staged in a composer the user opened
    // in the tab meanwhile (their next send would upload it).
    globalThis.throwIfStopped?.();
    const attached = await attachFiles(parts.files);
    if (attached) {
      if (state) state.pendingAttachments = parts.files.map(file => file.name);
    } else {
      // Only an unavailable upload input authorizes inline fallback. Slow chips
      // or an in-progress upload must never paste the whole snapshot again.
      body = [parts.prompt, ...parts.files.map(file => `--- ${file.name}\n${file.body}`)].filter(Boolean).join("\n\n");
    }
  }
  // Before any text is typed: the ownership verdict must recognise Ashlar's own prompt in the
  // composer even before clickSend journals it.
  if (state) state.pendingPrompt = normalizePrompt(body);
  for (;;) {
    // The stop fence lives with the runner state in json.js (absent: nothing can stop the run).
    globalThis.throwIfStopped?.();
    // Uploading can replace the editor. Never type into a cached detached node.
    el = typeof composer === "function" ? composer() : el;
    if (!el?.isConnected) { await waitForPageChange(250); continue; }
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
      proto?.set?.call(el, body);
      el.dispatchEvent(new Event("input", {bubbles: true}));
      el.dispatchEvent(new Event("change", {bubbles: true}));
    } else {
      await insertPrompt(el, body);
    }
    if (!el.isConnected) continue;
    // The send barrier checks the complete text too; do not accept a truncated
    // draft here using the historical 85-percent heuristic.
    if (holds(el)) return body;
    if (altered(el)) throw fixPromptAltered();
    const dt = new DataTransfer(); dt.setData("text/plain", body);
    selectComposerContents(el);
    el.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}));
    await Promise.resolve();
    if (!el.isConnected) continue;
    if (holds(el)) return body;
    if (altered(el)) throw fixPromptAltered();
    step("composer_waiting");
    await waitForPageChange(250);
  }
}

/** textContent drops <br>/<p> boundaries; innerText can omit collapsed text.
 * Read the message body, not attachment chips, copy controls or hidden UI. */
function messagePromptText(turn) {
  const root = turn?.querySelector?.('[data-testid="collapsible-user-message-content"]') || turn;
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.matches('button, svg, script, style, [hidden], [aria-hidden="true"], [data-file-name], [role="group"][aria-label]')) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(walk).join("");
    return /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE|TR)$/.test(node.tagName) ? `\n${text}\n` : text;
  };
  return root?.childNodes ? walk(root).trim() : root?.textContent || root?.innerText || "";
}

function renderedControl(el) {
  if (!el?.isConnected) return false;
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  }
  const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
}

/** The file-chip shapes a composer renders for a staged attachment: a named group, a data-file-name
 * tile, or an element that names its file only in its title. ONE list (fileChips) for the send
 * barrier (attachmentsReady: the run's own files are there) and the release verdict (json.js
 * composerStagedFiles: a file there that is not the run's is the user's draft), so neither sees a
 * chip the other misses (Ashlar 4101623051). Functions, not top-level consts: composer.js is
 * re-injected into a page that already ran it. */
function fileChipSelector() {
  return '[role="group"][aria-label], [data-file-name], [title]';
}
/** The composer's own controls (the send and stop buttons, a voice button, a model or tool menu, an
 * attach label, a link). The title on one of them is its tooltip, never a file's name. */
function composerControlSelector() {
  const roles = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "checkbox", "radio", "combobox",
    "option", "tab", "textbox", "slider"].map(role => `[role="${role}"]`);
  return ["button", "a[href]", "input", "select", "textarea", "label", "summary", "[aria-haspopup]", ...roles,
    "#composer-submit-button", '[data-testid="send-button"]', '[data-testid="stop-button"]'].join(", ");
}
/** The file chips in a composer form: every element in a fileChipSelector shape, except a control
 * that is a chip only by its title (its tooltip: "Send prompt", "Start voice mode"). A named group or
 * a data-file-name tile is a chip whatever element renders it. The barrier and the verdict both read
 * this list, so neither takes a control's tooltip for a file (Ashlar, review of 5af999fd). */
function fileChips(form) {
  return [...form.querySelectorAll(fileChipSelector())]
    .filter(chip => chip.matches('[role="group"][aria-label], [data-file-name]') || !chip.matches(composerControlSelector()));
}
/** Every name a file chip gives its file, in its shapes' order (data-file-name, aria-label, title). */
function fileChipNames(chip) {
  return ["data-file-name", "aria-label", "title"].map(name => chip.getAttribute(name)).filter(name => name !== null);
}

function attachmentsReady(form, names = []) {
  if (!form) return names.length === 0;
  const progress = form.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-state="uploading"], [class*="animate-spin"]');
  if ([...progress].some(renderedControl)) return false;
  const chips = fileChips(form).filter(renderedControl);
  return names.every(name => chips.some(chip => fileChipNames(chip).includes(name)));
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
    try {
      const state = globalThis.__ashlarRunnerState;
      if (state?.confirmedSubmission?.key === submissionKey()) {
        retrySubmissionPersistence();
        return state.confirmedSubmission.record;
      }
      const record = savedSubmission();
      if (record?.phase === "sent" && state) {
        state.confirmedSubmission = {key: submissionKey(), record};
        state.submissionPersistencePending = false;
      }
      return record;
    }
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

/** After provider acceptance, bookkeeping failure must not abandon collection.
 * The durable attempted record already fences replay; keep the confirmed identity
 * in this page while retrying only its journal write, never the send operation.
 */
function retrySubmissionPersistence() {
  const state = globalThis.__ashlarRunnerState;
  if (!state?.submissionPersistencePending) return true;
  const confirmed = state.confirmedSubmission;
  if (!confirmed || confirmed.key !== submissionKey()) return false;
  try {
    saveSubmission(confirmed.record);
    state.submissionPersistencePending = false;
    step("submission_persisted");
    return true;
  } catch {
    step("submission_persistence_pending");
    return false;
  }
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
  if (!renderedControl(button)) return false;
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

/** The identity of the conversation this page shows: its URL without the fragment (the same rule
 * as json.js conversationIdentity). What is recorded from it is later compared with the location by
 * samePage (origin and path: json.js fixConversationHolds, tabOwnership; stillShowsConversation
 * below), never by exact equality. */
function shownConversation() {
  const href = globalThis.location?.href;
  return typeof href === "string" ? href.split("#")[0] : "";
}

/** Whether the page still shows `conversation` (json.js samePage when loaded: origin and path, the
 * query and fragment are not the page; else the exact identity). */
function stillShowsConversation(conversation) {
  return typeof samePage === "function" ? samePage(conversation, globalThis.location?.href) : conversation === shownConversation();
}

function submissionConfirmed(record) {
  const turns = userTurns();
  // Composer clearing and Stop alone are not proof that THIS request was accepted.
  const match = turns.slice(record.baseline).find(turn => normalizePrompt(messagePromptText(turn)).includes(record.expected));
  if (!record.expected || !match) return false;
  record.phase = "sent";
  record.submittedUsers = turns.indexOf(match) + 1;
  record.messageId = match.getAttribute("data-message-id") || "";
  const state = globalThis.__ashlarRunnerState;
  // A run's conversation is a fact of THIS moment: recorded once, here, and never later (every
  // later decision compares the location with it). Only a send this page instance clicked,
  // confirmed while the page still shows the conversation it was clicked in, establishes it. A
  // confirmation seen only after a reload (the click belonged to an earlier page) or under another
  // location (an in-page move can leave the old DOM rendering the sent turn) proves the send, not
  // which conversation holds it: no identity is recorded (a fix is then `identity:"unestablished"`
  // in json.js: never harvested, never closed). A FIX always records it here. A REVIEW records it
  // here only when it was sent on a page that names a conversation, with its exact prompt (the rule
  // its release verdict holds a recorded conversation to): a review sent on a new chat has no
  // conversation yet and pins where the provider puts it (json.js pinNewChatReview, #82).
  const attempt = state?.sendAttempt;
  const fix = state?.kind === "fix";
  const reviewNamed = !fix && typeof namesNoConversation === "function" && Boolean(attempt?.conversation) &&
    !namesNoConversation(attempt.conversation) && normalizePrompt(messagePromptText(match)) === record.expected;
  if ((fix || reviewNamed) && !record.conversation && attempt?.key === submissionKey() && attempt.conversation &&
      stillShowsConversation(attempt.conversation)) {
    record.conversation = attempt.conversation;
  }
  state.confirmedSubmission = {key: submissionKey(), record};
  state.submissionPersistencePending = true;
  step("prompt_submitted");
  retrySubmissionPersistence();
  return true;
}

async function clickSend(findSend, findComposer, expectedText) {
  let record = await readSubmissionJournal();
  // A fix journal also carries its prompt's lossless form (`exact`, fixPromptForm): the draft is sent
  // only while it holds exactly that, and the sent turn is later proven against it (json.js
  // journaledTurnIntegrity). The whitespace-normalized `expected` only locates the sent turn.
  const fix = globalThis.__ashlarRunnerState?.kind === "fix";
  if (!record) {
    const expected = normalizePrompt(expectedText || readComposer(findComposer()));
    if (!expected) throw new Error("cannot submit an empty review prompt");
    record = {phase: "prepared", expected, ...(fix ? {exact: fixPromptForm(expectedText)} : {}),
      baseline: userTurns().length, attachments: [...(globalThis.__ashlarRunnerState?.pendingAttachments || [])]};
    saveSubmission(record);
    step("prompt_prepared");
  }
  for (;;) {
    if (record.phase === "sent" || submissionConfirmed(record)) return;
    // After the confirmation check, so an accepted send is still journaled as sent; before any
    // click, so a stopped run never submits its prompt.
    globalThis.throwIfStopped?.();
    if (typeof quotaHit === "function" && quotaHit()) {
      const error = new Error("provider usage limit before submission"); error.code = "quota"; throw error;
    }
    if (record.phase === "attempted") {
      // Delivery is ambiguous. Never automatically replay a possibly accepted prompt.
      step("send_unconfirmed");
    } else {
      const editor = findComposer(), button = findSend();
      const form = editor?.closest("form");
      const uploadBusy = !attachmentsReady(form, record.attachments || []);
      step(uploadBusy ? "attachments_waiting" : "send_waiting");
      const otherTurn = userTurns().length !== record.baseline;
      const drafted = normalizePrompt(readComposer(editor)) === record.expected;
      // A fix draft that is the prompt only once whitespace is collapsed (or a fix journal with no
      // lossless form to check it against) is never sent.
      if (fix && drafted && !composerHoldsFix(editor, record.exact)) throw fixPromptAltered();
      if (!uploadBusy && !otherTurn && drafted && actionableSend(button) &&
          !(typeof stopButtonVisible === "function" && stopButtonVisible())) {
        record.phase = "attempted";
        saveSubmission(record); // durable intent BEFORE invoking the site's handler
        // In memory only: the conversation this page instance clicked in (submissionConfirmed
        // records it once the send is proven, and only if the page still shows it then). The
        // fresh-page fence (json.js throwIfStopped) ends here: the provider moves the page after a send.
        const runner = globalThis.__ashlarRunnerState;
        if (runner) { runner.sendAttempt = {key: submissionKey(), conversation: shownConversation()}; runner.freshPage = undefined; }
        step("send_attempted");
        try { button.click(); } catch { /* Ambiguous click stays observable, never replayed. */ }
      }
    }
    // Cadence only: no upload, send acknowledgement, queue or model deadline.
    await waitForPageChange(250);
  }
}

async function resumeSubmission(findSend, findComposer, prompt) {
  const record = await readSubmissionJournal();
  if (record) return clickSend(findSend, findComposer, record.expected);
  // Legacy pages have no durable send journal. Observe, but never guess and re-send.
  const expected = normalizePrompt(promptParts(prompt).prompt);
  for (;;) {
    globalThis.throwIfStopped?.();
    const turns = userTurns();
    if (turns.length && (!expected || normalizePrompt(messagePromptText(turns.at(-1))).includes(expected))) {
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
  // Backstop, not a generation timeout: guards a page that never renders a composer (e.g. a stale
  // model URL or a logged-out landing) so the runner fails cleanly and releases the lane instead of
  // waiting forever. Generation itself stays unbounded elsewhere. Local, not a top-level const: the
  // worker re-injects this file into a page that already ran it, and a redeclared global lexical
  // binding aborts the whole script (leaving every older definition in place).
  const COMPOSER_DEADLINE_MS = 3 * 60 * 60 * 1000; // 3h
  const deadline = Date.now() + COMPOSER_DEADLINE_MS;
  for (;;) {
    globalThis.throwIfStopped?.();
    if (typeof quotaHit === "function" && quotaHit()) {
      const e = new Error("usage limit");
      e.code = "quota";
      throw e;
    }
    const el = composer();
    if (el) return el;
    if (Date.now() >= deadline) {
      const e = new Error("composer never rendered within deadline");
      e.code = "composer_timeout";
      throw e;
    }
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
