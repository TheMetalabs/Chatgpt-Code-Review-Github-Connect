function quotaHitText(text) {
  const t = String(text || "").toLowerCase();
  return /you've reached (the |your )?(limit|usage)|you've hit (the |your )?(free plan )?limit|usage limit reached|rate limit exceeded|too many requests|out of (credits|quota)|limit resets in/.test(
    t,
  );
}

function quotaHit() {
  return quotaHitText((document.body && document.body.innerText) || "");
}
