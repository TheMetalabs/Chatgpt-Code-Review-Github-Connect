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
 * - SETTINGS_FIELD_RULES has one rule per writable BotSettings field (the type forces a new field
 *   to get one). The Settings API route passes every supplied field RAW to validatedSettingsPatch:
 *   an unknown / read-only field or an invalid value is a 400; the route prefilters nothing.
 * - The schema is strict at EVERY nesting level: NESTED_SETTINGS_RULES has one key rule per nested
 *   object (the type forces a new nested field to get one); a nested key outside it is a 400
 *   before anything is merged or validated.
 * - enabled=true requires a WIRED provider AND a WIRED delivery the provider supports
 *   (fixLoopRunnable). loopEnabled in the runtime uses the same predicate, so a hand-edited or
 *   env-seeded non-wired pair also stays OFF at run time (fails closed).
 * NON-GOALS: normalizing a stored document at load (settings.server sanitizeBotSettings does that,
 * fail-closed); I/O; per-request provider behaviour beyond the capability table below.
 */
import {
  DEFAULT_REVIEW_ORDER,
  FIX_AGENT_KNOBS,
  FIX_AGENT_PROVIDERS,
  FIX_DELIVERIES,
  FIX_MODES,
  LOCAL_REVIEW_MODES,
  fixKnob,
  isMaskedSecret,
  providersFromSettings,
  type BotSettings,
  type FixAgentKnob,
  type FixAgentProvider,
  type FixAgentSettings,
  type FixDelivery,
} from "./types.ts";
import { CHATGPT_REASONING, GROK_REASONING } from "./reasoning.ts";

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

/** How a whole-number setting is edited on the Settings screen. "minutes": stored in ms, edited
 * in minutes. */
export type FormUnit = "count" | "minutes" | "chars";

export const MS_PER_MINUTE = 60_000;

/** A whole-number setting's ONE validity domain: an integer in [min, max] (ms for a "minutes"
 * field). The same domain holds at every boundary: the env seed and load normalize into it
 * (fixKnob / sanitizeBotSettings), and an API save and a UI save are validated against it (this
 * module), so a value one layer stores is a value every other layer accepts. */
export interface IntDomain {
  min: number;
  max: number;
  unit: FormUnit;
}

/** The input a Settings field renders, derived from its domain (never written by hand in the
 * page): min / max in form units, and the step. A "minutes" input takes ANY number of minutes
 * (step "any") because a server-valid value need not be a whole minute (90000 ms = 1.5 min); the
 * page's own check (the shared rules below) then requires the ms value to be whole. Every other
 * field steps by 1 (whole numbers only, the same as the server). */
export interface FormInputAttrs {
  min: number;
  max: number;
  step: number | "any";
  unit: FormUnit;
}

export function formAttrs(d: IntDomain): FormInputAttrs {
  return { min: toForm(d.unit, d.min), max: toForm(d.unit, d.max), step: d.unit === "minutes" ? "any" : 1, unit: d.unit };
}

/** Stored value -> the value the input shows. */
export function toForm(unit: FormUnit, v: number): number {
  return unit === "minutes" ? v / MS_PER_MINUTE : v;
}

/** The input's value -> the stored value. Minutes -> ms is EXACT for every whole-ms value: the
 * float noise of the conversion (1.0000166666666666 min x 60000) is rounded away, but a value
 * that is not a whole number of ms (1.00001 min) stays fractional, so the shared rule rejects it
 * exactly as the server would. NaN (an empty input) stays NaN (rejected). */
export function fromForm(unit: FormUnit, v: number): number {
  if (unit !== "minutes") return v;
  const ms = v * MS_PER_MINUTE;
  const whole = Math.round(ms);
  return Math.abs(ms - whole) < 1e-6 ? whole : ms;
}

/** Why `v` is outside the domain (null = valid). */
export function intProblem(label: string, d: IntDomain, v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= d.min && v <= d.max) return null;
  return d.unit === "minutes"
    ? `${label} must be a whole number of milliseconds, from ${toForm(d.unit, d.min)} to ${toForm(d.unit, d.max)} minutes`
    : `${label} must be a whole number from ${d.min} to ${d.max}`;
}

