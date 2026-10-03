// Grok page only (manifest, background.js contentFiles): loaded after the shared files and before
// content-grok.js. Function declarations replace the ChatGPT ones for this page. The job's site
// decides that by which scripts load. Nothing here runs on chatgpt.com. Re-injectable: no top-level
// let/const. Stream memory is the submission journal, written by noteSawStream from the poll
// (json.js pollBoundResponse). The checks below only read it.

function grokTestId(role) {
  return role === "user" ? "user-message" : "assistant-message";
}

function grokTurn(el) {
  const testid = el?.getAttribute?.("data-testid");
  return testid === "user-message" || testid === "assistant-message";
}

function turnSelector(role) {
  return (role ? [role] : ["user", "assistant"]).map(r => `[data-testid="${grokTestId(r)}"]`).join(", ");
}

function turnNodeSelector() {
  return "[data-testid='user-message'], [data-testid='assistant-message']";
}

function turnAreaSelector(role) {
  return role ? `[data-testid="${grokTestId(role)}"]` : "[data-testid='user-message'], [data-testid='assistant-message']";
}

function turnRole(el) {
  if (!grokTurn(el)) return "";
  return el.getAttribute("data-testid") === "user-message" ? "user" : "assistant";
}

/** A response id is id="response-<id>" on the bubble or, on grok.com 2026-09-30, on the wrapper
 * that also holds the action row. */
function turnMessageId(el) {
  if (!grokTurn(el)) return "";
  const from = node => {
    const value = node?.id || "";
    return value.startsWith("response-") ? value.slice("response-".length) : "";
  };
  return from(el) || from(el.querySelector?.("[id^='response-']")) || from(el.closest?.("[id^='response-']")) || "";
}

/** Grok's composer form holds one attachment list. Its list items are the file chips. The editor,
 * the model picker and the streaming strip are siblings of that list, never inside it. */
function grokComposerForm(form) {
  return Boolean(form?.matches?.("form[data-composer]"));
}
function grokAttachmentItems(form) {
  return [...(form?.querySelectorAll?.('[role="list"] > [role="listitem"]') || [])];
}
function grokAttachmentItem(el) {
  return Boolean(el?.matches?.('[role="listitem"]') && el.parentElement?.matches?.('[role="list"]') && el.closest?.("form[data-composer]"));
}
/** span.truncate, else the first text leaf of the first button. Truncation is visual only. */
function grokAttachmentName(item) {
  const norm = el => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const label = item?.querySelector?.("span.truncate");
  if (norm(label)) return norm(label);
  const leaf = [...(item?.querySelector?.("button")?.querySelectorAll("*") || [])].find(el => !el.children.length && norm(el));
  return norm(leaf);
}

function fileChips(form) {
  return grokAttachmentItems(form);
}
function fileChipNames(chip) {
  const name = grokAttachmentItem(chip) ? grokAttachmentName(chip) : "";
  return name ? [name] : [];
}
/** Structure only: a pulsed chip whose upload has no metadata yet. The chip's text is its file name
 * (a file may be called "uploading.md"), never a status. */
function chipUploading(chip) {
  if (!grokAttachmentItem(chip)) return false;
  return Boolean(chip.matches('[class*="animate-pulse"]') || chip.querySelector('[class*="animate-pulse"]'));
}
function chipShownNames(chip) {
  return fileChipNames(chip);
}
function chipShowsFile(chip, name) {
  if (!grokAttachmentItem(chip)) return false;
  const norm = v => String(v ?? "").replace(/\s+/g, " ").trim().normalize("NFC");
  return Boolean(norm(name)) && norm(grokAttachmentName(chip)) === norm(name);
}
function stagedChips(form) {
  return grokAttachmentItems(form).filter(chip => typeof renderedControl === "function" ? renderedControl(chip) : chip);
}
function chipCard(chip) {
  return chip;
}

