import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_SETTINGS,
  normalizeReviewOrder,
  providersFromSettings,
  type BotSettings,
  type ReviewProvider,
  type Severity,
} from "./types.ts";

function settingsPath() {
  return join(process.cwd(), ".data", "ashlar-settings.json");
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
    localLlmBaseUrl: str(p.localLlmBaseUrl, DEFAULT_SETTINGS.localLlmBaseUrl).trim(),
    localLlmApiKey: str(p.localLlmApiKey, DEFAULT_SETTINGS.localLlmApiKey),
    localLlmModel: str(p.localLlmModel, DEFAULT_SETTINGS.localLlmModel).trim(),
    reviewOrder: normalizeReviewOrder(p.reviewOrder as ReviewProvider[] | undefined),
  };
  if (!providersFromSettings(next).length) next.reviewChatgpt = true;
  return next;
}

export function loadBotSettings(): BotSettings {
  try {
    return sanitizeBotSettings(JSON.parse(readFileSync(settingsPath(), "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveBotSettings(settings: BotSettings) {
  const next = sanitizeBotSettings(settings);
  const dir = dirname(settingsPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}
