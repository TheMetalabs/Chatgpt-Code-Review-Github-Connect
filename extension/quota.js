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

function stopButtonVisible() {
  if (document.querySelector('[data-testid="stop-button"]')) return true;
  for (const el of document.querySelectorAll("button, [role='button']")) {
    const t = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`.toLowerCase();
    if (!/stop generating|stop streaming|abort|생성 중지|중단|중지/.test(t)) continue;
    if (typeof visible === "function" && !visible(el)) continue;
    return true;
  }
  return false;
}
