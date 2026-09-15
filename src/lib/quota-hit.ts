/** Quota copy on the ChatGPT/Grok page — English or Korean, not Plus upsell. */
export function quotaHitText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  if (/upgrade to (chatgpt )?plus/.test(t) && !/reached|hit your|한도에 도달|주간 한도/.test(t)) return false;
  return /you've reached.{0,80}limit|you've hit.{0,80}limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets|weekly limit|increase (your )?limit|한도에 도달|주간 한도|사용량 한도|한도가 재설정|한도 늘리기|초기화됩니다|크레딧이 없|메시지 한도/.test(
    t,
  );
}