/** Numeric fix-agent fields as the Settings screen shows them (ms values are edited in minutes). */
export const FIX_KNOB_FIELDS: readonly { key: FixAgentKnob; label: string; unit: FormUnit }[] = [
  { key: "parallelPrs", label: "fix_agent.parallel_prs", unit: "count" },
  { key: "roundCap", label: "fix_agent.round_cap", unit: "count" },
  { key: "attempts", label: "fix_agent.attempts", unit: "count" },
  { key: "timeoutMs", label: "fix_agent.timeout_minutes", unit: "minutes" },
  { key: "queueMaxMs", label: "fix_agent.queue_max_minutes", unit: "minutes" },
  { key: "chatTimeoutMs", label: "fix_agent.chat_timeout_minutes", unit: "minutes" },
  { key: "chatMaxPromptChars", label: "fix_agent.chat_max_prompt_chars", unit: "chars" },
];

/** A fix-agent knob's domain (bounds from FIX_AGENT_KNOBS, the runtime's own clamp). */
export function fixKnobDomain(key: FixAgentKnob): IntDomain {
  const k = FIX_AGENT_KNOBS[key];
  return { min: k.min, max: k.max, unit: FIX_KNOB_FIELDS.find((f) => f.key === key)?.unit ?? "count" };
}

export function toFormUnit(key: FixAgentKnob, v: number): number {
  return toForm(fixKnobDomain(key).unit, v);
}

