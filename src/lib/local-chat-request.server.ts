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
  /** Non-OpenAI extension (vLLM/omlx chat templates, e.g. {enable_thinking:false}); callers send it
   * only when the operator opted in, since a strict server may reject it. */
  chat_template_kwargs?: Record<string, unknown>;
};

/** The server finished the reply early; `finishReason` says why ("length": the token budget ran out). */
export class LocalChatCutOff extends Error {
  readonly finishReason: string;
  constructor(finishReason: string) {
    super(`local LLM response ended with ${finishReason}`);
    this.name = "LocalChatCutOff";
    this.finishReason = finishReason;
  }
}

/** The server refused the request with a non-2xx status before any reply existed. */
export class LocalChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`local LLM HTTP ${status}: ${body.slice(0, 160)}`);
    this.name = "LocalChatHttpError";
    this.status = status;
  }
}

/** What the transport observed on an in-flight request.
 * `keepalive`: the server answered (response headers, or an empty heartbeat chunk) but has produced
 * no output for THIS request yet — it is alive and the request is queued or still prefilling.
 * `output`: tokens (reasoning, content or a tool call) arrived — the model is generating for us.
 * A concurrency-1 local server serves other jobs first, so "queued for an hour" and "hung" look
 * identical without this signal; it is what lets the operator tell the two apart. */
export type LocalRequestActivity = { kind: "keepalive" | "output"; at: number };

export type LocalRequestOptions = {
  onActivity?: (activity: LocalRequestActivity) => void;
  /** Wire-level streaming for chat/completions. Default: ASHLAR_LOCAL_LLM_STREAM, on unless "false". */
  stream?: boolean;
};

/** The env-configured streaming default (on unless ASHLAR_LOCAL_LLM_STREAM="false"). Exported so the
 * caller can match its liveness policy to the transport: incremental keepalives only exist while
 * streaming, so a silence-based abort is only meaningful then. */
export function localStreamingDefault(
  env: Record<string, string | undefined> | undefined = typeof process !== "undefined" ? process.env : undefined,
): boolean {
  return env?.ASHLAR_LOCAL_LLM_STREAM !== "false";
}

function streamingEnabled(opts?: LocalRequestOptions): boolean {
  if (opts?.stream !== undefined) return opts.stream;
  return localStreamingDefault();
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

type ToolCallDelta = { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } };
type StreamChunk = {
  id?: string;
  model?: string;
  created?: number;
  usage?: unknown;
  choices?: { delta?: { role?: string; content?: unknown; reasoning_content?: unknown; tool_calls?: ToolCallDelta[] }; finish_reason?: string | null }[];
};

/** Reassembles chat.completion.chunk deltas into the non-streaming chat.completion shape, so every
 * caller keeps reading `choices[0].message` / `finish_reason` / `usage` exactly as before. Streaming
 * is a transport detail whose only visible effect is the activity signal. */
class StreamAssembler {
  private id?: string;
  private model?: string;
  private created?: number;
  private usage?: unknown;
  private content = "";
  private reasoning = "";
  private finish: string | null = null;
  private readonly tools = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();

  /** Returns what this chunk was: real output, or a heartbeat with nothing in it. */
  apply(chunk: StreamChunk): LocalRequestActivity["kind"] {
    if (chunk.usage !== undefined && chunk.usage !== null) this.usage = chunk.usage;
    if (chunk.model !== "keepalive") {
      if (chunk.id) this.id = chunk.id;
      if (chunk.model) this.model = chunk.model;
      if (typeof chunk.created === "number") this.created = chunk.created;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    let output = false;
    if (typeof delta.content === "string" && delta.content.length) { this.content += delta.content; output = true; }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) { this.reasoning += delta.reasoning_content; output = true; }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      output = true;
      delta.tool_calls.forEach((tc, order) => {
        const index = typeof tc?.index === "number" ? tc.index : this.tools.size + order;
        const entry = this.tools.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc?.id) entry.id = tc.id;
        if (tc?.type) entry.type = tc.type;
        if (tc?.function?.name) entry.function.name = tc.function.name;
        if (typeof tc?.function?.arguments === "string") entry.function.arguments += tc.function.arguments;
        this.tools.set(index, entry);
      });
    }
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) this.finish = choice.finish_reason;
    return output ? "output" : "keepalive";
  }

  get finished(): boolean { return this.finish !== null; }

  result(): unknown {
    const toolCalls = [...this.tools.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        finish_reason: this.finish,
        message: {
          role: "assistant",
          content: this.content,
          ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      }],
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }
}

