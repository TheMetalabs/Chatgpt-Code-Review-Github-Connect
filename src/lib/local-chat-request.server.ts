import http from "node:http";
import https from "node:https";

export type LocalChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatRequest = { model: string; messages: LocalChatMessage[]; temperature: number };

/** No SDK, fetch header/body deadline or automatic replay of a costly generation.
 * Only an actual response, connection failure or explicit caller abort settles it.
 * Upstream servers/proxies may still enforce their own limits.
 */
export function requestLocalChat(
  baseURL: string,
  apiKey: string,
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseURL.replace(/\/$/, "")}/chat/completions`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("local LLM endpoint must use HTTP or HTTPS"));
      return;
    }
    const data = JSON.stringify(body);
    const send = url.protocol === "https:" ? https.request : http.request;
    const req = send(url, {
      method: "POST",
      agent: false,
      timeout: 0,
      signal,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
        authorization: `Bearer ${apiKey || "local"}`,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        // Bound memory, not queue/generation duration.
        if (text.length > 16 * 1024 * 1024) res.destroy(new Error("local LLM response too large"));
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("local LLM response connection closed")));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`local LLM HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
          return;
        }
        try {
          const parsed = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
          const content = parsed.choices?.[0]?.message?.content;
          resolve(typeof content === "string" ? content : "");
        } catch {
          reject(new Error("local LLM returned an invalid JSON response"));
        }
      });
    });
    req.setTimeout(0);
    req.setSocketKeepAlive(true, 30_000);
    req.on("error", reject);
    req.end(data);
  });
}
