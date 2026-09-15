function overlayRoot() {
  return (
    document.querySelector('[role="dialog"]') ||
    document.querySelector('[role="alertdialog"]') ||
    document.querySelector('[aria-modal="true"]')
  );
}

function overlayLabel(el) {
  return `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.replace(/\s+/g, " ").trim();
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

function clickOverlayButton(root, want) {
  const nodes = [...root.querySelectorAll("button, [role='button'], a")];
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (overlayKind(overlayLabel(el)) === want) {
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
    const close = root.querySelector("button[aria-label*='Close' i], button[aria-label*='닫기']");
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
