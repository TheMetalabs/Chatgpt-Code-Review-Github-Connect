function quotaHitText(text) {
  const t = String(text || "").toLowerCase();
  if (/upgrade to (chatgpt )?plus/.test(t) && !/reached|hit your|한도에 도달|주간 한도/.test(t)) return false;
  // Require reached/hit/exceeded-style signals. Bare "weekly limit" / "한도 늘리기" alone must NOT match.
  return (
    /you've reached.{0,80}limit|you've hit.{0,80}limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets|reached.{0,40}weekly limit|hit.{0,40}weekly limit|exceeded.{0,40}(limit|quota)/.test(t) ||
    /한도에 도달|주간 한도에 도달|사용량 한도|한도가 재설정|초기화됩니다|크레딧이 없|메시지 한도/.test(t)
  );
}

/** Grok's composer attachment list (composer.js grokAttachmentItems): file names, never a notice. */
function grokAttachmentListSelector() {
  return 'form[data-composer] [role="list"]';
}

/** A quota candidate's text without any Grok attachment list inside it: a container that holds the
 * list (a card, a dialog) never reads a staged file's name as its notice. */
function quotaCandidateText(el) {
  const list = grokAttachmentListSelector();
  if (!el.querySelector(list)) return (el.textContent || "").trim();
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
    if (!elVisible(el) || el.closest(`${turnAreaSelector()}, [data-testid^="conversation-turn-"], pre, code, ${grokAttachmentListSelector()}`)) continue;
    const text = quotaCandidateText(el);
    if (text.length <= 240 && quotaHitText(text)) return true;
  }
  return false;
}

