import OpenAI from "openai";
import type { BotSettings } from "./types";

export async function runLocalLlm(
  prompt: string,
  settings: BotSettings,
): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  const baseURL = settings.localLlmBaseUrl.trim().replace(/\/$/, "");
  if (!baseURL) return { ok: false, error: "local LLM endpoint is empty" };
  const model = settings.localLlmModel.trim();
  if (!model) return { ok: false, error: "local LLM model is empty" };
  const client = new OpenAI({
    apiKey: settings.localLlmApiKey.trim() || "local",
    baseURL,
    timeout: 180_000,
  });
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are Ashlar. Return ONLY a JSON object. No markdown fences." },
        { role: "user", content: prompt },
      ],
      temperature: 0,
    });
    const raw = res.choices[0]?.message?.content ?? "";
    if (!raw.trim()) return { ok: false, error: "local LLM returned empty" };
    return { ok: true, raw };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 240) };
  }
}
