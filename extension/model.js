function pillText(el) {
  return (el?.innerText || el?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
}

function chatgptLevelHit(level, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "pro") return /6\s*pro/i.test(t) || /(?:^|\s)pro(?:\s|$)/i.test(t);
  if (level === "extra_high") return /extra\s*high/i.test(t) || /매우\s*높음/.test(t);
  if (level === "high") return /(?:^|\s)(high|높음)(?:\s|$)/i.test(t) && !/extra/i.test(t) && !/매우/.test(t);
  if (level === "medium") return /(?:^|\s)(medium|보통|중간)(?:\s|$)/i.test(t);
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

function reasoningMenuItems() {
  return [
    ...document.querySelectorAll(
      "[role='menuitem'], [role='option'], [role='menuitemradio'], [data-radix-collection-item], [cmdk-item]",
    ),
  ];
}

/** Picks the reasoning level on the model pill: "current" when it already shows it, "selected" once
 * clicked, "skipped" when it cannot be picked by `deadline` (no pill, a menu that never opens, no
 * matching item): the run then continues with the current model, never waits on the menu. */
async function selectReasoning(provider, level, deadline = Date.now() + 60_000) {
  const want = String(level || (provider === "grok" ? "heavy" : "extra_high"));
  const hit = provider === "grok" ? grokLevelHit : chatgptLevelHit;
  const fallback =
    provider === "grok"
      ? want === "heavy"
        ? ["heavy", "expert"]
        : [want]
      : want === "pro" || want === "extra_high"
        ? ["extra_high", "high", "medium"]
        : [want];
  const pill = provider === "grok" ? grokPill() : chatgptPill();
  if (!pill) return "skipped";
  if (hit(want, pillText(pill))) return "current";
  const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  // The stop fence (json.js), before each click: the model menu of a conversation the user opened in
  // the tab meanwhile is never touched.
  globalThis.throwIfStopped?.();
  if (Date.now() >= deadline) return "skipped";
  pill.click();
  // The menu renders after the click; wait for its items, but only up to the deadline.
  let items = [];
  for (;;) {
    await (typeof waitForPageChange === "function" ? waitForPageChange(400) : sleep(400));
    globalThis.throwIfStopped?.();
    items = reasoningMenuItems();
    if (items.length || Date.now() >= deadline) break;
  }
  if (Date.now() >= deadline && !items.length) { escape(); return "skipped"; }
  // Items can still be mounting; one short settle before choosing.
  await sleep(400);
  globalThis.throwIfStopped?.();
  if (Date.now() >= deadline) { escape(); return "skipped"; }
  items = reasoningMenuItems();
  for (const key of fallback) {
    const el = items.find((n) => hit(key, pillText(n)));
    if (el instanceof HTMLElement) {
      el.click();
      await sleep(400);
      return "selected";
    }
  }
  escape();
  return "skipped";
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
