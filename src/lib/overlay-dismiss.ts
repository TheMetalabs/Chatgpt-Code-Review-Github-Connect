/** Primary actions on ChatGPT/Grok first-run dialogs. Not Upgrade / Sign in. */
export const OVERLAY_ACCEPT =
  /^(ok|okay|got it|got it!|continue|continue to chat|confirm|accept|close|dismiss|skip|not now|i understand|알겠습니다|확인|계속하기|계속|닫기|건너뛰기|시작하기)$/i;

export const OVERLAY_PERSONAL =
  /non-?personal|without personal|don't personalize|개인화 하지|비개인화|개인 정보 없이/i;

export function overlayButtonKind(label: string): "accept" | "personal" | null {
  const t = String(label || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (OVERLAY_ACCEPT.test(t)) return "accept";
  if (OVERLAY_PERSONAL.test(t)) return "personal";
  return null;
}
