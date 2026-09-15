/** Quota copy on the ChatGPT/Grok page — English or Korean, not Plus upsell. */
export function quotaHitText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  if (/upgrade to (chatgpt )?plus/.test(t) && !/reached|hit your|한도에 도달|주간 한도/.test(t)) return false;
  // Bare "weekly limit" / "한도 늘리기" alone must NOT match — require reached/hit/exceeded style.
  return (
    /you've reached.{0,80}limit|you've hit.{0,80}limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets|reached.{0,40}weekly limit|hit.{0,40}weekly limit|exceeded.{0,40}(limit|quota)/.test(
      t,
    ) ||
    /한도에 도달|주간 한도에 도달|사용량 한도|한도가 재설정|초기화됩니다|크레딧이 없|메시지 한도/.test(t)
  );
}
