function overlayIsLive(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  if (el.getAttribute("data-state") === "closed") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width > 20 && r.height > 20;
}

function overlayRoot() {
  const nodes = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')];
  return nodes.find(overlayIsLive) || null;
}

function overlayKind(label) {
  const t = String(label || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (
    /^(ok|okay|got it|got it!|continue|continue to chat|confirm|accept|close|dismiss|skip|not now|i understand|알겠습니다|확인|계속하기|계속|닫기|건너뛰기|시작하기)$/i.test(
      t,
    )
  ) {
    return "accept";
  }
  if (/non-?personal|without personal|don't personalize|개인화 하지|비개인화|개인 정보 없이/i.test(t)) return "personal";
  return null;
}

function overlayKindForEl(el) {
  const labels = [el.getAttribute("aria-label") || "", el.textContent || ""]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const t of labels) {
    const kind = overlayKind(t);
    if (kind) return kind;
  }
  return null;
}

function clickOverlayButton(root, want) {
  const nodes = [...root.querySelectorAll("button, [role='button'], a")];
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (overlayKindForEl(el) === want) {
      el.click();
      return true;
    }
  }
  return false;
}

async function dismissOverlays() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const root = overlayRoot();
    if (!root) return;
    if (clickOverlayButton(root, "personal") || clickOverlayButton(root, "accept")) {
      await sleep(400);
      continue;
    }
    const close = [...root.querySelectorAll("button[aria-label*='Close' i], button[aria-label*='닫기']")].find(overlayIsLive);
    if (close instanceof HTMLElement) {
      close.click();
      await sleep(400);
      continue;
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(400);
    if (!overlayRoot()) return;
  }
}
