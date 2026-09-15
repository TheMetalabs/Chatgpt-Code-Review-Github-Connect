import OpenAI from "openai";
import type { BotSettings } from "./types";
import { extractChatJson } from "./extract-chat-json";

function localClient(settings: BotSettings, timeout: number) {
  const baseURL = settings.localLlmBaseUrl.trim().replace(/\/$/, "");
  const model = settings.localLlmModel.trim();
  if (!baseURL) return { ok: false as const, error: "local LLM endpoint is empty" };
  if (!model) return { ok: false as const, error: "local LLM model is empty" };
  return {
    ok: true as const,
    model,
    client: new OpenAI({
      apiKey: settings.localLlmApiKey.trim() || "local",
      baseURL,
      timeout,
    }),
  };
}

/** Cheap liveness check. GET /models only — never enqueue a generate. */
export async function pingLocalLlm(
  settings: BotSettings,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ready = localClient(settings, 5_000);
  if (!ready.ok) return ready;
  try {
    await ready.client.models.list();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 240) };
  }
}

function bestExtractableRaw(raw: string): string {
  const hit = extractChatJson(raw);
  return hit ?? raw;
}

export async function runLocalLlm(
  prompt: string,
  settings: BotSettings,
): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  const ready = localClient(settings, 600_000);
  if (!ready.ok) return ready;
  try {
    const first = await ready.client.chat.completions.create({
      model: ready.model,
      messages: [
        { role: "system", content: "You are Ashlar. Return ONLY a JSON object. No markdown fences." },
        { role: "user", content: prompt },
      ],
      temperature: 0,
    });
    let raw = first.choices[0]?.message?.content ?? "";
    if (!raw.trim()) return { ok: false, error: "local LLM returned empty" };
    if (extractChatJson(raw)) return { ok: true, raw: bestExtractableRaw(raw) };

    const retry = await ready.client.chat.completions.create({
      model: ready.model,
      messages: [
        {
          role: "system",
          content:
            "You are Ashlar. Return ONLY a single JSON object with keys findings, merge_recommendation, keep. No prose, no markdown fences.",
        },
        { role: "user", content: prompt },
        { role: "assistant", content: raw },
        {
          role: "user",
          content:
            "Your previous reply was not extractable review JSON. Reply again with ONLY the JSON object (findings/merge_recommendation/keep). No markdown.",
        },
      ],
      temperature: 0,
    });
    const raw2 = retry.choices[0]?.message?.content ?? "";
    if (extractChatJson(raw2)) return { ok: true, raw: bestExtractableRaw(raw2) };
    // Store the best extractable candidate when possible (prefer longer non-empty).
    const best = (extractChatJson(raw2) && raw2) || (extractChatJson(raw) && raw) || raw2.trim() || raw;
    return { ok: true, raw: bestExtractableRaw(best) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 240) };
  }
}
