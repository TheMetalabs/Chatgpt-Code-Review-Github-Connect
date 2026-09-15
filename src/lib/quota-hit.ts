/** Page chrome like "Upgrade to ChatGPT Plus" must not count as a usage cap. */
export function quotaHitText(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /you've reached (the |your )?(limit|usage)|you've hit (the |your )?(free plan )?limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets in/.test(
    t,
  );
}