/** Foreign chips still in the composer. The attachment list is the form's, so it is read while the
 * editor is unmounted. A chip is the list item itself: no wrapper test. */
function composerStagedFiles(state, submission) {
  const form = globalThis.document?.querySelector?.("form[data-composer]");
  if (!form) return [];
  const own = new Set(submission?.phase === "sent" ? [] : [...(Array.isArray(submission?.attachments) ? submission.attachments : []),
    ...(Array.isArray(state?.pendingAttachments) ? state.pendingAttachments : [])]);
  const shown = chip => (typeof renderedControl === "function" ? renderedControl(chip) : true);
  const named = fileChips(form)
    .filter(shown)
    .map(chip => ({chip, names: fileChipNames(chip).filter(name => name.trim())}))
    .filter(({names}) => names.length);
  return named.filter(({chip}) => !named.some(outer => outer.chip !== chip && outer.chip.contains(chip)))
    .filter(({chip, names}) => ![...own].some(name => chipShowsFile(chip, name) || names.includes(name)))
    .map(({names}) => names[0]);
}

function codeBlockEls(turn) {
  if (!turn?.querySelectorAll) return [];
  return [...turn.querySelectorAll("pre, .chat-code-block")].filter(el => el.tagName === "PRE" || !el.querySelector("pre"));
}
function codeBlockBox(pre, turn) {
  const box = pre.closest?.(".chat-code-block");
  return box && turn?.contains?.(box) ? box : pre;
}

function grokAttachmentListSelector() {
  return 'form[data-composer] [role="list"]';
}
function quotaCandidateText(el) {
  const list = grokAttachmentListSelector();
  if (!el?.querySelector?.(list)) return (el?.textContent || "").trim();
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(list)) text += node.nodeValue;
  }
  return text.trim();
}
function quotaHit() {
  const notices = document.querySelectorAll(
    '[role="alert"], [role="status"], [role="dialog"], [data-testid*="quota" i], [class*="toast" i], [class*="banner" i], [class*="notice" i]',
  );
  for (const el of notices) {
    if (!elVisible(el) || el.closest(`${turnAreaSelector("user")}, .markdown, pre, code, ${grokAttachmentListSelector()}`)) continue;
    const text = quotaCandidateText(el);
    if (text.length <= 400 && quotaHitText(text)) return true;
  }
  for (const el of document.querySelectorAll("span, button, [class*='card']")) {
    if (!elVisible(el) || el.closest(`${turnAreaSelector()}, pre, code, ${grokAttachmentListSelector()}`)) continue;
    const text = quotaCandidateText(el);
    if (text.length <= 240 && quotaHitText(text)) return true;
  }
  return false;
}

/** The user turn a stream belongs to: its response id, else n:<count>. Read-only. */
function grokStreamKey() {
  if (typeof userTurnEls !== "function") return "";
  const users = userTurnEls();
  const last = users[users.length - 1];
  const id = last && typeof turnMessageId === "function" ? turnMessageId(last) : "";
  return id || `n:${users.length}`;
}

/** Poll write. One submission is one send. An id-less mark (n:N) is upgraded to that turn's id once
 * the page assigns one and the user-turn count is still N. A check never calls this. */
function noteSawStream(submission, poll) {
  if (!submission || !(poll?.stop || poll?.streaming)) return;
  const key = grokStreamKey();
  if (!key || key === "n:0") return;
  const saved = submission.sawStreamKey;
  if (submission.sawStream && saved && !String(saved).startsWith("n:")) return;
  if (submission.sawStream && saved === key) return;
  if (submission.sawStream && String(saved).startsWith("n:") && String(key).startsWith("n:")) return;
  const users = typeof userTurnEls === "function" ? userTurnEls().length : 0;
  if (submission.sawStream && String(saved).startsWith("n:") && !String(key).startsWith("n:") && users === Number(String(saved).slice(2))) {
    submission.sawStreamKey = key;
  } else if (submission.sawStream) {
    return;
  } else {
    submission.sawStream = true;
    submission.sawStreamKey = key;
  }
  try { saveSubmission(submission); } catch { /* the in-memory record still holds the mark */ }
}

