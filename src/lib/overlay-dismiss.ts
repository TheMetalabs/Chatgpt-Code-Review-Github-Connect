/** Primary actions on ChatGPT/Grok first-run dialogs. Not Upgrade / Sign in. */
export const OVERLAY_ACCEPT =
  /^(ok|okay|got it|got it!|continue|continue to chat|confirm|accept|close|dismiss|skip|not now|i understand|알겠습니다|확인|계속하기|계속|닫기|건너뛰기|시작하기)$/i;

export const OVERLAY_PERSONAL =
  /non-?personal|without personal|don['’]t personalize|개인화 하지|비개인화|개인 정보 없이/i;

export function overlayLabels(aria: string, text: string): string[] {
  const parts = [aria, text].flatMap((s) =>
    String(s || "")
      .split(/\n/)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
  return [...new Set(parts)];
}

export function overlayButtonKind(label: string): "accept" | "personal" | null {
  const t = String(label || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (OVERLAY_ACCEPT.test(t)) return "accept";
  if (OVERLAY_PERSONAL.test(t)) return "personal";
  return null;
}

export function overlayButtonKindFromParts(aria: string, text: string): "accept" | "personal" | null {
  for (const label of overlayLabels(aria, text)) {
    const kind = overlayButtonKind(label);
    if (kind) return kind;
  }
  return null;
}

export function overlayIsLive(el: {
  hidden?: boolean;
  ariaHidden?: string | null;
  dataState?: string | null;
  display?: string;
  visibility?: string;
  width?: number;
  height?: number;
}): boolean {
  if (el.hidden) return false;
  if (el.ariaHidden === "true") return false;
  if (el.dataState === "closed") return false;
  if (el.display === "none" || el.visibility === "hidden") return false;
  return (el.width ?? 0) > 20 && (el.height ?? 0) > 20;
}
