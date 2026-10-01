import {
  LocalChatCutOff,
  LocalChatHttpError,
  requestLocalJson,
  type LocalRequestOptions,
} from "./local-chat-request.server.ts";

type ModelRequest<T> = (model: string) => Promise<T>;

function isRateLimited(error: unknown): boolean {
  return (error instanceof LocalChatHttpError && error.status === 429) ||
    Number((error as { status?: unknown })?.status) === 429;
}

/**
 * Parse the operator's comma/newline separated model aliases. The primary model is always tried
 * first, even when it is also present in the configured list. Empty aliases and duplicates are
 * removed so a rate-limited model cannot be retried accidentally.
 */
export function parseLocalModelPriority(primary: string, configured: string | string[] = ""): string[] {
  const values = [primary, ...(Array.isArray(configured) ? configured : configured.split(/[\n,]/))]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return [...new Set(values)];
}

export type LocalModelRouter = {
  currentModel: () => string;
  /** Run one logical request. A model is advanced only for a pre-response HTTP 429. */
  run: <T>(request: ModelRequest<T>) => Promise<T>;
  /** JSON transport adapter used by the local review loop. */
  request: typeof requestLocalJson;
};

export async function requestLocalChatWithModelFallback(
  baseURL: string,
  apiKey: string,
  models: string[],
  body: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: LocalRequestOptions,
  requestJson: typeof requestLocalJson = requestLocalJson,
): Promise<string> {
  const router = createLocalModelRouter(models, requestJson);
  const parsed = await router.request(baseURL, apiKey, "chat/completions", body, signal, opts) as {
    choices?: { finish_reason?: string; message?: { content?: unknown } }[];
  };
  const choice = parsed?.choices?.[0];
  if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter") {
    throw new LocalChatCutOff(choice.finish_reason);
  }
  if (typeof choice?.message?.content !== "string") throw new Error("local LLM returned no completed message");
  return choice.message.content;
}

/**
 * Keep model failover in Ashlar so a CLIProxyAPI instance can remain a dumb OpenAI-compatible
 * endpoint. A successful response, a transport error, or any status other than 429 is returned to
 * the caller unchanged. Once a model has returned 429, subsequent requests in this logical job
 * start at the next alias instead of hammering the exhausted provider.
 */
export function createLocalModelRouter(
  models: string[],
  requestJson: typeof requestLocalJson = requestLocalJson,
): LocalModelRouter {
  const ordered = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  let index = 0;

  const run = async <T>(request: ModelRequest<T>): Promise<T> => {
    while (true) {
      try {
        return await request(ordered[index] ?? "");
      } catch (error) {
        if (!isRateLimited(error) || index >= ordered.length - 1) {
          throw error;
        }
        index += 1;
      }
    }
  };

  return {
    currentModel: () => ordered[index] ?? "",
    run,
    request: (baseURL, apiKey, path, body, signal, opts?: LocalRequestOptions) => run((model) => {
      const routedBody = body && typeof body === "object"
        ? { ...(body as Record<string, unknown>), model }
        : body;
      return requestJson(baseURL, apiKey, path, routedBody, signal, opts);
    }),
  };
}
