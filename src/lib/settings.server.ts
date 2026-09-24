import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadDotenvFile, writeEnvPatch } from "./dotenv-file.server.ts";
import {
  DEFAULT_SETTINGS,
  FIX_AGENT_KNOBS,
  FIX_AGENT_PROVIDERS,
  FIX_DELIVERIES,
  FIX_MODES,
  LOCAL_REVIEW_MODES,
  fixKnob,
  normalizeReviewOrder,
  providersFromSettings,
  type BotSettings,
  type FixAgentKnob,
  type FixAgentProvider,
  type FixDelivery,
  type FixMode,
  type LocalReviewMode,
  type ReviewProvider,
  type Severity,
} from "./types.ts";
import { SettingsError, fixPairCompatible, settingsProblem } from "./settings-rules.ts";
import { normalizeChatgptReasoning, normalizeGrokReasoning } from "./reasoning.ts";

function envStr(key: string): string | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function envFlag(key: string): boolean | undefined {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function envNum(key: string): number | undefined {
  const v = envStr(key);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function overlayEnv(base: Record<string, unknown>): Record<string, unknown> {
  const o = { ...base };
  const username = envStr("ASHLAR_USERNAME");
  if (username) o.username = username;
  const mention = envStr("ASHLAR_MENTION");
  if (mention) o.mention = mention.split(",").map((s) => s.trim()).filter(Boolean);
  const skipForks = envFlag("ASHLAR_SKIP_FORKS");
  if (skipForks !== undefined) o.skipForks = skipForks;
  const skipDrafts = envFlag("ASHLAR_SKIP_DRAFTS");
  if (skipDrafts !== undefined) o.skipDrafts = skipDrafts;
  const maxInline = envNum("ASHLAR_MAX_INLINE_COMMENTS");
  if (maxInline !== undefined) o.maxInlineComments = maxInline;
  const maxTurns = envNum("ASHLAR_MAX_TURNS");
  if (maxTurns !== undefined) o.maxTurns = maxTurns;
  const explore = envNum("ASHLAR_EXPLORE_TURNS");
  if (explore !== undefined) o.exploreTurns = explore;
  const pub = envStr("ASHLAR_PUBLISH_MIN_SEVERITY");
  if (pub) o.publishMinSeverity = pub;
  const req = envStr("ASHLAR_REQUEST_CHANGES_MIN");
  if (req) o.requestChangesMin = req;
  const precision = envFlag("ASHLAR_PRECISION_OVER_RECALL");
  if (precision !== undefined) o.precisionOverRecall = precision;
  const demoSecret = envStr("ASHLAR_WEBHOOK_SECRET");
  if (demoSecret) o.webhookSecret = demoSecret;
  const chatgpt = envFlag("ASHLAR_REVIEW_CHATGPT");
  if (chatgpt !== undefined) o.reviewChatgpt = chatgpt;
  const grok = envFlag("ASHLAR_REVIEW_GROK");
  if (grok !== undefined) o.reviewGrok = grok;
  const local = envFlag("ASHLAR_REVIEW_LOCAL");
  if (local !== undefined) o.reviewLocal = local;
  const repair = envFlag("ASHLAR_LOCAL_JSON_REPAIR_ENABLED");
  if (repair !== undefined) o.localJsonRepairEnabled = repair;
  const baseUrl = envStr("ASHLAR_LOCAL_LLM_BASE_URL");
  if (baseUrl) o.localLlmBaseUrl = baseUrl;
  const model = envStr("ASHLAR_LOCAL_LLM_MODEL");
  if (model) o.localLlmModel = model;
  const key = process.env.ASHLAR_LOCAL_LLM_API_KEY;
  if (key !== undefined && key !== "") o.localLlmApiKey = key;
  const localMaxTokens = envNum("ASHLAR_LOCAL_REVIEW_MAX_TOKENS");
  if (localMaxTokens !== undefined) o.localReviewMaxTokens = localMaxTokens;
  const localMode = envStr("ASHLAR_LOCAL_REVIEW_MODE");
  if (localMode) o.localReviewMode = localMode as LocalReviewMode;
  const localSingleTurnMax = envNum("ASHLAR_LOCAL_REVIEW_SINGLE_TURN_MAX_TOKENS");
  if (localSingleTurnMax !== undefined) o.localReviewSingleTurnMaxTokens = localSingleTurnMax;
  const order = envStr("ASHLAR_REVIEW_ORDER");
  if (order) o.reviewOrder = order.split(",").map((s) => s.trim());
  const chatgptReasoning = envStr("ASHLAR_CHATGPT_REASONING");
  if (chatgptReasoning) o.chatgptReasoning = chatgptReasoning;
  const grokReasoning = envStr("ASHLAR_GROK_REASONING");
  if (grokReasoning) o.grokReasoning = grokReasoning;
  const promptDiffMax = envNum("ASHLAR_PROMPT_DIFF_MAX_CHARS");
  if (promptDiffMax !== undefined) o.promptDiffMaxChars = promptDiffMax;
  const promptContextMax = envNum("ASHLAR_PROMPT_CONTEXT_MAX_CHARS");
  if (promptContextMax !== undefined) o.promptContextMaxChars = promptContextMax;
  const promptPolicyMax = envNum("ASHLAR_PROMPT_POLICY_MAX_CHARS");
  if (promptPolicyMax !== undefined) o.promptPolicyMaxChars = promptPolicyMax;
  // Fix agent: env SEEDS these fields only until the operator saves Settings — a saved fixAgent
  // wins at load (diskFixAgentWins). `enabled` has NO env var: the Settings screen is the only
  // switch for the review loop. The provider is read EMPTY-PRESERVING (not via envStr, which
  // collapses "" -> undefined): an explicit ASHLAR_FIX_PROVIDER="" seeds "no provider".
  const fixProviderRaw = process.env.ASHLAR_FIX_PROVIDER;
  const fixDelivery = envStr("ASHLAR_FIX_DELIVERY");
  const fixMode = envStr("ASHLAR_FIX_MODE");
  const fixKnobs: Record<string, number> = {};
  for (const [key, knob] of Object.entries(FIX_AGENT_KNOBS)) {
    const n = envNum(knob.env);
    if (n !== undefined) fixKnobs[key] = n;
  }
  if (fixProviderRaw !== undefined || fixDelivery || fixMode || Object.keys(fixKnobs).length) {
    const baseFix = (o.fixAgent as Record<string, unknown> | undefined) ?? {};
    o.fixAgent = {
      ...baseFix,
      provider:
        fixProviderRaw !== undefined ? (fixProviderRaw.trim() === "" ? null : fixProviderRaw.trim()) : baseFix.provider,
      ...(fixDelivery ? { delivery: fixDelivery } : {}),
      ...(fixMode ? { mode: fixMode } : {}),
      ...fixKnobs,
    };
  }
  const contextPad = envNum("ASHLAR_CONTEXT_PAD_LINES");
  if (contextPad !== undefined) o.contextPadLines = contextPad;
  return o;
}

export function botSettingsToEnv(s: BotSettings): Record<string, string> {
  return {
    ASHLAR_USERNAME: s.username,
    ASHLAR_MENTION: s.mention.join(","),
    ASHLAR_SKIP_FORKS: String(s.skipForks),
    ASHLAR_SKIP_DRAFTS: String(s.skipDrafts),
    ASHLAR_MAX_INLINE_COMMENTS: String(s.maxInlineComments),
    ASHLAR_MAX_TURNS: String(s.maxTurns),
    ASHLAR_EXPLORE_TURNS: String(s.exploreTurns),
    ASHLAR_PUBLISH_MIN_SEVERITY: s.publishMinSeverity,
    ASHLAR_REQUEST_CHANGES_MIN: s.requestChangesMin,
    ASHLAR_PRECISION_OVER_RECALL: String(s.precisionOverRecall),
    ASHLAR_WEBHOOK_SECRET: s.webhookSecret,
    ASHLAR_REVIEW_CHATGPT: String(s.reviewChatgpt),
    ASHLAR_REVIEW_GROK: String(s.reviewGrok),
    ASHLAR_REVIEW_LOCAL: String(s.reviewLocal),
    ASHLAR_LOCAL_JSON_REPAIR_ENABLED: String(s.localJsonRepairEnabled),
    ASHLAR_LOCAL_LLM_BASE_URL: s.localLlmBaseUrl,
    ASHLAR_LOCAL_LLM_MODEL: s.localLlmModel,
    ASHLAR_LOCAL_LLM_API_KEY: s.localLlmApiKey,
    ASHLAR_LOCAL_REVIEW_MAX_TOKENS: String(s.localReviewMaxTokens),
    ASHLAR_LOCAL_REVIEW_MODE: s.localReviewMode,
    ASHLAR_LOCAL_REVIEW_SINGLE_TURN_MAX_TOKENS: String(s.localReviewSingleTurnMaxTokens),
    ASHLAR_REVIEW_ORDER: s.reviewOrder.join(","),
    ASHLAR_CHATGPT_REASONING: s.chatgptReasoning,
    ASHLAR_GROK_REASONING: s.grokReasoning,
    ASHLAR_PROMPT_DIFF_MAX_CHARS: String(s.promptDiffMaxChars),
    ASHLAR_PROMPT_CONTEXT_MAX_CHARS: String(s.promptContextMaxChars),
    ASHLAR_PROMPT_POLICY_MAX_CHARS: String(s.promptPolicyMaxChars),
    ASHLAR_CONTEXT_PAD_LINES: String(s.contextPadLines),
    // fixAgent is deliberately NOT mirrored (no field of it): the settings JSON is its only
    // durable store, and a saved fixAgent wins over env at load (diskFixAgentWins). An env
    // ASHLAR_FIX_* var only seeds a field that was never saved; no env var can switch the loop on.
  };
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function severity(v: unknown, fallback: Severity): Severity {
  return v === "P0" || v === "P1" || v === "P2" ? v : fallback;
}

function normalizeFixAgent(raw: unknown): BotSettings["fixAgent"] {
  const d = DEFAULT_SETTINGS.fixAgent;
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let provider = FIX_AGENT_PROVIDERS.includes(p.provider as FixAgentProvider) ? (p.provider as FixAgentProvider) : d.provider;
  let delivery = FIX_DELIVERIES.includes(p.delivery as FixDelivery) ? (p.delivery as FixDelivery) : d.delivery;
  const mode = FIX_MODES.includes(p.mode as FixMode) ? (p.mode as FixMode) : d.mode;
  // Only a literal true enables the loop ("true", 1, … stay off): the switch fails closed.
  const enabled = p.enabled === true;
  // Load-time normalization of a stored document (a save is VALIDATED first — settings-rules —
  // and never reaches here with an incompatible pair): an incompatible pair (design §6b matrix)
  // has no execution path, so it disables the fix agent (provider=null), failing closed.
  if (provider !== null && !fixPairCompatible(provider, delivery)) {
    provider = null;
    delivery = d.delivery;
  }
  const knobs = Object.fromEntries(
    (Object.keys(FIX_AGENT_KNOBS) as FixAgentKnob[]).map((key) => [key, fixKnob({ [key]: num(p[key], FIX_AGENT_KNOBS[key].def) }, key)]),
  ) as Record<FixAgentKnob, number>;
  return { enabled, provider, delivery, mode, ...knobs };
}

export function sanitizeBotSettings(raw: unknown): BotSettings {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const mention = Array.isArray(p.mention)
    ? p.mention.map((m) => String(m).trim()).filter(Boolean)
    : [...DEFAULT_SETTINGS.mention];
  const next: BotSettings = {
    ...DEFAULT_SETTINGS,
    username: str(p.username, DEFAULT_SETTINGS.username).trim() || DEFAULT_SETTINGS.username,
    mention: mention.length ? mention : [...DEFAULT_SETTINGS.mention],
    skipForks: bool(p.skipForks, DEFAULT_SETTINGS.skipForks),
    skipDrafts: bool(p.skipDrafts, DEFAULT_SETTINGS.skipDrafts),
    maxInlineComments: Math.max(0, Math.min(20, Math.floor(num(p.maxInlineComments, DEFAULT_SETTINGS.maxInlineComments)))),
    maxTurns: num(p.maxTurns, DEFAULT_SETTINGS.maxTurns),
    exploreTurns: num(p.exploreTurns, DEFAULT_SETTINGS.exploreTurns),
    publishMinSeverity: severity(p.publishMinSeverity, DEFAULT_SETTINGS.publishMinSeverity),
    requestChangesMin: severity(p.requestChangesMin, DEFAULT_SETTINGS.requestChangesMin),
    precisionOverRecall: bool(p.precisionOverRecall, DEFAULT_SETTINGS.precisionOverRecall),
    webhookSecret: str(p.webhookSecret, DEFAULT_SETTINGS.webhookSecret),
    reviewChatgpt: bool(p.reviewChatgpt, DEFAULT_SETTINGS.reviewChatgpt),
    reviewGrok: bool(p.reviewGrok, DEFAULT_SETTINGS.reviewGrok),
    reviewLocal: bool(p.reviewLocal, DEFAULT_SETTINGS.reviewLocal),
    fixAgent: normalizeFixAgent(p.fixAgent),
    localJsonRepairEnabled: bool(p.localJsonRepairEnabled, DEFAULT_SETTINGS.localJsonRepairEnabled),
    localLlmBaseUrl: str(p.localLlmBaseUrl, DEFAULT_SETTINGS.localLlmBaseUrl).trim(),
    localLlmApiKey: str(p.localLlmApiKey, DEFAULT_SETTINGS.localLlmApiKey),
    localLlmModel: str(p.localLlmModel, DEFAULT_SETTINGS.localLlmModel).trim(),
    localReviewMaxTokens: Math.max(1, Math.floor(num(p.localReviewMaxTokens, DEFAULT_SETTINGS.localReviewMaxTokens))),
    localReviewMode: LOCAL_REVIEW_MODES.includes(p.localReviewMode as LocalReviewMode)
      ? (p.localReviewMode as LocalReviewMode)
      : DEFAULT_SETTINGS.localReviewMode,
    localReviewSingleTurnMaxTokens: Math.max(1, Math.floor(num(p.localReviewSingleTurnMaxTokens, DEFAULT_SETTINGS.localReviewSingleTurnMaxTokens))),
    reviewOrder: normalizeReviewOrder(p.reviewOrder as ReviewProvider[] | undefined),
    chatgptReasoning: normalizeChatgptReasoning(p.chatgptReasoning),
    grokReasoning: normalizeGrokReasoning(p.grokReasoning),
    promptDiffMaxChars: Math.max(0, Math.floor(num(p.promptDiffMaxChars, DEFAULT_SETTINGS.promptDiffMaxChars))),
    promptContextMaxChars: Math.max(0, Math.floor(num(p.promptContextMaxChars, DEFAULT_SETTINGS.promptContextMaxChars))),
    promptPolicyMaxChars: Math.max(0, Math.floor(num(p.promptPolicyMaxChars, DEFAULT_SETTINGS.promptPolicyMaxChars))),
    contextPadLines: Math.max(0, Math.floor(num(p.contextPadLines, DEFAULT_SETTINGS.contextPadLines))),
  };
  if (!providersFromSettings(next).length) next.reviewChatgpt = true;
  return next;
}

function settingsPath() {
  return join(process.cwd(), ".data", "ashlar-settings.json");
}

/** PR #4 / Studio path — still read so pm2 boxes that already saved here keep their LLM config. */
function legacySettingsPath() {
  return join(process.cwd(), ".data", "ashlar-bot-settings.json");
}

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Atomic: a crash or a full disk mid-write leaves the previous file intact, never a torn one. */
function writeJson(path: string, value: BotSettings) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the tmp file may not exist */
    }
    throw e;
  }
}

