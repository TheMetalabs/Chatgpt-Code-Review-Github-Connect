/**
 * Settings rules — the ONE source of truth for what a Settings save may contain and for which
 * fix-agent configuration the review loop can actually execute.
 *
 * Pure (no I/O), so the Settings screen, the save path (harbor patchHarborSettings /
 * settings.server saveBotSettings) and the loop runtime (loopEnabled) all import the SAME rules:
 * the screen cannot accept what the server rejects, and the server cannot store an enabled
 * configuration the runtime would refuse.
 *
 * CONTRACT
 * - settingsProblem(raw) / fixAgentProblem(raw) return null when a save is valid, else the message
 *   the operator sees. A field that is ABSENT keeps its default (programmatic partial patches); a
 *   field that is PRESENT must be valid — nothing is silently clamped or rewritten on save.
 * - enabled=true requires a WIRED provider AND a WIRED delivery the provider supports
 *   (fixLoopRunnable). loopEnabled in the runtime uses the same predicate, so a hand-edited or
 *   env-seeded non-wired pair also stays OFF at run time (fails closed).
 * NON-GOALS: normalizing a stored document at load (settings.server sanitizeBotSettings does that,
 * fail-closed); I/O; per-request provider behaviour beyond the capability table below.
 */
import {
  FIX_AGENT_KNOBS,
  FIX_AGENT_PROVIDERS,
  FIX_DELIVERIES,
  FIX_MODES,
  fixKnob,
  providersFromSettings,
  type BotSettings,
  type FixAgentKnob,
  type FixAgentProvider,
  type FixAgentSettings,
  type FixDelivery,
  type FixMode,
} from "./types.ts";

/** Per-provider facts every fix-agent decision reads (design §6b): the Settings rules, the loop
 * runtime's transport routing (productionRequestFix), and the fix watcher's deadlines
 * (providerFixDeps / fixGenerationMs). One row per provider, so no provider's behaviour can leak
 * into another's (e.g. the local LLM streaming flag or its deadline governing a chat fix). */
export interface FixProviderCaps {
  /** The loop can execute this provider today. */
  wired: boolean;
  /** Deliveries the provider supports at all; a stored pair outside this list is incompatible. */
  deliveries: readonly FixDelivery[];
  /** How a fix request reaches the provider. */
  transport: "local-llm" | "chrome-bridge" | "none";
  /** Whether a request reports queued / generating activity to the watcher. "local-streaming":
   * only while the local transport streams (ASHLAR_LOCAL_LLM_STREAM); "never": the watcher times
   * the request from send and its queue ceiling (fixAgent.queueMaxMs) does not apply. */
  activity: "local-streaming" | "never";
  /** The Settings deadline that ends a fix request. "timeoutMs": the watcher's generation
   * deadline, from the first output. "chatTimeoutMs": the bridge item's own deadline, from send
   * (queue + generation); the watcher waits FIX_DEADLINE_MARGIN_MS past it, so the bridge governs. */
  deadline: "timeoutMs" | "chatTimeoutMs";
}

export const FIX_PROVIDER_CAPS: Readonly<Record<FixAgentProvider, FixProviderCaps>> = {
  chatgpt: { wired: true, deliveries: ["script-apply", "chat-push"], transport: "chrome-bridge", activity: "never", deadline: "chatTimeoutMs" },
  grok: { wired: true, deliveries: ["script-apply", "chat-push"], transport: "chrome-bridge", activity: "never", deadline: "chatTimeoutMs" },
  local: { wired: true, deliveries: ["script-apply"], transport: "local-llm", activity: "local-streaming", deadline: "timeoutMs" },
  "coding-agent": { wired: false, deliveries: ["coding-agent"], transport: "none", activity: "never", deadline: "timeoutMs" },
};

/** The provider's row; an unknown / missing provider gets no transport and no activity. */
export function fixProviderCaps(provider: FixAgentProvider | null | undefined): FixProviderCaps {
  return (provider != null && FIX_PROVIDER_CAPS[provider]) || FIX_PROVIDER_CAPS["coding-agent"];
}

