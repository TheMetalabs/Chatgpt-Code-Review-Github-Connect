import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { BotSettings } from "./types";
import { extractChatJson } from "./extract-chat-json";

/** Native transport avoids SDK/Fetch header and body deadlines, and SDK automatic retries.
 * Queue/generation may take arbitrarily long. Only explicit cancellation, an actual
 * transport/protocol error, or the completed response can settle this request.
 */
function localRequest(settings: BotSettings, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const base = settings.localLlmBaseUrl.trim().replace(/\/$/, "");
  if (!base) return Promise.reject(new Error("local LLM endpoint is empty"));
  const url = new URL(`${base}/${path}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error("local LLM endpoint must use HTTP or HTTPS"));
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: payload === undefined ? "GET" : "POST",
      agent: false,
      signal,
      headers: {
        authorization: `Bearer ${settings.localLlmApiKey.trim() || "local"}`,
        accept: "application/json",
        "accept-encoding": "identity",
        ...(payload === undefined ? {} : {"content-type": "application/json", "content-length": Buffer.byteLength(payload)}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // Memory bound, not a duration bound. Never store partial review JSON.
        if (bytes > 16 * 1024 * 1024) {
          res.destroy(new Error("local LLM response exceeds 16 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("local LLM connection closed before response completed")));
      res.on("end", () => {
        if (!res.complete) { reject(new Error("local LLM response was incomplete")); return; }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`local LLM HTTP ${res.statusCode ?? "unknown"}`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("local LLM returned an invalid JSON envelope")); }
      });
    });
    // Zero disables the socket timeout in node:http; it is not an SDK timeout:0.
    req.setTimeout(0);
    req.on("socket", socket => socket.setKeepAlive(true, 30_000));
    req.on("error", reject);
    req.end(payload);
  });
}

/** UI liveness probe only. Its result must not decide whether a generation can run. */
export async function pingLocalLlm(settings: BotSettings): Promise<{ok: true} | {ok: false; error: string}> {
  try {
    await localRequest(settings, "models", undefined, AbortSignal.timeout(5_000));
    return {ok: true};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

function completionContent(value: unknown): string {
  const response = value as {choices?: {finish_reason?: string; message?: {content?: unknown}}[]};
  const choice = response?.choices?.[0];
  if (!choice || typeof choice.message?.content !== "string") throw new Error("local LLM returned no completed message");
  if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") {
    throw new Error(`local LLM response ended with ${choice.finish_reason}`);
  }
  return choice.message.content;
}

export async function runLocalLlm(
  prompt: string,
  settings: BotSettings,
  signal?: AbortSignal,
): Promise<{ok: true; raw: string} | {ok: false; error: string}> {
  const model = settings.localLlmModel.trim();
  if (!model) return {ok: false, error: "local LLM model is empty"};
  try {
    const messages = [
      {role: "system", content: "You are Ashlar. Return ONLY one review JSON object. No markdown fences."},
      {role: "user", content: prompt},
    ];
    const first = completionContent(await localRequest(settings, "chat/completions", {model, messages, temperature: 0, stream: false}, signal));
    const json = extractChatJson(first);
    if (json) return {ok: true, raw: json};
    if (!first.trim()) return {ok: false, error: "local LLM completed without a message"};
    // Exactly one correction of a COMPLETED malformed response; never a retry of a pending call.
    const retry = completionContent(await localRequest(settings, "chat/completions", {
      model,
      messages: [...messages, {role: "assistant", content: first}, {
        role: "user", content: "Reply again with ONLY one JSON object containing findings, merge_recommendation, keep. No prose or markdown.",
      }],
      temperature: 0,
      stream: false,
    }, signal));
    const corrected = extractChatJson(retry);
    return corrected ? {ok: true, raw: corrected} : {ok: false, error: "local LLM completed without valid review JSON after one correction"};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {ok: false, error: message.slice(0, 240)};
  }
}