/** Reads the journal. An n:N mark still matches after that same counted turn gains an id. A later
 * user turn does not. The node itself is not stored. */
function grokSawCurrentStream(root) {
  let record;
  try {
    const confirmed = globalThis.__ashlarRunnerState?.confirmedSubmission;
    record = confirmed?.key === submissionKey() ? confirmed.record : savedSubmission();
  } catch { return false; }
  if (record?.phase !== "sent" || record.sawStream !== true) return false;
  const users = typeof userTurnEls === "function" ? userTurnEls() : [];
  const lastUser = users[users.length - 1];
  const shown = lastUser ? (typeof messagePromptText === "function" ? messagePromptText(lastUser) : lastUser.textContent || lastUser.innerText) : "";
  if (!lastUser || !record.expected || (typeof reviewTurnHolds === "function" ? !reviewTurnHolds(shown, record.expected) : !normalizePrompt(shown).includes(record.expected))) return false;
  const saved = record.sawStreamKey;
  if (!saved) return false;
  const current = grokStreamKey();
  if (saved === current) return true;
  if (String(saved).startsWith("n:") && current && !String(current).startsWith("n:")) {
    const users = typeof userTurnEls === "function" ? userTurnEls() : [];
    return users.length === Number(saved.slice(2));
  }
  return false;
}

/** The attachment list and the draft editor are never status. A file named "Generating" or "Stop"
 * and a prompt line are content there. */
