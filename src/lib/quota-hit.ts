/** Quota copy on the ChatGPT/Grok page — English or Korean, not Plus upsell. */
export function quotaHitText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /you've reached (the |your )?(limit|usage)|you've hit (the |your )?(free plan )?limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets in|한도에 도달|사용량 한도|한도가 재설정|크레딧이 없/.test(
    t,
  );
}