function readDiskSettings(): Record<string, unknown> {
  return { ...readJsonObject(legacySettingsPath()), ...readJsonObject(settingsPath()) };
}

/** Do not copy env-only secrets onto disk. Env remains the source until the operator types a key in Settings. */
export function persistableSettings(next: BotSettings, env: NodeJS.Dict<string> = process.env, disk: Record<string, unknown> = readDiskSettings()): BotSettings {
  const out = { ...next };
  const envKey = env.ASHLAR_LOCAL_LLM_API_KEY;
  if (envKey && out.localLlmApiKey === envKey && disk.localLlmApiKey !== envKey) {
    out.localLlmApiKey = typeof disk.localLlmApiKey === "string" ? disk.localLlmApiKey : "";
  }
  const envSecret = env.ASHLAR_WEBHOOK_SECRET;
  if (envSecret && out.webhookSecret === envSecret && disk.webhookSecret !== envSecret) {
    out.webhookSecret = typeof disk.webhookSecret === "string" ? disk.webhookSecret : DEFAULT_SETTINGS.webhookSecret;
  }
  return sanitizeBotSettings(out);
}

export function diskReviewerFlagsWin(disk: Record<string, unknown>, merged: Record<string, unknown>): Record<string, unknown> {
  const out = { ...merged };
  for (const key of ["reviewChatgpt", "reviewGrok", "reviewLocal", "localJsonRepairEnabled"] as const) {
    if (typeof disk[key] === "boolean") out[key] = disk[key];
  }
  return out;
}

