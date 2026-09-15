function quotaHitText(text) {
  const t = String(text || "").toLowerCase();
  if (/upgrade to (chatgpt )?plus/.test(t) && !/reached|hit your|한도에 도달|주간 한도/.test(t)) return false;
  return /you've reached.{0,80}limit|you've hit.{0,80}limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets|weekly limit|increase (your )?limit|한도에 도달|주간 한도|사용량 한도|한도가 재설정|한도 늘리기|초기화됩니다|크레딧이 없|메시지 한도/.test(
    t,
  );
}

function quotaHit() {
  if (quotaHitText((document.body && document.body.innerText) || "")) return true;
  for (const el of document.querySelectorAll("span, button, [class*='card']")) {
    const t = (el.textContent || "").trim();
    if (!t || t.length > 240) continue;
    if (quotaHitText(t)) return true;
  }
  return false;
}

function elVisible(el) {
  if (!el) return false;
  if (typeof visible === "function") return visible(el);
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function stopButtonVisible() {
  const stop = document.querySelector('[data-testid="stop-button"]');
  if (elVisible(stop)) return true;
  for (const el of document.querySelectorAll("button, [role='button']")) {
    const t = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`.toLowerCase();
    if (!/stop generating|stop streaming|abort|생성 중지|답변 중지|중단/.test(t)) continue;
    if (!elVisible(el)) continue;
    return true;
  }
  return false;
}

/** Assistant-turn copy/feedback only. User "메시지 복사" is not "answer done". */
function replyDoneVisible() {
  const assistantTurn = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].find((t) =>
    t.querySelector('[data-message-author-role="assistant"]'),
  );
  const root = assistantTurn || document.querySelector('[data-message-author-role="assistant"]')?.parentElement;
  if (!root) return false;
  if (elVisible(root.querySelector('[aria-label="응답 작업"], [aria-label="Response actions"]'))) return true;
  for (const el of root.querySelectorAll('[data-testid="copy-turn-action-button"], [data-testid="feedback-turn-action-button"]')) {
    const aria = el.getAttribute("aria-label") || "";
    if (/메시지 복사|copy message|내 메시지/i.test(aria)) continue;
    if (elVisible(el) && /응답|copy response|feedback|평가/i.test(aria)) return true;
  }
  return false;
}

function chatGenerationFinished() {
  if (replyDoneVisible()) return true;
  return !stopButtonVisible();
}
