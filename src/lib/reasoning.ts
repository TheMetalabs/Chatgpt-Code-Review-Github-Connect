export const CHATGPT_REASONING = ["instant", "medium", "high", "extra_high", "pro"] as const;
export type ChatgptReasoning = (typeof CHATGPT_REASONING)[number];
// "pro" (gpt-6-pro) no longer exists in the ChatGPT lineup; the current highest effort is
// "extra_high" (labeled "Extra High" / "매우 높음"). Default to it so the pill selection targets a
// real level instead of a dead one.
export const DEFAULT_CHATGPT_REASONING: ChatgptReasoning = "extra_high";

export const GROK_REASONING = ["auto", "fast", "expert", "heavy"] as const;
export type GrokReasoning = (typeof GROK_REASONING)[number];
export const DEFAULT_GROK_REASONING: GrokReasoning = "heavy";

export const CHATGPT_REASONING_LABEL: Record<ChatgptReasoning, string> = {
  instant: "Instant",
  medium: "Medium",
  high: "High",
  extra_high: "Extra High",
  pro: "6 Pro (highest)",
};

export const GROK_REASONING_LABEL: Record<GrokReasoning, string> = {
  auto: "Auto / 자동",
  fast: "Fast / 빠른",
  expert: "Expert / 전문가",
  heavy: "Heavy / 헤비 (highest)",
};

export function normalizeChatgptReasoning(v: unknown): ChatgptReasoning {
  return CHATGPT_REASONING.includes(v as ChatgptReasoning) ? (v as ChatgptReasoning) : DEFAULT_CHATGPT_REASONING;
}

export function normalizeGrokReasoning(v: unknown): GrokReasoning {
  return GROK_REASONING.includes(v as GrokReasoning) ? (v as GrokReasoning) : DEFAULT_GROK_REASONING;
}

export function chatgptUrl(_reasoning: ChatgptReasoning): string {
  // Never pin a model slug in the URL. The effort/model is chosen from the composer pill after the
  // page loads (selectReasoning). A hardcoded slug that no longer exists (e.g. gpt-6-pro) makes
  // ChatGPT serve a logged-out-looking landing page with no composer — the runner then hangs even
  // though the browser is signed in. Always open the plain temporary chat.
  return "https://chatgpt.com/?temporary-chat=true";
}

export function chatgptReasoningMatches(level: ChatgptReasoning, text: string): boolean {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "pro") return /6\s*pro/i.test(t) || /(?:^|\s)pro(?:\s|$)/i.test(t);
  if (level === "extra_high") return /extra\s*high/i.test(t) || /매우\s*높음/.test(t);
  if (level === "high") return /(?:^|\s)(high|높음)(?:\s|$)/i.test(t) && !/extra/i.test(t) && !/매우/.test(t);
  if (level === "medium") return /(?:^|\s)(medium|보통|중간)(?:\s|$)/i.test(t);
  if (level === "instant") return /(?:^|\s)(instant|즉시)(?:\s|$)/i.test(t);
  return false;
}

export function grokReasoningMatches(level: GrokReasoning, text: string): boolean {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "heavy") return /(?:^|\s)(heavy|헤비)(?:\s|$)/i.test(t);
  if (level === "expert") return /(?:^|\s)(expert|전문가)(?:\s|$)/i.test(t);
  if (level === "fast") return /(?:^|\s)(fast|빠른)(?:\s|$)/i.test(t);
  if (level === "auto") return /(?:^|\s)(auto|자동)(?:\s|$)/i.test(t);
  return false;
}