/** A saved fixAgent wins over the env seed field by field: the Settings screen, not a process
 * env var, operates the review loop (env only fills what was never saved). */
export function diskFixAgentWins(disk: Record<string, unknown>, merged: Record<string, unknown>): Record<string, unknown> {
  const saved = disk.fixAgent;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return merged;
  const seeded = merged.fixAgent && typeof merged.fixAgent === "object" ? (merged.fixAgent as Record<string, unknown>) : {};
  return { ...merged, fixAgent: { ...seeded, ...(saved as Record<string, unknown>) } };
}

export function loadBotSettings(): BotSettings {
  loadDotenvFile();
  const disk = readDiskSettings();
  return sanitizeBotSettings(diskFixAgentWins(disk, diskReviewerFlagsWin(disk, overlayEnv(disk))));
}

/**
 * Validate and persist a Settings save. The settings JSON (.data/ashlar-settings.json) is the ONE
 * durable store: it must be written for the save to count. If it cannot be written the save FAILS
 * (SettingsError 500) and nothing else is touched — no .env patch — so the caller keeps its live
 * settings and the operator sees the error; after a restart load returns the last successful save.
 * The legacy JSON copy and the .env mirror are supplemental (best effort): load reads the primary
 * JSON over both (readDiskSettings, diskFixAgentWins). A document the rules reject (settings-rules)
 * throws SettingsError 400 before anything is written.
 */
