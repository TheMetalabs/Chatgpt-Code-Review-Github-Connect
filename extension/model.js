function pillText(el) {
  return `${el?.getAttribute("aria-label") || ""} ${el?.innerText || ""}`.replace(/\s+/g, " ").trim();
}

function chatgptLevelHit(level, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "pro") return /6\s*pro/i.test(t) || /^pro$/i.test(t);
  if (level === "extra_high") return /extra\s*high/i.test(t);
  if (level === "high") return /^(high|높음)$/i.test(t);
  if (level === "medium") return /^(medium|보통)$/i.test(t);
  if (level === "instant") return /^(instant|즉시)$/i.test(t);
  return false;
}

function grokLevelHit(level, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "heavy") return /^(heavy|헤비)$/i.test(t);
  if (level === "expert") return /^(expert|전문가)$/i.test(t);
  if (level === "fast") return /^(fast|빠른)$/i.test(t);
  if (level === "auto") return /^(auto|자동)$/i.test(t);
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
  await sleep(400);
  const items = [...document.querySelectorAll("[role='menuitem'], [role='option'], [role='menuitemradio']")];
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
