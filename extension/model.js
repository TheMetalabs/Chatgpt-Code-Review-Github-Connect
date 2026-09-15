function pillText(el) {
  return (el?.innerText || el?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
}

function chatgptLevelHit(level, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "pro") return /6\s*pro/i.test(t) || /(?:^|\s)pro(?:\s|$)/i.test(t);
  if (level === "extra_high") return /extra\s*high/i.test(t);
  if (level === "high") return /(?:^|\s)(high|높음)(?:\s|$)/i.test(t) && !/extra/i.test(t);
  if (level === "medium") return /(?:^|\s)(medium|보통)(?:\s|$)/i.test(t);
  if (level === "instant") return /(?:^|\s)(instant|즉시)(?:\s|$)/i.test(t);
  return false;
}

function grokLevelHit(level, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "heavy") return /(?:^|\s)(heavy|헤비)(?:\s|$)/i.test(t);
  if (level === "expert") return /(?:^|\s)(expert|전문가)(?:\s|$)/i.test(t);
  if (level === "fast") return /(?:^|\s)(fast|빠른)(?:\s|$)/i.test(t);
  if (level === "auto") return /(?:^|\s)(auto|자동)(?:\s|$)/i.test(t);
  return false;
}

function chatgptPill() {
  return (
    document.querySelector("button.__composer-pill[aria-haspopup='menu']") ||
    document.querySelector("form[data-type='unified-composer'] button[aria-haspopup='menu']")
  );
}

function grokPill() {
  return document.querySelector("#model-select-trigger") || document.querySelector("button[aria-label='모델 선택']");
}

async function selectReasoning(provider, level) {
  const want = String(level || (provider === "grok" ? "heavy" : "pro"));
  const hit = provider === "grok" ? grokLevelHit : chatgptLevelHit;
  const fallback =
    provider === "grok"
      ? want === "heavy"
        ? ["heavy", "expert"]
        : [want]
      : want === "pro"
        ? ["pro", "extra_high", "high"]
        : [want];
  const pill = provider === "grok" ? grokPill() : chatgptPill();
  if (!pill) return;
  if (hit(want, pillText(pill))) return;
  pill.click();
  await sleep(800);
  const items = [
    ...document.querySelectorAll(
      "[role='menuitem'], [role='option'], [role='menuitemradio'], [data-radix-collection-item], [cmdk-item]",
    ),
  ];
  for (const key of fallback) {
    const el = items.find((n) => hit(key, pillText(n)));
    if (el instanceof HTMLElement) {
      el.click();
      await sleep(400);
      return;
    }
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function findingsJsonTooThin(raw) {
  try {
    const parsed = JSON.parse(raw);
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    if (findings.length > 0) return false;
    const safe = Array.isArray(parsed.investigated_safe) ? parsed.investigated_safe : [];
    return safe.filter((x) => String(x || "").trim()).length < 1;
  } catch {
    return true;
  }
}