export function saveBotSettings(settings: BotSettings) {
  const problem = settingsProblem(settings);
  if (problem) throw new SettingsError(problem, 400);
  const runtime = sanitizeBotSettings(settings);
  const disk = persistableSettings(runtime);
  try {
    writeJson(settingsPath(), disk);
  } catch (e) {
    const why = e instanceof Error && "code" in e ? ` (${String((e as NodeJS.ErrnoException).code)})` : "";
    throw new SettingsError(`could not save settings: ${settingsPath()} is not writable${why}; nothing was changed`, 500);
  }
  try {
    writeJson(legacySettingsPath(), disk);
  } catch {
    /* supplemental: the primary JSON is read over the legacy copy */
  }
  try {
    const envPatch: Record<string, string | undefined> = botSettingsToEnv(disk);
    if (runtime.localLlmApiKey && runtime.localLlmApiKey === process.env.ASHLAR_LOCAL_LLM_API_KEY) {
      envPatch.ASHLAR_LOCAL_LLM_API_KEY = undefined;
    }
    if (runtime.webhookSecret && runtime.webhookSecret === process.env.ASHLAR_WEBHOOK_SECRET) {
      envPatch.ASHLAR_WEBHOOK_SECRET = undefined;
    }
    writeEnvPatch(envPatch);
  } catch {
    /* supplemental: the JSON is the durable store */
  }
  return runtime;
}