export function fromFormUnit(key: FixAgentKnob, v: number): number {
  return fromForm(fixKnobDomain(key).unit, v);
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

type Rule = (v: unknown) => string | null;

const bool = (label: string): Rule => (v) => (typeof v === "boolean" ? null : `${label} must be true or false`);
const text = (label: string): Rule => (v) => (typeof v === "string" ? null : `${label} must be a string`);
const nonBlank = (label: string): Rule => (v) => (typeof v === "string" && v.trim() ? null : `${label} must be a non-empty string`);
const oneOf = (label: string, values: readonly unknown[]): Rule => (v) => (values.includes(v) ? null : `${label} must be one of: ${values.join(", ")}`);

/** One value rule per fixAgent field — the block's writable key set. `Record<keyof
 * FixAgentSettings, Rule>` makes a new fixAgent field a type error until it has a rule; the knobs'
 * rules come from FIX_KNOB_FIELDS (the Settings screen's own field table). */
export const FIX_AGENT_FIELD_RULES: Readonly<Record<keyof FixAgentSettings, Rule>> = {
  enabled: bool("fix_agent.enabled"),
  provider: (v) =>
    v === null || FIX_AGENT_PROVIDERS.includes(v as FixAgentProvider) ? null : `fix_agent.provider must be one of: none, ${FIX_AGENT_PROVIDERS.join(", ")}`,
  delivery: oneOf("fix_agent.delivery", FIX_DELIVERIES),
  mode: oneOf("fix_agent.mode", FIX_MODES),
  ...(Object.fromEntries(FIX_KNOB_FIELDS.map((f) => [f.key, (v: unknown) => intProblem(f.label, fixKnobDomain(f.key), v)])) as Record<FixAgentKnob, Rule>),
};

/** Why this fixAgent block cannot be saved (null = valid). A key outside FIX_AGENT_FIELD_RULES is
 * rejected before any value is looked at. */
export function fixAgentProblem(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isObject(raw)) return "fix_agent must be an object";
  const unknownKey = nestedKeysProblem("fixAgent", raw);
  if (unknownKey) return unknownKey;
  for (const [key, rule] of Object.entries(FIX_AGENT_FIELD_RULES)) {
    if (raw[key] === undefined) continue;
    const problem = rule(raw[key]);
    if (problem) return problem;
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

/** Every BotSettings field a save may write (the derived *Set flags are read-only). */
export type SettingsField = Exclude<keyof BotSettings, "localLlmApiKeySet" | "webhookSecretSet">;

/** The object shape nested in a settings value: the value itself when it is an object, the element
 * type of an array of objects; never for a primitive or an array of primitives. */
type NestedShape<T> = T extends readonly (infer E)[] ? (E extends object ? E : never) : T extends object ? T : never;

/** Every writable BotSettings field whose value is (or holds) a nested object — derived from the
 * type, so a new nested field joins this set by itself. */
export type NestedSettingsField = {
  [K in SettingsField]-?: [NestedShape<NonNullable<BotSettings[K]>>] extends [never] ? never : K;
}[SettingsField];

/** A nested object's writable key set: one value rule per key (its keys ARE the set). */
export interface NestedRule<T> {
  label: string;
  fields: Readonly<Record<keyof T, Rule>>;
}

/** One key rule per nested object. The mapped type makes a new nested BotSettings field a type
 * error here until it has a rule, and each rule's `fields` must name exactly the nested type's
 * keys, so no nested object can accept a key it does not store. */
export const NESTED_SETTINGS_RULES: { readonly [K in NestedSettingsField]: NestedRule<NestedShape<NonNullable<BotSettings[K]>>> } = {
  fixAgent: { label: "fix_agent", fields: FIX_AGENT_FIELD_RULES },
};

const NESTED_FIELDS = Object.keys(NESTED_SETTINGS_RULES) as NestedSettingsField[];

function isNestedField(key: string): key is NestedSettingsField {
  return Object.hasOwn(NESTED_SETTINGS_RULES, key);
}

/** Why a supplied nested value carries an own key outside its writable set (null = none): every
 * object in it (the value itself, or each element of an array) is checked. A non-object value is
 * left to the field's own rule. Runs BEFORE any merge or value rule, so an unknown key (a typo such
 * as fix_agent.paralellPrs) is a 400 — never merged, ignored, dropped by sanitize and answered 200. */
export function nestedKeysProblem(field: NestedSettingsField, value: unknown): string | null {
  const { label, fields } = NESTED_SETTINGS_RULES[field];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (!isObject(item)) continue;
    for (const key of Object.keys(item)) if (!Object.hasOwn(fields, key)) return `${label}.${key} is not a writable settings field`;
  }
  return null;
}

const MAX_INT = Number.MAX_SAFE_INTEGER;

/** Whole-number top-level settings: their ONE domain (load clamps into it, saves validate it). */
export const SETTINGS_INT_FIELDS = {
  maxInlineComments: { label: "max_inline_comments", min: 0, max: 20, unit: "count" },
  maxTurns: { label: "max_turns", min: 0, max: 1000, unit: "count" },
  exploreTurns: { label: "explore_turns", min: 0, max: 1000, unit: "count" },
  localReviewMaxTokens: { label: "local_review.max_tokens", min: 1, max: MAX_INT, unit: "count" },
  localReviewSingleTurnMaxTokens: { label: "local_review.single_turn_max_tokens", min: 1, max: MAX_INT, unit: "count" },
  promptDiffMaxChars: { label: "prompt.diff_max_chars", min: 0, max: MAX_INT, unit: "chars" },
  promptContextMaxChars: { label: "prompt.context_max_chars", min: 0, max: MAX_INT, unit: "chars" },
  promptPolicyMaxChars: { label: "prompt.policy_max_chars", min: 0, max: MAX_INT, unit: "chars" },
  contextPadLines: { label: "prompt.context_pad_lines", min: 0, max: MAX_INT, unit: "count" },
} as const satisfies Partial<Record<SettingsField, IntDomain & { label: string }>>;

export type SettingsIntField = keyof typeof SETTINGS_INT_FIELDS;

/** Load-time normalization INTO the domain (a stored / env-seeded value; never used on a save):
 * non-numeric -> `def`, else floored and clamped. */
export function clampInt(d: IntDomain, v: unknown, def: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  return Math.min(d.max, Math.max(d.min, Math.floor(v)));
}

const int = (key: SettingsIntField): Rule => (v) => intProblem(SETTINGS_INT_FIELDS[key].label, SETTINGS_INT_FIELDS[key], v);
const SEVERITIES = ["P0", "P1", "P2"] as const;

/** One rule per writable field. `Record<SettingsField, Rule>` makes a new BotSettings field a type
 * error here until it has a rule, so no field can reach the store unvalidated. */
export const SETTINGS_FIELD_RULES: Readonly<Record<SettingsField, Rule>> = {
  username: nonBlank("bot.username"),
  mention: (v) =>
    Array.isArray(v) && v.length > 0 && v.every((m) => typeof m === "string" && m.trim())
      ? null
      : "mentions must be a non-empty list of non-blank strings",
  skipForks: bool("skip_forks"),
  skipDrafts: bool("skip_drafts"),
  maxInlineComments: int("maxInlineComments"),
  maxTurns: int("maxTurns"),
  exploreTurns: int("exploreTurns"),
  publishMinSeverity: oneOf("publish_min_severity", SEVERITIES),
  requestChangesMin: oneOf("request_changes_min", SEVERITIES),
  precisionOverRecall: bool("precision_over_recall"),
  webhookSecret: text("github.webhook_secret"),
  reviewChatgpt: bool("review_chatgpt"),
  reviewGrok: bool("review_grok"),
  reviewLocal: bool("review_local"),
  fixAgent: fixAgentProblem,
  localJsonRepairEnabled: bool("local_json_repair_enabled"),
  chatgptReasoning: oneOf("chatgpt_reasoning", CHATGPT_REASONING),
  grokReasoning: oneOf("grok_reasoning", GROK_REASONING),
  localLlmBaseUrl: text("local_llm.base_url"),
  localLlmApiKey: text("local_llm.api_key"),
  localLlmModel: text("local_llm.model"),
  localReviewMaxTokens: int("localReviewMaxTokens"),
  localReviewMode: oneOf("local_review.mode", LOCAL_REVIEW_MODES),
  localReviewSingleTurnMaxTokens: int("localReviewSingleTurnMaxTokens"),
  reviewOrder: (v) =>
    Array.isArray(v) && v.length === DEFAULT_REVIEW_ORDER.length && DEFAULT_REVIEW_ORDER.every((p) => v.includes(p))
      ? null
      : `false_positive_check_order must list each of ${DEFAULT_REVIEW_ORDER.join(", ")} exactly once`,
  promptDiffMaxChars: int("promptDiffMaxChars"),
  promptContextMaxChars: int("promptContextMaxChars"),
  promptPolicyMaxChars: int("promptPolicyMaxChars"),
  contextPadLines: int("contextPadLines"),
};

export const SETTINGS_FIELDS = Object.keys(SETTINGS_FIELD_RULES) as SettingsField[];

/** Secret fields: a blank or masked value in a patch means "keep the stored secret" (the screen
 * shows a mask and "Blank keeps the stored key"); any other string replaces it (trimmed). A
 * non-string is invalid like any other field. */
export const SECRET_FIELDS: readonly SettingsField[] = ["webhookSecret", "localLlmApiKey"];

/** Why these settings cannot be saved (null = valid). `raw` is the full document about to be
 * saved (the live settings with the operator's patch merged over them), before normalization.
 * Every present field is checked by its rule (a nested object's unknown keys first —
 * nestedKeysProblem); unknown top-level keys (e.g. the read-only *Set flags the
 * screen's draft carries) are not part of a document's validity — a PATCH with one is rejected by
 * validatedSettingsPatch. */
export function settingsProblem(raw: Partial<BotSettings> | Record<string, unknown>): string | null {
  const r = raw as Record<string, unknown>;
  for (const key of SETTINGS_FIELDS) {
    if (r[key] === undefined) continue;
    const problem = (isNestedField(key) && nestedKeysProblem(key, r[key])) || SETTINGS_FIELD_RULES[key](r[key]);
    if (problem) return problem;
  }
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
 * `patch` is taken RAW (the Settings API passes the request's fields untouched): an unknown or
 * read-only field is rejected, a nested object with a key outside its writable set
 * (NESTED_SETTINGS_RULES) is rejected before any merge, a secret follows SECRET_FIELDS, a nested
 * object (fixAgent) is a partial merged over the live one, and anything else — a non-object fixAgent included — is validated as
 * supplied. Throws SettingsError 400; the caller normalizes, persists, then swaps its live settings. */
export function validatedSettingsPatch<T extends object>(current: T, patch: Partial<T> | Record<string, unknown>): T {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(key)) throw new SettingsError(`${key} is not a writable settings field`, 400);
    if (value === undefined) continue; // absent: a programmatic partial patch
    if (isNestedField(key)) {
      // Strict at every level: a nested key outside the field's writable set is rejected here,
      // before the value is merged over the live one or validated.
      const unknownKey = nestedKeysProblem(key, value);
      if (unknownKey) throw new SettingsError(unknownKey, 400);
    }
    if (SECRET_FIELDS.includes(key as SettingsField)) {
      const problem = SETTINGS_FIELD_RULES[key as SettingsField](value);
      if (problem) throw new SettingsError(problem, 400);
      const secret = (value as string).trim();
      if (secret && !isMaskedSecret(secret)) next[key] = secret;
      continue;
    }
    next[key] = value;
  }
  for (const field of NESTED_FIELDS) {
    const supplied = next[field];
    if (!isObject(supplied)) continue;
    const live = (current as Record<string, unknown>)[field];
    next[field] = { ...(isObject(live) ? live : {}), ...supplied };
  }
  const merged = { ...current, ...next };
  const problem = settingsProblem(merged as Record<string, unknown>);
  if (problem) throw new SettingsError(problem, 400);
  return merged;
}
