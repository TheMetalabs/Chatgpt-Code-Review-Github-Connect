import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadDotenvFile, writeEnvPatch } from "./dotenv-file.server.ts";
import {
  DEFAULT_SETTINGS,
  normalizeReviewOrder,
  providersFromSettings,
  type BotSettings,
  type ReviewProvider,
  type Severity,
} from "./types.ts";
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

function overlayEnv(base: Record<string, unknown>): Record<string, unknown> {
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
  const order = envStr("ASHLAR_REVIEW_ORDER");
  if (order) o.reviewOrder = order.split(",").map((s) => s.trim());
  const chatgptReasoning = envStr("ASHLAR_CHATGPT_REASONING");
  if (chatgptReasoning) o.chatgptReasoning = chatgptReasoning;
  const grokReasoning = envStr("ASHLAR_GROK_REASONING");
  if (grokReasoning) o.grokReasoning = grokReasoning;
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
    ASHLAR_REVIEW_ORDER: s.reviewOrder.join(","),
    ASHLAR_CHATGPT_REASONING: s.chatgptReasoning,
    ASHLAR_GROK_REASONING: s.grokReasoning,
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
    localJsonRepairEnabled: bool(p.localJsonRepairEnabled, DEFAULT_SETTINGS.localJsonRepairEnabled),
    localLlmBaseUrl: str(p.localLlmBaseUrl, DEFAULT_SETTINGS.localLlmBaseUrl).trim(),
    localLlmApiKey: str(p.localLlmApiKey, DEFAULT_SETTINGS.localLlmApiKey),
    localLlmModel: str(p.localLlmModel, DEFAULT_SETTINGS.localLlmModel).trim(),
    reviewOrder: normalizeReviewOrder(p.reviewOrder as ReviewProvider[] | undefined),
    chatgptReasoning: normalizeChatgptReasoning(p.chatgptReasoning),
    grokReasoning: normalizeGrokReasoning(p.grokReasoning),
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

function writeJson(path: string, value: BotSettings) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

export function loadBotSettings(): BotSettings {
  loadDotenvFile();
  const disk = readDiskSettings();
  return sanitizeBotSettings(diskReviewerFlagsWin(disk, overlayEnv(disk)));
}

export function saveBotSettings(settings: BotSettings) {
  const runtime = sanitizeBotSettings(settings);
  const disk = persistableSettings(runtime);
  let persisted = false;
  try {
    writeJson(settingsPath(), disk);
    writeJson(legacySettingsPath(), disk);
    persisted = true;
  } catch {
    /* env file may still succeed */
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
    persisted = true;
  } catch {
    /* json may still have been written */
  }
  if (!persisted) throw new Error("settings persist failed");
  return runtime;
}


