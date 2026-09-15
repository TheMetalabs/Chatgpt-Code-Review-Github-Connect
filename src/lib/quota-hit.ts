/** Pre-send only. Do not scan the page after the model starts talking. */
export function quotaHitText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /you've reached (the |your )?(limit|usage)|you've hit (the |your )?(free plan )?limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets in/.test(
    t,
  );
}