/** Shared native transport. No SDK/fetch deadline and no automatic network replay.
 * A caller may explicitly cancel; upstream servers/proxies may impose their own limits.
 * Health checks and generation create no deadline; only explicit cancellation may supply a signal.
 *
 * chat/completions is streamed on the wire (unless disabled) and reassembled into the non-streaming
 * response shape; a server that ignores `stream` and answers with plain JSON is handled the same way.
 */
export function requestLocalJson(
  baseURL: string,
  apiKey: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  opts?: LocalRequestOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseURL.replace(/\/$/, "")}/${path}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("local LLM endpoint must use HTTP or HTTPS"));
      return;
    }
    const chat = path === "chat/completions" && body !== undefined && body !== null && typeof body === "object";
    const stream = chat && streamingEnabled(opts);
    const payload = chat
      ? (stream
        ? { ...(body as object), stream: true, stream_options: { include_usage: true } }
        : { ...(body as object), stream: false })
      : body;
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const send = url.protocol === "https:" ? https.request : http.request;
    const activity = (kind: LocalRequestActivity["kind"]) => opts?.onActivity?.({ kind, at: Date.now() });
    const req = send(url, {
      method: data === undefined ? "GET" : "POST",
      agent: false,
      timeout: 0,
      signal,
      headers: {
        accept: stream ? "text/event-stream, application/json" : "application/json",
        "accept-encoding": "identity",
        ...(data === undefined ? {} : {"content-type": "application/json", "content-length": Buffer.byteLength(data)}),
        authorization: `Bearer ${apiKey || "local"}`,
      },
    }, res => {
      const ok = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
      const sse = ok && stream && /^text\/event-stream/i.test(String(res.headers["content-type"] || ""));
      if (ok) activity("keepalive");
      // A buffered chat response (streaming off, or the server ignored `stream` and answered JSON)
      // holds the socket open while it generates and emits no incremental tokens, so there is no later
      // signal to distinguish. Report it as generating from headers — the honest label for "the server
      // accepted and is now producing this reply" — rather than leaving it stuck at "queued".
      if (ok && chat && !sse) activity("output");
      const chunks: Buffer[] = [];
      let bytes = 0;
      const assembler = sse ? new StreamAssembler() : null;
      let pending = "";
      let failed: Error | null = null;
      const onLine = (line: string) => {
        if (!assembler || !line.startsWith("data:")) return; // comments / event: / blank lines carry nothing
        const text = line.slice(5).trim();
        if (!text) return;
        if (text === "[DONE]") return; // terminal marker; completion is decided by finish_reason
        let chunk: StreamChunk;
        try { chunk = JSON.parse(text) as StreamChunk; }
        catch { failed ??= new Error("local LLM returned an invalid stream chunk"); return; }
        activity(assembler.apply(chunk));
      };
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // Bound memory, never queue/generation duration; don't store partial reviews.
        if (bytes > MAX_RESPONSE_BYTES) { res.destroy(new Error("local LLM response too large")); return; }
        if (!assembler) { chunks.push(chunk); return; }
        pending += chunk.toString("utf8");
        let nl = pending.indexOf("\n");
        while (nl >= 0) {
          onLine(pending.slice(0, nl).replace(/\r$/, ""));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
        }
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("local LLM response connection closed")));
      res.on("end", () => {
        if (!res.complete) { reject(new Error("local LLM response was incomplete")); return; }
        if (assembler) {
          if (pending.trim()) onLine(pending.replace(/\r$/, ""));
          if (failed) { reject(failed); return; }
          // A complete chat response always carries a finish_reason. Treat its absence as incomplete
          // whether or not a [DONE] arrived: a stream that reaches [DONE] with no finish_reason (a
          // truncating proxy, an interrupted server) must not resolve a partial reply as if finished.
          if (!assembler.finished) { reject(new Error("local LLM stream ended before completion")); return; }
          resolve(assembler.result());
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        if (!ok) {
          reject(new LocalChatHttpError(res.statusCode ?? 0, text));
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
  opts?: LocalRequestOptions,
): Promise<string> {
  const parsed = await requestLocalJson(baseURL, apiKey, "chat/completions", body, signal, opts) as
    { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
  const choice = parsed?.choices?.[0];
  if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter") {
    throw new LocalChatCutOff(choice.finish_reason);
  }
  if (typeof choice?.message?.content !== "string") throw new Error("local LLM returned no completed message");
  return choice.message.content;
}
