function quotaHitText(text) {
  const t = String(text || "").toLowerCase();
  if (/upgrade to (chatgpt )?plus/.test(t) && !/reached|hit your|한도에 도달|주간 한도/.test(t)) return false;
  // Require reached/hit/exceeded-style signals. Bare "weekly limit" / "한도 늘리기" alone must NOT match.
  return (
    /you've reached.{0,80}limit|you've hit.{0,80}limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets|reached.{0,40}weekly limit|hit.{0,40}weekly limit|exceeded.{0,40}(limit|quota)/.test(t) ||
    /한도에 도달|주간 한도에 도달|사용량 한도|한도가 재설정|초기화됩니다|크레딧이 없|메시지 한도/.test(t)
  );
}

function quotaHit() {
  const notices = document.querySelectorAll(
    '[role="alert"], [role="status"], [role="dialog"], [data-testid*="quota" i], [class*="toast" i], [class*="banner" i], [class*="notice" i]',
  );
  for (const el of notices) {
    if (!elVisible(el) || el.closest('[data-message-author-role="user"], .markdown, pre, code')) continue;
    const text = (el.textContent || "").trim();
    if (text.length <= 400 && quotaHitText(text)) return true;
  }
  for (const el of document.querySelectorAll("span, button, [class*='card']")) {
    if (!elVisible(el) || el.closest('[data-message-author-role], [data-testid^="conversation-turn-"], pre, code')) continue;
    const text = (el.textContent || "").trim();
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

function stopButtonVisible(root = document) {
  const stop = root.querySelector('[data-testid="stop-button"]');
  if (elVisible(stop)) return true;
  for (const el of root.querySelectorAll("button, [role='button']")) {
    const t = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`.toLowerCase();
    if (!/stop generating|stop streaming|abort|생성 중지|답변 중지/.test(t)) continue;
    if (!elVisible(el)) continue;
    return true;
  }
  return false;
}

/** Never reuse completion controls from an answer before the latest user turn. */
function currentAssistantRoot() {
  const turns = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
  if (turns.length) {
    const last = turns[turns.length - 1];
    return last.querySelector('[data-message-author-role="assistant"]') ? last : null;
  }
  const messages = [...document.querySelectorAll('[data-message-author-role]')];
  const last = messages[messages.length - 1];
  if (last?.getAttribute("data-message-author-role") !== "assistant") return null;
  return last.closest("article, section") || last;
}

/** Current assistant-turn copy/feedback only, never hidden or previous-turn controls. */
function replyDoneVisible(root = currentAssistantRoot()) {
  if (!root) return false;
  if (elVisible(root.querySelector('[aria-label="응답 작업"], [aria-label="Response actions"]'))) return true;
  for (const el of root.querySelectorAll('[data-testid="copy-turn-action-button"], [data-testid="feedback-turn-action-button"]')) {
    const aria = el.getAttribute("aria-label") || "";
    if (/메시지 복사|copy message|내 메시지/i.test(aria)) continue;
    if (elVisible(el) && /응답|copy response|feedback|평가/i.test(aria)) return true;
  }
  return false;
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