/** Whether a fix request to this provider reports activity. `localStreaming` is the local
 * transport's streaming flag — consulted ONLY for a provider whose row says so. */
export function fixReportsActivity(provider: FixAgentProvider | null | undefined, localStreaming: boolean): boolean {
  return fixProviderCaps(provider).activity === "local-streaming" && localStreaming;
}

/** Past a chat fix item's own deadline, the watcher waits this long before giving up on it. */
export const FIX_DEADLINE_MARGIN_MS = 60_000;

/** The Settings knob whose deadline governs a fix request, and the watcher's generation deadline
 * for it: the local timeoutMs itself, or a margin past the bridge's chatTimeoutMs (so the bridge
 * item's own deadline is the terminal one and the local-LLM knob never touches a chat fix). */
export function fixDeadline(fixAgent: Partial<FixAgentSettings> | undefined): { governs: "timeoutMs" | "chatTimeoutMs"; generationMs: number } {
  const governs = fixProviderCaps(fixAgent?.provider).deadline;
  const knob = fixKnob(fixAgent, governs);
  return { governs, generationMs: governs === "chatTimeoutMs" ? knob + FIX_DEADLINE_MARGIN_MS : knob };
}

/** Providers the loop can execute today (the Settings screen offers exactly these). */
export const WIRED_FIX_PROVIDERS: readonly FixAgentProvider[] = FIX_AGENT_PROVIDERS.filter((p) => FIX_PROVIDER_CAPS[p].wired);
/** Deliveries the loop can execute today: the server applies the fix (script-apply). */
export const WIRED_FIX_DELIVERIES: readonly FixDelivery[] = ["script-apply"];

/** The provider supports this delivery at all (wired or not). */
export function fixPairCompatible(provider: FixAgentProvider, delivery: FixDelivery): boolean {
  return FIX_PROVIDER_CAPS[provider]?.deliveries.includes(delivery) ?? false;
}

/** The runtime can execute this provider + delivery. */
export function fixLoopRunnable(fix: Pick<FixAgentSettings, "provider" | "delivery"> | undefined): boolean {
  const provider = fix?.provider;
  if (provider == null || !FIX_AGENT_PROVIDERS.includes(provider)) return false;
  const delivery = fix?.delivery;
  if (delivery === undefined || !WIRED_FIX_DELIVERIES.includes(delivery)) return false;
  return WIRED_FIX_PROVIDERS.includes(provider) && fixPairCompatible(provider, delivery);
}

/** The loop is ON: the switch is a literal true AND the configuration is runnable. */
export function fixLoopOn(fix: Partial<FixAgentSettings> | undefined): boolean {
  return fix?.enabled === true && fixLoopRunnable(fix as FixAgentSettings);
}

/** Numeric fix-agent fields as the Settings screen shows them (ms values are edited in minutes). */
export const FIX_KNOB_FIELDS: readonly { key: FixAgentKnob; label: string; unit: "count" | "minutes" | "chars" }[] = [
  { key: "parallelPrs", label: "fix_agent.parallel_prs", unit: "count" },
  { key: "roundCap", label: "fix_agent.round_cap", unit: "count" },
  { key: "attempts", label: "fix_agent.attempts", unit: "count" },
  { key: "timeoutMs", label: "fix_agent.timeout_minutes", unit: "minutes" },
  { key: "queueMaxMs", label: "fix_agent.queue_max_minutes", unit: "minutes" },
  { key: "chatTimeoutMs", label: "fix_agent.chat_timeout_minutes", unit: "minutes" },
  { key: "chatMaxPromptChars", label: "fix_agent.chat_max_prompt_chars", unit: "chars" },
];

export function toFormUnit(key: FixAgentKnob, v: number): number {
  return FIX_KNOB_FIELDS.find((f) => f.key === key)?.unit === "minutes" ? v / 60_000 : v;
}

