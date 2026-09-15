function quotaHitText(text) {
  const t = String(text || "").toLowerCase();
  return /you've reached (the |your )?(limit|usage)|you've hit (the |your )?(free plan )?limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets in|한도에 도달|사용량 한도|한도가 재설정|크레딧이 없/.test(
    t,
  );
}

function quotaHit() {
  return quotaHitText((document.body && document.body.innerText) || "");
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