/** Toolbar icons are 32px; composer.visible() requires >40px and would miss them. */
function elVisible(el) {
  if (!el) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  try {
    for (let node = el; node; node = node.parentElement) {
      const s = window.getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
  } catch {
    /* computed style can fail on detached nodes */
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The user turn a Grok stream belongs to. The stop control lives in the composer, not on the bubble,
 * so the mark is the turn, not the assistant node (that node mounts later, often without an id). */
function grokStreamKey() {
  if (typeof userTurnEls !== "function") return "";
  const users = userTurnEls();
  const last = users[users.length - 1];
  const id = last && typeof turnMessageId === "function" ? turnMessageId(last) : "";
  return id || `n:${users.length}`;
}

function markGrokStream() {
  const key = grokStreamKey();
  if (!key || key === "n:0") return;
  globalThis.__ashlarGrokSawStream = key;
  // The observed user bubble itself, so the same turn gaining its response id keeps the observation.
  const users = typeof userTurnEls === "function" ? userTurnEls() : [];
  globalThis.__ashlarGrokSawStreamTurn = users[users.length - 1] || null;
}

/** A stream was seen for the current user turn. An id-less (n:N) observation counts only for the very
 * bubble it saw, still the latest user turn at that count (also once it gains its id): the count alone
 * cannot tell a replacement bubble apart. An id observation matches by id. */
function grokSawCurrentStream() {
  const saw = globalThis.__ashlarGrokSawStream;
  if (!saw) return false;
  if (!String(saw).startsWith("n:")) return saw === grokStreamKey();
  const users = typeof userTurnEls === "function" ? userTurnEls() : [];
  const turn = globalThis.__ashlarGrokSawStreamTurn;
  return Boolean(turn && turn.isConnected && turn === users[users.length - 1] && saw === `n:${users.length}`);
}

/** Grok's in-flight composer, read by structure (grok.com bundle, 2026-09). While a reply streams, the
 * form's content opens with a strip holding the loader, div[role="status"][aria-live] whose text is
 * "Generating" (hardcoded English), and the stop button (aria-label "Stop model response", localized
 * "모델 응답 중지"); the action slot beside the editor may become an abort button with the same label.
 * The attachment list ([role="list"]) and the draft editor are never status: a file named
 * "Generating" or "Stop" and a prompt line are just content there. */
function grokNotStatusArea(el) {
  return Boolean(el.closest('[role="list"], [contenteditable]:not([contenteditable="false"]), textarea, input'));
}
function grokStatusStrip(form) {
  for (const status of form.querySelectorAll('[role="status"]')) {
    if (grokNotStatusArea(status) || !elVisible(status)) continue;
    if (/^generating\b/i.test((status.textContent || "").replace(/\s+/g, " ").trim())) return status;
  }
  return null;
}
function grokStopControl(form) {
  for (const el of form.querySelectorAll("button, [role='button']")) {
    const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!/^(?:stop model response|모델 응답 중지)$/i.test(label) || grokNotStatusArea(el) || !elVisible(el)) continue;
    return el;
  }
  return null;
}
function grokStreamVisible(root = document) {
  const form = root.querySelector?.("form[data-composer]");
  if (!form || !(grokStatusStrip(form) || grokStopControl(form))) return false;
  if (root === document || root === document.documentElement) markGrokStream();
  return true;
}

function stopButtonVisible(root = document) {
  // A Grok page: its composer decides. The composer probe runs first, and a generic stop control only
  // counts inside the composer and outside its attachment list and editor, so neither a transcript
  // control nor a file's name fakes (or hides) this turn's stream.
  const grokForm = root.querySelector?.("form[data-composer]");
  if (grokForm && grokStreamVisible(root)) return true;
  const counts = el => elVisible(el) && (!grokForm || (grokForm.contains(el) && !grokNotStatusArea(el)));
  const seen = () => {
    if (grokForm && (root === document || root === document.documentElement)) markGrokStream();
    return true;
  };
  for (const stop of root.querySelectorAll('[data-testid="stop-button"]')) {
    if (counts(stop)) return seen();
    if (!grokForm) break; // Generic layouts: the first stop-button only, as before.
  }
  for (const el of root.querySelectorAll("button, [role='button']")) {
    const t = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`.toLowerCase();
    if (!/stop generating|stop streaming|abort|생성 중지|답변 중지/.test(t)) continue;
    if (!counts(el)) continue;
    return seen();
  }
  return false;
}

/** Ancestors of a Grok bubble that hold this answer's action row and no other turn. The composer
 * stays out: its stop button belongs to whatever request is in flight, not to this answer. */
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

/** Never reuse completion controls from an answer before the latest user turn. */
function currentAssistantRoot() {
  const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
  if (turns.length) {
    const last = turns[turns.length - 1];
    return last.querySelector(turnSelector("assistant")) ? last : null;
  }
  const messages = [...document.querySelectorAll(turnNodeSelector())];
  const last = messages[messages.length - 1];
  if (turnRole(last) !== "assistant") return null;
  if (typeof grokTurn === "function" && grokTurn(last)) return grokAnswerRoot(last);
  // The unit DOM renders the answer's action row beside the unit, in its turn container.
  return (unitTurn(last) && last.closest("[data-content-search-turn-key]")) || last.closest("article, section") || last;
}

/** Never while Grok's composer shows a stream. Then Grok answer actions (copy / like / dislike / more), or, once a stream was actually seen, the
 * composer idle again with text in the bubble. Idle before the stop control appears is not done:
 * Submit is showing the whole time until generation starts. */
function grokReplyDoneVisible(root) {
  if (!root?.querySelectorAll) return false;
  const bubble = root.matches?.("[data-testid='assistant-message']") ? root : root.querySelector("[data-testid='assistant-message']");
  if (!bubble) return false;
  // While the composer shows a stream, the answer is not done, whatever action row is still showing
  // (a regenerate streams under the previous response's Copy / Like controls).
  if (grokStreamVisible(document)) return false;
  const action = /^(?:copy response|copy|like|dislike|more actions|응답 복사|복사|좋아요|싫어요|더 보기|더보기|신고)$/i;
  for (const el of root.querySelectorAll("button, [role='button']")) {
    if (el.closest("pre, code, .chat-code-block")) continue;
    const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 48 || !action.test(label) || !elVisible(el)) continue;
    return true;
  }
  const text = (bubble.innerText || bubble.textContent || "").trim();
  if (text.length < 2) return false;
  if (!grokSawCurrentStream()) return false;
  const form = document.querySelector("form[data-composer]");
  if (!form) return false;
  const submit = form.querySelector('[data-testid="chat-submit"]');
  const voice = form.querySelector('[data-testid="bot-voice-call-start"]') ||
    [...form.querySelectorAll("button")].find((el) => /음성 모드 시작|start voice mode/i.test(el.getAttribute("aria-label") || ""));
  return elVisible(submit) || elVisible(voice);
}

/** Current assistant-turn copy/feedback only, never hidden or previous-turn controls. */
function replyDoneVisible(root = currentAssistantRoot()) {
  if (!root) return false;
  if (grokReplyDoneVisible(root)) return true;
  if (elVisible(root.querySelector('[aria-label="응답 작업"], [aria-label="Response actions"]'))) return true;
  if (unitActionsVisible(root)) return true;
  for (const el of root.querySelectorAll('[data-testid="copy-turn-action-button"], [data-testid="feedback-turn-action-button"]')) {
    const aria = el.getAttribute("aria-label") || "";
    if (/메시지 복사|copy message|내 메시지/i.test(aria)) continue;
    if (elVisible(el) && /응답|copy response|feedback|평가/i.test(aria)) return true;
  }
  return false;
}

/** The unit DOM's answer actions (no test ids): a rate or regenerate control of the answer, outside
 * every unit (a code block's own copy button and the user's message controls are inside one). Only
 * for a root that holds an assistant unit. */
function unitActionsVisible(root) {
  const unit = "[data-content-search-unit-key]";
  if (!(root.matches(`${unit}[data-content-search-unit-key$=":assistant"]`) || root.querySelector(`${unit}[data-content-search-unit-key$=":assistant"]`))) return false;
  return [...root.querySelectorAll("button[aria-label], [role='button'][aria-label]")]
    .some(el => !el.closest(unit) && /응답 평가|응답 다시 생성|rate (this )?response|regenerate/i.test(el.getAttribute("aria-label") || "") && elVisible(el));
}

function responseStreaming(root = currentAssistantRoot()) {
  return Boolean(root && [...root.querySelectorAll('[data-streaming-response-status], [data-is-streaming="true"]')].some(elVisible));
}

/**
 * Match src/lib/chat-settle.ts object form.
 * Legacy boolean arg is ignored as forced sawStop — live DOM decides (migration wrapper).
 */
function chatGenerationFinished(input) {
  if (input == null || typeof input === "boolean") {
    return chatGenerationFinished({
      stopVisible: typeof stopButtonVisible === "function" && stopButtonVisible(),
      replyActionsVisible: typeof replyDoneVisible === "function" && replyDoneVisible(),
      sawStop: false,
    });
  }
  if (input.stopVisible) return false;
  return Boolean(input.replyActionsVisible);
}
