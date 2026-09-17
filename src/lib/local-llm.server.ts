import type { BotSettings } from "./types";
import { extractChatJson } from "./extract-chat-json";
import { requestLocalJson, requestLocalChat, type LocalChatMessage } from "./local-chat-request.server";

function localConfig(settings: BotSettings) {
  const baseURL = settings.localLlmBaseUrl.trim().replace(/\/$/, "");
  const model = settings.localLlmModel.trim();
  if (!baseURL) return { ok: false as const, error: "local LLM endpoint is empty" };
  if (!model) return { ok: false as const, error: "local LLM model is empty" };
  return { ok: true as const, baseURL, model, apiKey: settings.localLlmApiKey.trim() || "local" };
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
  const call = (messages: LocalChatMessage[]) => requestLocalChat(
    ready.baseURL, ready.apiKey, { model: ready.model, messages, temperature: 0 }, signal,
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
