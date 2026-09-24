import { bridgePromptText } from "./chat-prompt.ts";
import type { BotSettings } from "./types.ts";
import { extractChatJsonParts } from "./extract-chat-json.ts";
import { requestLocalJson, requestLocalChat, type LocalChatMessage, type LocalRequestOptions } from "./local-chat-request.server.ts";

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
    top_k: envNum("ASHLAR_LOCAL_REVIEW_TOP_K", 0),
    presence_penalty: envNum("ASHLAR_LOCAL_REVIEW_PRESENCE_PENALTY", 1.0),
  };
}

// The request body's sampling fields. top_k is a vLLM/omlx extension, NOT a standard OpenAI param, so
// it is sent only when positive — a strict OpenAI-compatible endpoint would 400 on an unknown field.
// Set ASHLAR_LOCAL_REVIEW_TOP_K=0 to omit it. temperature/top_p/presence_penalty/max_tokens are standard.
export function samplingRequestFields(params: LocalGenerationParams): Record<string, number> {
  return {
    temperature: params.temperature,
    top_p: params.top_p,
    presence_penalty: params.presence_penalty,
    max_tokens: params.maxTokens,
    ...(params.top_k > 0 ? { top_k: params.top_k } : {}),
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

/** One local leg's result. `unparsedText` holds every completed model reply that was not review JSON
 * and is not `originalText` (for example the first reply before the one JSON correction): it may carry
 * the real finding, so a held leg's caller keeps it as evidence (heldLocalSalvage), never drops it.
 * `residualReplies` holds, verbatim, every completed reply whose review JSON was accepted although
 * the model also wrote text outside that object (extractChatJsonParts): the accepted JSON does not
 * carry that text, so a held leg does not count the JSON as a verdict (heldLocalUnusable). */
export type LocalLegResult =
  | { ok: true; raw: string; originalText?: string; unparsedText?: string; residualReplies?: string }
  | { ok: false; error: string; originalText?: string; unparsedText?: string };

/** A completed reply canonicalized to its review JSON, keeping the reply when that discarded text. */
function acceptedReply(reply: string): { raw: string; residualReplies?: string } | null {
  const parts = extractChatJsonParts(reply);
  if (!parts) return null;
  return parts.residual ? { raw: parts.json, residualReplies: reply } : { raw: parts.json };
}

export async function runLocalLlm(
  prompt: string,
  settings: BotSettings,
  signal?: AbortSignal,
  opts?: LocalRequestOptions,
): Promise<LocalLegResult> {
  const ready = localConfig(settings);
  if (!ready.ok) return ready;
  prompt = bridgePromptText(prompt); // Native API input remains readable source text, not escaped transport JSON.
  const params = localGenerationParams(settings);
  const call = (messages: LocalChatMessage[]) => requestLocalChat(
    ready.baseURL, ready.apiKey,
    { model: ready.model, messages, ...samplingRequestFields(params) },
    signal,
    opts,
  );
  // The first completed reply, kept outside the try: a correction that then fails (HTTP 500,
  // transport error, liveness or deadline abort) must not lose it.
  let first: string | undefined;
  try {
    const raw = await call([
      { role: "system", content: "You are Ashlar. Return ONLY a JSON object. No markdown fences." },
      { role: "user", content: prompt },
    ]);
    if (!raw.trim()) return { ok: false, error: "local LLM returned empty" };
    const firstJson = acceptedReply(raw);
    if (firstJson) return { ok: true, ...firstJson, originalText: raw };
    first = raw;

    // Exactly one semantic retry, and only after an actual completed non-JSON reply. Do NOT echo the
    // prior reply back: adding it on top of the full prompt and the same max_tokens budget could
    // overflow a finite context window. The retry is the original prompt plus a JSON-only nudge, so
    // it is never larger than the first call (which already fit).
    const raw2 = await call([
      {
        role: "system",
        content: "You are Ashlar. Return ONLY a single JSON object with keys findings, merge_recommendation, keep. No prose, no markdown fences.",
      },
      { role: "user", content: prompt },
      {
        role: "user",
        content: "Your previous reply was not extractable review JSON. Reply again with ONLY the JSON object (findings/merge_recommendation/keep). No markdown.",
      },
    ]);
    const corrected = acceptedReply(raw2);
    // The first reply is kept on both paths: it may carry the real finding the correction (which does
    // not see it) lost, so a held leg posts it as evidence and never counts the correction as a verdict.
    return corrected ? {ok: true, ...corrected, originalText: raw2, unparsedText: raw}
      : {ok: false, error: "local LLM completed without valid review JSON after one correction", originalText: raw2, unparsedText: raw};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 240), ...(first ? { unparsedText: first } : {}) };
  }
}
