import { bridgePromptText } from "./chat-prompt.ts";
import type { BotSettings } from "./types.ts";
import { extractChatJson } from "./extract-chat-json.ts";
import { requestLocalJson, requestLocalChat, type LocalChatMessage } from "./local-chat-request.server.ts";

function localConfig(settings: BotSettings) {
  const baseURL = settings.localLlmBaseUrl.trim().replace(/\/$/, "");
  const model = settings.localLlmModel.trim();
  if (!baseURL) return { ok: false as const, error: "local LLM endpoint is empty" };
  if (!model) return { ok: false as const, error: "local LLM model is empty" };
  return { ok: true as const, baseURL, model, apiKey: settings.localLlmApiKey.trim() || "local" };
}

export type LocalGenerationParams = {
  maxTokens: number;
  temperature: number;
  top_p: number;
  top_k: number;
  presence_penalty: number;
};

function envNum(key: string, dflt: number): number {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const raw = env?.[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// maxTokens is the whole reason the local leg failed on real diffs: without it the server
// defaults the budget to ~8K, which a reasoning model spends on thinking before emitting any
// JSON (finish_reason=length). It comes from settings so it can clear thinking + JSON. Sampling
// is the model's recommended non-greedy set — greedy (t=0) sends thinking models into repetition
// loops — tunable via env without a settings migration.
export function localGenerationParams(settings: BotSettings): LocalGenerationParams {
  const configured = Number(settings.localReviewMaxTokens);
  return {
    maxTokens:
      Number.isFinite(configured) && configured > 0
        ? configured
        : envNum("ASHLAR_LOCAL_REVIEW_MAX_TOKENS", 32_768),
    temperature: envNum("ASHLAR_LOCAL_REVIEW_TEMPERATURE", 0.6),
    top_p: envNum("ASHLAR_LOCAL_REVIEW_TOP_P", 0.95),
    top_k: envNum("ASHLAR_LOCAL_REVIEW_TOP_K", 20),
    presence_penalty: envNum("ASHLAR_LOCAL_REVIEW_PRESENCE_PENALTY", 1.0),
  };
}

/** GET /models only. A busy local endpoint may queue this as well. */
export async function pingLocalLlm(
  settings: BotSettings,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ready = localConfig(settings);
  if (!ready.ok) return ready;
  try {
    await requestLocalJson(ready.baseURL, ready.apiKey, "models", undefined, signal);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 240) };
  }
}

export async function runLocalLlm(
  prompt: string,
  settings: BotSettings,
  signal?: AbortSignal,
): Promise<{ ok: true; raw: string; originalText?: string } | { ok: false; error: string; originalText?: string }> {
  const ready = localConfig(settings);
  if (!ready.ok) return ready;
  prompt = bridgePromptText(prompt); // Native API input remains readable source text, not escaped transport JSON.
  const params = localGenerationParams(settings);
  const call = (messages: LocalChatMessage[]) => requestLocalChat(
    ready.baseURL, ready.apiKey,
    {
      model: ready.model, messages,
      temperature: params.temperature, top_p: params.top_p, top_k: params.top_k,
      presence_penalty: params.presence_penalty, max_tokens: params.maxTokens,
    },
    signal,
  );
  try {
    const raw = await call([
      { role: "system", content: "You are Ashlar. Return ONLY a JSON object. No markdown fences." },
      { role: "user", content: prompt },
    ]);
    if (!raw.trim()) return { ok: false, error: "local LLM returned empty" };
    const firstJson = extractChatJson(raw);
    if (firstJson) return { ok: true, raw: firstJson, originalText: raw };

    // Exactly one semantic retry, and only after an actual completed non-JSON reply.
    const raw2 = await call([
      {
        role: "system",
        content: "You are Ashlar. Return ONLY a single JSON object with keys findings, merge_recommendation, keep. No prose, no markdown fences.",
      },
      { role: "user", content: prompt },
      { role: "assistant", content: raw },
      {
        role: "user",
        content: "Your previous reply was not extractable review JSON. Reply again with ONLY the JSON object (findings/merge_recommendation/keep). No markdown.",
      },
    ]);
    const corrected = extractChatJson(raw2);
    return corrected ? {ok: true, raw: corrected, originalText: raw2}
      : {ok: false, error: "local LLM completed without valid review JSON after one correction", originalText: raw2};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 240) };
  }
}
