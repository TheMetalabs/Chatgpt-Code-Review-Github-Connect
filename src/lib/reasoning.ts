export const CHATGPT_REASONING = ["instant", "medium", "high", "extra_high", "pro"] as const;
export type ChatgptReasoning = (typeof CHATGPT_REASONING)[number];
export const DEFAULT_CHATGPT_REASONING: ChatgptReasoning = "pro";

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

export function chatgptUrl(reasoning: ChatgptReasoning): string {
  if (reasoning === "pro") return "https://chatgpt.com/?temporary-chat=true&model=gpt-6-pro";
  return "https://chatgpt.com/?temporary-chat=true";
}

export function chatgptReasoningMatches(level: ChatgptReasoning, text: string): boolean {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "pro") return /6\s*pro/i.test(t) || /^pro$/i.test(t);
  if (level === "extra_high") return /extra\s*high/i.test(t);
  if (level === "high") return /^(high|높음)$/i.test(t);
  if (level === "medium") return /^(medium|보통)$/i.test(t);
  if (level === "instant") return /^(instant|즉시)$/i.test(t);
  return false;
}

export function grokReasoningMatches(level: GrokReasoning, text: string): boolean {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (level === "heavy") return /^(heavy|헤비)$/i.test(t);
  if (level === "expert") return /^(expert|전문가)$/i.test(t);
  if (level === "fast") return /^(fast|빠른)$/i.test(t);
  if (level === "auto") return /^(auto|자동)$/i.test(t);
  return false;
}