function grokNotStatusArea(el) {
  return Boolean(el?.closest?.('[role="list"], [contenteditable]:not([contenteditable="false"]), textarea, input'));
}
function grokStatusStrip(form) {
  for (const status of form?.querySelectorAll?.('[role="status"]') || []) {
    if (grokNotStatusArea(status) || !elVisible(status)) continue;
    if (/^generating\b/i.test((status.textContent || "").replace(/\s+/g, " ").trim())) return status;
  }
  return null;
}
function grokStopControl(form) {
  for (const el of form?.querySelectorAll?.("button, [role='button']") || []) {
    const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!/^(?:stop model response|모델 응답 중지)$/i.test(label) || grokNotStatusArea(el) || !elVisible(el)) continue;
    return el;
  }
  return null;
}
function grokComposerIn(root) {
  if (!root?.querySelector) return null;
  return root.querySelector("form[data-composer]") || (root.matches?.("form[data-composer]") ? root : null);
}
/** Check only. Does not record the stream. */
function grokStreamVisible(root = document) {
  const form = grokComposerIn(root);
  return Boolean(form && (grokStatusStrip(form) || grokStopControl(form)));
}
function stopButtonVisible(root = document) {
  const form = grokComposerIn(root);
  if (!form) return false;
  if (grokStatusStrip(form) || grokStopControl(form)) return true;
  for (const stop of form.querySelectorAll('[data-testid="stop-button"]')) {
    if (elVisible(stop) && !grokNotStatusArea(stop)) return true;
  }
  for (const el of form.querySelectorAll("button, [role='button']")) {
    const t = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`.toLowerCase();
    if (!/stop generating|stop streaming|abort|생성 중지|답변 중지/.test(t)) continue;
    if (!elVisible(el) || grokNotStatusArea(el)) continue;
    return true;
  }
  return false;
}

/** Ancestors of a bubble that hold this answer's action row and no other turn. The composer stays
 * out: its stop button belongs to whatever request is in flight, not to this answer. */
function grokAnswerRoot(bubble) {
  let node = bubble;
  while (node?.parentElement && node.parentElement !== document.body && node.parentElement !== document.documentElement) {
    const parent = node.parentElement;
    if (parent.querySelector("form[data-composer]")) break;
    const assistants = parent.querySelectorAll("[data-testid='assistant-message']");
    const users = parent.querySelectorAll("[data-testid='user-message']");
    if (assistants.length !== 1 || users.length !== 0) break;
    node = parent;
  }
  return node;
}
function responseRoot(message, replies, user) {
  if (!grokTurn(message)) return message;
  const climbed = grokAnswerRoot(message);
  const nodes = [...climbed.querySelectorAll(turnNodeSelector())];
  if (nodes.every(node => node === user || replies.includes(node))) return climbed;
  return message;
}
function currentAssistantRoot() {
  const messages = [...document.querySelectorAll(turnNodeSelector())];
  const last = messages[messages.length - 1];
  if (turnRole(last) !== "assistant") return null;
  return grokAnswerRoot(last);
}

/** A visible Copy action can arrive before Grok finishes a structured answer. Keep polling when
 * the response starts as JSON but ends inside a string/container; prose and malformed-but-closed JSON
 * remain eligible for the normal repair lane. */
function grokStructuredReplyIncomplete(text) {
  let candidate = String(text || "").trim();
  candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return false;
  const stack = [];
  let quoted = false, escaped = false;
  for (const char of candidate) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const open = stack.at(-1);
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return false;
      stack.pop();
    }
  }
  return quoted || stack.length > 0;
}

/** Never while the composer shows a stream. Then answer actions, or, once this submission's poll
 * recorded a stream, the composer idle again with text in the bubble. A page opened after completion
 * still finishes from the action row, with no stream mark. */
function grokReplyDoneVisible(root) {
  if (!root?.querySelectorAll) return false;
  const bubble = root.matches?.("[data-testid='assistant-message']") ? root : root.querySelector("[data-testid='assistant-message']");
  if (!bubble) return false;
  if (grokStreamVisible(document)) return false;
  const text = (bubble.innerText || bubble.textContent || "").trim();
  // Grok can expose copy/feedback controls for a collapsed reasoning turn before it has mounted
  // the final answer. Those controls are not completion evidence: a transcript containing only
  // "Analyzing …" lines and the elapsed-time label must keep polling for the late answer.
  if (grokStructuredReplyIncomplete(text)) return false;
  const reasoningLines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const isReasoningLine = line => /^(?:analyzing\b|thinking\b|reasoning\b|분석 중\b|생각 중\b|추론 중\b|thought\s+for\s+\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|mins?|minutes?)\b)/i.test(line);
  if (reasoningLines.length > 1 && reasoningLines.every(isReasoningLine)) return false;
  if (!text) return false;
  const action = /^(?:copy response|copy|like|dislike|more actions|응답 복사|복사|좋아요|싫어요|더 보기|더보기|신고)$/i;
  for (const el of root.querySelectorAll("button, [role='button']")) {
    if (el.closest("pre, code, .chat-code-block")) continue;
    const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 48 || !action.test(label) || !elVisible(el)) continue;
    return true;
  }
  if (text.length < 2 || !grokSawCurrentStream(root)) return false;
  const form = document.querySelector("form[data-composer]");
  if (!form) return false;
  const submit = form.querySelector('[data-testid="chat-submit"]');
  const voice = form.querySelector('[data-testid="bot-voice-call-start"]') ||
    [...form.querySelectorAll("button")].find(el => /음성 모드 시작|start voice mode/i.test(el.getAttribute("aria-label") || ""));
  return elVisible(submit) || elVisible(voice);
}
function replyDoneVisible(root = currentAssistantRoot()) {
  return grokReplyDoneVisible(root);
}

function grokLevelHit(level, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "heavy") return /(?:^|\s)(heavy|헤비)(?:\s|$)/i.test(t);
  if (level === "expert") return /(?:^|\s)(expert|전문가)(?:\s|$)/i.test(t);
  if (level === "build") return /(?:^|\s)(build|빌드)(?:모드)?(?:\s|$)/i.test(t);
  if (level === "fast") return /(?:^|\s)(fast|빠른)(?:\s|$)/i.test(t);
  if (level === "auto") return /(?:^|\s)(auto|자동)(?:\s|$)/i.test(t);
  return false;
}
function grokPill() {
  return document.querySelector("#model-select-trigger") ||
    document.querySelector("button[aria-label='Model select']") ||
    document.querySelector("button[aria-label='모델 선택']");
}

if (!globalThis.__ashlarChatgptSelectReasoning) globalThis.__ashlarChatgptSelectReasoning = selectReasoning;
globalThis.selectReasoning = async function(provider, level, deadline = Date.now() + 60_000) {
  if (provider !== "grok") return globalThis.__ashlarChatgptSelectReasoning(provider, level, deadline);
  const want = String(level || "expert");
  const fallback = want === "heavy" || want === "build" ? [want, "expert"] : [want];
  const pill = grokPill();
  if (!pill) return "skipped";
  if (grokLevelHit(want, pillText(pill))) return "current";
  globalThis.throwIfStopped?.();
  if (Date.now() >= deadline) return "skipped";
  openRadixTrigger(pill);
  let items = [];
  for (;;) {
    await (typeof waitForPageChange === "function" ? waitForPageChange(400) : sleep(400));
    globalThis.throwIfStopped?.();
    items = reasoningMenuItems();
    if (items.length || Date.now() >= deadline) break;
  }
  if (Date.now() >= deadline && !items.length) { await closeGrokLayers(); return "skipped"; }
  await sleep(400);
  globalThis.throwIfStopped?.();
  if (Date.now() >= deadline) { await closeGrokLayers(); return "skipped"; }
  items = reasoningMenuItems();
  const pickable = n => n instanceof HTMLElement && !n.disabled && n.getAttribute("aria-disabled") !== "true" &&
    (n.getAttribute("data-disabled") === null || n.getAttribute("data-disabled") === "false");
  for (const key of fallback) {
    const el = items.find(n => pickable(n) && grokLevelHit(key, pillText(n)));
    if (el instanceof HTMLElement) {
      el.click();
      await sleep(400);
      await closeGrokLayers();
      return "selected";
    }
  }
  await closeGrokLayers();
  return "skipped";
};

/** Open a Radix trigger the way a pointer does: Radix menus open on pointerdown, so a bare click()
 * left the model menu shut and the selection waited out its 60 s (live Grok legs, 2026-10-02). */
function openRadixTrigger(el) {
  const at = {bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true};
  try { el.dispatchEvent(new PointerEvent("pointerdown", at)); } catch { /* older engines: click below */ }
  if (el.getAttribute("aria-expanded") !== "true") el.click();
}

/** A layer that blocks the page: a visible menu, dialog or popover. An aria-hidden <main> alone is not
 * one (a stale attribute left after a layer unmounted would otherwise block every send). */
function grokBlockingLayer() {
  return [...document.querySelectorAll("[role='dialog'], [role='alertdialog'], [role='menu'], [data-radix-popper-content-wrapper]")]
    .some(el => (typeof elVisible === "function" ? elVisible(el) : true) || el.matches("[data-radix-popper-content-wrapper]") && el.childElementCount > 0);
}

/** Close any open menu or dialog with Escape, sent where Radix listens (the focused element and the
 * layer itself, then the document); true once nothing blocks the page. */
async function closeGrokLayers(ms = 3000) {
  const end = Date.now() + ms;
  while (grokBlockingLayer() && Date.now() < end) {
    globalThis.throwIfStopped?.(); // a stopped or taken-over run never sends keys into the user's page
    const key = {key: "Escape", code: "Escape", bubbles: true, cancelable: true};
    const targets = [document.activeElement, ...document.querySelectorAll("[role='menu'], [role='dialog'], [role='alertdialog']"), document];
    for (const t of targets) { try { t?.dispatchEvent(new KeyboardEvent("keydown", key)); } catch { /* next */ } }
    await sleep(300);
  }
  return !grokBlockingLayer();
}