export function fromFormUnit(key: FixAgentKnob, v: number): number {
  return FIX_KNOB_FIELDS.find((f) => f.key === key)?.unit === "minutes" ? v * 60_000 : v;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Why this fixAgent block cannot be saved (null = valid). */
export function fixAgentProblem(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isObject(raw)) return "fix_agent must be an object";
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return "fix_agent.enabled must be true or false";
  if (raw.provider !== undefined && raw.provider !== null && !FIX_AGENT_PROVIDERS.includes(raw.provider as FixAgentProvider)) {
    return `fix_agent.provider must be one of: none, ${FIX_AGENT_PROVIDERS.join(", ")}`;
  }
  if (raw.delivery !== undefined && !FIX_DELIVERIES.includes(raw.delivery as FixDelivery)) {
    return `fix_agent.delivery must be one of: ${FIX_DELIVERIES.join(", ")}`;
  }
  if (raw.mode !== undefined && !FIX_MODES.includes(raw.mode as FixMode)) return `fix_agent.mode must be one of: ${FIX_MODES.join(", ")}`;
  for (const f of FIX_KNOB_FIELDS) {
    const v = raw[f.key];
    if (v === undefined) continue;
    const k = FIX_AGENT_KNOBS[f.key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < k.min || v > k.max) {
      return `${f.label} must be a whole number from ${toFormUnit(f.key, k.min)} to ${toFormUnit(f.key, k.max)}`;
    }
  }
  const provider = (raw.provider ?? null) as FixAgentProvider | null;
  const delivery = (raw.delivery ?? "script-apply") as FixDelivery;
  if (provider !== null && !fixPairCompatible(provider, delivery)) {
    return `fix_agent.provider ${provider} cannot use delivery ${delivery} (it supports: ${FIX_PROVIDER_CAPS[provider].deliveries.join(", ")})`;
  }
  if (raw.enabled === true) {
    if (provider === null) return "choose a fix provider to enable the review loop";
    if (!WIRED_FIX_PROVIDERS.includes(provider)) {
      return `fix_agent.provider ${provider} is not wired yet: choose ${WIRED_FIX_PROVIDERS.join(", ")} to enable the review loop`;
    }
    if (!WIRED_FIX_DELIVERIES.includes(delivery)) {
      return `fix_agent.delivery ${delivery} is not wired yet: choose ${WIRED_FIX_DELIVERIES.join(", ")} to enable the review loop`;
    }
  }
  return null;
}

export const NO_REVIEWER_PROBLEM = "enable ChatGPT, Grok, or a local URL+model";

/** Why these settings cannot be saved (null = valid). `raw` is the full document about to be
 * saved (the live settings with the operator's patch merged over them), before normalization. */
export function settingsProblem(raw: Partial<BotSettings> | Record<string, unknown>): string | null {
  const r = raw as Record<string, unknown>;
  const fix = fixAgentProblem(r.fixAgent);
  if (fix) return fix;
  if (!providersFromSettings(r as unknown as BotSettings).length) return NO_REVIEWER_PROBLEM;
  return null;
}

/** A save that did not happen. status 400 = the operator's input was rejected (nothing written);
 * 500 = the settings could not be persisted (nothing changed, the live settings included). */
export class SettingsError extends Error {
  readonly status: 400 | 500;
  constructor(message: string, status: 400 | 500) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
  }
}

/** The document a Settings patch would save: the patch merged over the live settings, checked by
 * settingsProblem BEFORE any normalization (a rejected value is never clamped into a valid one).
 * Throws SettingsError 400; the caller normalizes, persists, then swaps its live settings. */
export function validatedSettingsPatch<T extends object>(current: T, patch: Partial<T>): T {
  const merged = { ...current, ...patch };
  const problem = settingsProblem(merged as Record<string, unknown>);
  if (problem) throw new SettingsError(problem, 400);
  return merged;
}
