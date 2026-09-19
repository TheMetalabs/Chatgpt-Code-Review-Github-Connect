import http from "node:http";
import https from "node:https";

export type LocalChatMessage = { role: "system" | "user" | "assistant"; content: string };
// max_tokens is REQUIRED in practice: omlx/vLLM-style servers default the completion budget
// to ~8K, which a reasoning model burns entirely on thinking for any real diff, ending the
// response with finish_reason=length before it ever emits review JSON. Callers set it from the
// context budget. Sampling fields carry the model's recommended (non-greedy) values; greedy
// decoding sends thinking models into verbatim repetition loops.
type ChatRequest = {
  model: string;
  messages: LocalChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  max_tokens?: number;
};

/** Shared native transport. No SDK/fetch deadline and no automatic network replay.
 * A caller may explicitly cancel; upstream servers/proxies may impose their own limits.
 * Health checks and generation create no deadline; only explicit cancellation may supply a signal.
 */
export function requestLocalJson(
  baseURL: string,
  apiKey: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseURL.replace(/\/$/, "")}/${path}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("local LLM endpoint must use HTTP or HTTPS"));
      return;
    }
    const data = body === undefined ? undefined : JSON.stringify(body);
    const send = url.protocol === "https:" ? https.request : http.request;
    const req = send(url, {
      method: data === undefined ? "GET" : "POST",
      agent: false,
      timeout: 0,
      signal,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        ...(data === undefined ? {} : {"content-type": "application/json", "content-length": Buffer.byteLength(data)}),
        authorization: `Bearer ${apiKey || "local"}`,
      },
    }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // Bound memory, never queue/generation duration; don't store partial reviews.
        if (bytes > 16 * 1024 * 1024) { res.destroy(new Error("local LLM response too large")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("local LLM response connection closed")));
      res.on("end", () => {
        if (!res.complete) { reject(new Error("local LLM response was incomplete")); return; }
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`local LLM HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error("local LLM returned an invalid JSON response")); }
      });
    });
    req.setTimeout(0);
    req.setSocketKeepAlive(true, 30_000);
    req.on("error", reject);
    req.end(data);
  });
}

export async function requestLocalChat(
  baseURL: string,
  apiKey: string,
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = await requestLocalJson(baseURL, apiKey, "chat/completions", {...body, stream: false}, signal) as
    { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
  const choice = parsed?.choices?.[0];
  if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter") {
    throw new Error(`local LLM response ended with ${choice.finish_reason}`);
  }
  if (typeof choice?.message?.content !== "string") throw new Error("local LLM returned no completed message");
  return choice.message.content;
}
