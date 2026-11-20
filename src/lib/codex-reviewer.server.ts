/**
 * The Codex reviewer leg: a ChatGPT model reached through a LOCAL OpenAI-compatible proxy that wraps a
 * ChatGPT account's Codex login (ChatMock at http://127.0.0.1:18431/v1 is the recommended one;
 * CLIProxyAPI works too). One streamed `chat/completions` request per review, over the shared local
 * transport, but:
 *
 * - never under the local model's lease or ASHLAR_LOCAL_SLOT_LOCK (another server entirely);
 * - one Codex request at a time per process (codexSlot), the rest queue;
 * - no sampling fields and no max_tokens (the Codex backend rejects or ignores them): only
 *   reasoning_effort, max_completion_tokens when set, and response_format json_schema when on;
 * - no second full-prompt correction call: a reply that is not review JSON is evidence, as for local;
 * - a usage limit (HTTP 429, or a forwarded usage_limit_reached / usage_not_included /
 *   rate_limit_exceeded) is reported with its reset time so harbor can skip Codex until then.
 *
 * Every error message this module returns is fixed text. Backend text can carry words ("ChatGPT",
 * "disconnected", "local") that reviewer-progress and local-fallback match for other providers, so it is
 * logged, never stored on the job.
 */
import { buildLocalChatPrompt } from "./chat-prompt.ts";
import { extractChatJsonRange } from "./extract-chat-json.ts";
import {
  LocalChatHttpError,
  LocalChatStreamError,
  LocalHttpSlot,
  requestLocalJson,
  type LocalRequestActivity,
} from "./local-chat-request.server.ts";
import { residualOutsideJson, type LocalLegResult } from "./local-llm.server.ts";
import { repairSchemaDefinition } from "./review-json-repair.ts";
import type { BotSettings } from "./types.ts";

/** A Codex request with no byte from the proxy (headers, keepalive or token) for this long is stuck. */
export const CODEX_LIVENESS_MS = 5 * 60_000;
/** The gate posts at most this many findings (poster GATED_FINDINGS_CAP); Codex is asked for no more. */
export const CODEX_MAX_FINDINGS = 8;

export const CODEX_SYSTEM_PROMPT =
  "You are Ashlar, a code reviewer. Return ONLY the review JSON object the user message describes. No markdown fences, no prose.";
export const CODEX_OUTPUT_RULE = `Return at most ${CODEX_MAX_FINDINGS} findings: the ones whose quotes prove the failure best. Return the JSON object directly, with no code fence and no text before or after it.`;

/** The Codex prompt: the job's chat prompt fitted to codexPromptMaxChars (attachments inline, as an API
 * model reads them; the code context shrinks when it must, the diff never does, which is why
 * settings-rules codexDiffBudgetProblem keeps the diff budget below it), then the output rule. */
export function buildCodexPrompt(
  opts: Omit<Parameters<typeof buildLocalChatPrompt>[0], "localBudget">,
  maxChars: number,
): string {
  const overheadChars = CODEX_SYSTEM_PROMPT.length + CODEX_OUTPUT_RULE.length + 2;
  const fitted = buildLocalChatPrompt({
    ...opts,
    localBudget: { maxChars, overheadChars, shrinkContext: true },
  });
  return `${fitted}\n\n${CODEX_OUTPUT_RULE}`;
}

/** The review shape as a JSON schema (the repair schema: the same keys CHAT_JSON_HINT asks for). */
export function codexReviewSchema(): Record<string, unknown> {
  const base = repairSchemaDefinition("review") as unknown as {
    properties: Record<string, Record<string, unknown>>;
  };
  return {
    ...base,
    properties: {
      ...base.properties,
      findings: { ...base.properties.findings, maxItems: CODEX_MAX_FINDINGS },
    },
  };
}

/** The request body. No temperature, top_p, top_k, presence_penalty, max_tokens or service_tier. */
export function codexRequestBody(
  settings: Pick<BotSettings, "codexModel" | "codexReasoningEffort" | "codexMaxOutputTokens">,
  prompt: string,
  structured: boolean,
): Record<string, unknown> {
  const maxOut = Number(settings.codexMaxOutputTokens);
  return {
    model: settings.codexModel.trim(),
    messages: [
      { role: "system", content: CODEX_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    stream: true,
    ...(settings.codexReasoningEffort ? { reasoning_effort: settings.codexReasoningEffort } : {}),
    ...(Number.isInteger(maxOut) && maxOut > 0 ? { max_completion_tokens: maxOut } : {}),
    ...(structured
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: "ashlar_review", strict: false, schema: codexReviewSchema() },
          },
        }
      : {}),
  };
}

type CodexProcessState = { cooldownUntil: number; noResponseFormat: boolean; slot: LocalHttpSlot };
const STATE_KEY = Symbol.for("ashlar.codexReviewer");

/** Process-wide Codex state (on globalThis, so a module loaded twice still shares it). */
function codexState(): CodexProcessState {
  const g = globalThis as unknown as Record<symbol, CodexProcessState | undefined>;
  return (g[STATE_KEY] ??= {
    cooldownUntil: 0,
    noResponseFormat: false,
    slot: new LocalHttpSlot(),
  });
}

/** When the usage-limit cooldown ends (epoch ms); 0 = none was ever set. */
export function codexCooldownUntil(): number {
  return codexState().cooldownUntil;
}

/** Whether Codex is cooling down after a usage limit at `now`. */
export function codexCoolingDown(now: number): boolean {
  return codexState().cooldownUntil > now;
}

/** Extend the cooldown to `until` (a later limit never shortens it). */
export function noteCodexCooldown(until: number): void {
  const state = codexState();
  if (Number.isFinite(until) && until > state.cooldownUntil) state.cooldownUntil = until;
}

/** Whether this process stopped sending response_format (the proxy rejected it once). */
export function codexResponseFormatDropped(): boolean {
  return codexState().noResponseFormat;
}

/** HH:MM UTC of a reset time, for the fixed notes. */
function resetClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** The fixed note naming a usage limit and when it resets. Never backend text (see the module note). */
export function codexQuotaNote(resetAt: number): string {
  return `Codex skipped (usage limit, resets at ${resetClock(resetAt)})`;
}

/** An `error` object the proxy returned in a 200 body instead of a completion. */
class CodexBodyError extends Error {
  readonly body: string;
  constructor(body: string) {
    super("Codex proxy returned an error body");
    this.name = "CodexBodyError";
    this.body = body.slice(0, 16 * 1024);
  }
}

const QUOTA_TYPES = /^(usage_limit_reached|usage_not_included|rate_limit_exceeded)$/;

function objectOf(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function finiteNumber(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** A reset time is never sooner than this after now ... */
const MIN_RESET_MS = 60_000;
/** ... nor later than this: a garbled or hostile value must not park Codex for months. */
const MAX_RESET_MS = 7 * 24 * 60 * 60_000;

/** An epoch value as ms: above ~1e11 it already is ms (1e11 s is year 5138). */
function epochMs(v: number): number {
  return v > 1e11 ? v : v * 1000;
}

/** A usage-limit failure's reset time (epoch ms), or undefined when `failure` is not one. A usage limit
 * is HTTP 429, or an error whose type is usage_limit_reached / usage_not_included / rate_limit_exceeded
 * (in a non-2xx body, a 200 JSON body or a stream error chunk, where the proxy forwards it). The reset
 * time comes from the first source present, in order: `resets_at` (epoch s or ms), `resets_in_seconds`,
 * the Retry-After header, the x-codex-primary-reset-after-seconds / x-codex-primary-reset-at headers.
 * It is clamped to [now + 1 min, now + 7 days]; none, a past one or a non-finite one is
 * now + cooldownMinutes. */
export function codexQuotaResetAt(
  failure: unknown,
  now: number,
  cooldownMinutes: number,
): number | undefined {
  let status: number | undefined;
  let body = "";
  let headers: Record<string, string> = {};
  let retryAfterMs: number | undefined;
  if (failure instanceof LocalChatHttpError) {
    ({ status, body, headers, retryAfterMs } = failure);
  } else if (failure instanceof LocalChatStreamError) {
    body = failure.body;
  } else if (failure instanceof CodexBodyError) {
    body = failure.body;
  } else return undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = objectOf(JSON.parse(body));
  } catch {
    parsed = undefined;
  }
  const error = objectOf(parsed?.error) ?? parsed;
  const type = String(error?.type ?? error?.code ?? "");
  if (status !== 429 && !QUOTA_TYPES.test(type)) return undefined;
  // A present but unreadable value (a string that is no number) still counts as present: NaN.
  const raw = (key: string) => error?.[key] ?? parsed?.[key];
  const num = (v: unknown) =>
    finiteNumber(v) ?? (v === undefined || v === null || v === "" ? undefined : NaN);
  const atHeader = headers["x-codex-primary-reset-at"];
  const atHeaderNum = finiteNumber(atHeader);
  const candidates: (() => number | undefined)[] = [
    () => {
      const v = num(raw("resets_at"));
      return v === undefined ? undefined : epochMs(v);
    },
    () => {
      const v = num(raw("resets_in_seconds"));
      return v === undefined ? undefined : now + v * 1000;
    },
    () => (retryAfterMs === undefined ? undefined : now + retryAfterMs),
    () => {
      const v = num(headers["x-codex-primary-reset-after-seconds"]);
      return v === undefined ? undefined : now + v * 1000;
    },
    () =>
      atHeader === undefined
        ? undefined
        : atHeaderNum !== undefined
          ? epochMs(atHeaderNum)
          : Date.parse(atHeader),
  ];
  let at: number | undefined;
  for (const candidate of candidates) {
    at = candidate();
    if (at !== undefined) break;
  }
  const fallback = now + Math.max(1, cooldownMinutes) * 60_000;
  if (at === undefined || !Number.isFinite(at) || at <= now) return fallback;
  return Math.min(now + MAX_RESET_MS, Math.max(now + MIN_RESET_MS, at));
}

/** A 400/422 whose body names the structured-output field: a proxy that does not accept response_format. */
function rejectsResponseFormat(e: unknown): boolean {
  return (
    e instanceof LocalChatHttpError &&
    (e.status === 400 || e.status === 422) &&
    /response_format|json_schema|text\.format/i.test(e.body || e.message)
  );
}

/** Fixed text for a failure (never the backend's words). */
function failureText(
  e: unknown,
  why: "timeout" | "silent" | undefined,
  timeoutMinutes: number,
): string {
  if (why === "timeout") return `no reply within ${timeoutMinutes} min (codexTimeoutMinutes)`;
  if (why === "silent") return "the Codex proxy sent nothing for the liveness window";
  if (e instanceof LocalChatHttpError) return `HTTP ${e.status} from the Codex proxy`;
  if (e instanceof CodexBodyError || e instanceof LocalChatStreamError)
    return "the Codex proxy returned an error instead of a reply";
  const name = (e as { name?: string } | undefined)?.name;
  const code = String((e as { code?: string } | undefined)?.code ?? "");
  if (name === "AbortError") return "cancelled";
  if (/^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN)$/.test(code))
    return "the Codex proxy is unreachable";
  const message = e instanceof Error ? e.message : "";
  if (/stream ended|incomplete|connection closed|invalid stream chunk/i.test(message))
    return "the Codex stream ended before the reply completed";
  if (/invalid JSON response/i.test(message)) return "the Codex proxy returned an invalid response";
  if (/too large/i.test(message)) return "the Codex reply was too large";
  return "the Codex request failed";
}

/** A leg result, or a usage limit with its reset time (the request never produced a reply). */
export type CodexLegResult = LocalLegResult | { ok: false; error: string; quotaResetAt: number };

export type CodexStage = "codex_queued" | "codex_running" | "codex_generating";

export type CodexRunOptions = {
  signal?: AbortSignal;
  /** queued (waiting for the one-at-a-time Codex slot; nothing sent), running (sent), generating (tokens). */
  onStage?: (stage: CodexStage) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** Test seams: the hard ceiling (default codexTimeoutMinutes) and the silence window (CODEX_LIVENESS_MS). */
  timeoutMs?: number;
  livenessMs?: number;
};

/** A leading reasoning summary some proxies put in the content (`<think>…</think>`, ChatMock's
 * think-tags mode): not part of the answer, so neither the JSON nor text around it. */
function withoutThinkBlocks(text: string): string {
  let out = text;
  for (;;) {
    const m = /^\s*<think>[\s\S]*?<\/think>/i.exec(out);
    if (!m) return out;
    out = out.slice(m[0].length);
  }
}

/** One Codex review. Never throws: a cancellation, a failure or a usage limit is a failed result. */
export async function runCodexReview(
  prompt: string,
  settings: BotSettings,
  opts: CodexRunOptions = {},
): Promise<CodexLegResult> {
  const baseURL = settings.codexBaseUrl.trim().replace(/\/$/, "");
  if (!baseURL) return { ok: false, error: "the Codex base URL is empty" };
  if (!settings.codexModel.trim()) return { ok: false, error: "the Codex model is empty" };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const state = codexState();
  opts.onStage?.("codex_queued");
  let release: () => void;
  try {
    release = await state.slot.acquire(opts.signal);
  } catch {
    return { ok: false, error: "cancelled" };
  }
  // A usage limit that started while this review waited for the slot: nothing is sent.
  if (codexCoolingDown(now())) {
    release();
    const until = codexCooldownUntil();
    return { ok: false, error: codexQuotaNote(until), quotaResetAt: until };
  }
  const inner = new AbortController();
  let why: "timeout" | "silent" | undefined;
  const onAbort = () => inner.abort(opts.signal?.reason);
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMinutes = Math.max(1, Number(settings.codexTimeoutMinutes) || 20);
  const hard = setTimeout(
    () => {
      why ??= "timeout";
      inner.abort(new Error("codex timeout"));
    },
    opts.timeoutMs ?? timeoutMinutes * 60_000,
  );
  let silence: ReturnType<typeof setTimeout> | undefined;
  const armSilence = () => {
    if (silence) clearTimeout(silence);
    silence = setTimeout(() => {
      why ??= "silent";
      inner.abort(new Error("codex silent"));
    }, opts.livenessMs ?? CODEX_LIVENESS_MS);
  };
  let stage: CodexStage = "codex_queued";
  const onActivity = (a: LocalRequestActivity) => {
    armSilence();
    const next: CodexStage =
      a.kind === "output" ? "codex_generating" : stage === "codex_queued" ? "codex_running" : stage;
    if (next !== stage) {
      stage = next;
      opts.onStage?.(next);
    }
  };
  const apiKey = settings.codexApiKey.trim();
  const send = (structured: boolean) =>
    requestLocalJson(
      baseURL,
      apiKey,
      "chat/completions",
      codexRequestBody(settings, prompt, structured),
      inner.signal,
      {
        stream: true,
        bypassSlotLock: true,
        onActivity,
        // Any bytes (SSE comment heartbeats included) prove the proxy is alive.
        onBytes: armSilence,
      },
    );
  try {
    armSilence();
    const structured = settings.codexStructuredOutput !== false && !state.noResponseFormat;
    let res: unknown;
    try {
      res = await send(structured);
    } catch (e) {
      if (!structured || !rejectsResponseFormat(e) || inner.signal.aborted) throw e;
      // The proxy does not take response_format: once more without it, and never again in this process.
      state.noResponseFormat = true;
      log(
        `the Codex proxy rejected response_format (HTTP ${(e as LocalChatHttpError).status}); retrying without it, and this process sends none`,
      );
      res = await send(false);
    }
    const body = objectOf(res);
    if (body?.error !== undefined && !Array.isArray(body.choices))
      throw new CodexBodyError(JSON.stringify({ error: body.error }));
    const choice = objectOf((body?.choices as unknown[] | undefined)?.[0]);
    const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
    const content = objectOf(choice?.message)?.content;
    const text = typeof content === "string" ? content : "";
    if (finish === "length" || finish === "content_filter") {
      // Cut off: whatever arrived is evidence (posted verbatim), never a verdict.
      return {
        ok: false,
        error: `the Codex reply was cut off (${finish})`,
        ...(text.trim() ? { unparsedText: text } : {}),
      };
    }
    if (!text.trim()) return { ok: false, error: "the Codex reply was empty" };
    const answer = withoutThinkBlocks(text);
    const range = extractChatJsonRange(answer);
    // No second full-prompt correction call: a completed reply that is not review JSON is evidence.
    if (!range)
      return { ok: false, error: "the Codex reply was not review JSON", unparsedText: text };
    const residual = residualOutsideJson(answer, range.start, range.end);
    return {
      ok: true,
      raw: range.json,
      originalText: text,
      ...(residual ? { residualReplies: residual } : {}),
    };
  } catch (e) {
    const resetAt = why
      ? undefined
      : codexQuotaResetAt(e, now(), Number(settings.codexQuotaCooldownMinutes) || 60);
    if (resetAt !== undefined) {
      // Recorded before the slot is released (finally), so a review queued behind this one sees it.
      noteCodexCooldown(resetAt);
      return {
        ok: false,
        error: codexQuotaNote(codexCooldownUntil()),
        quotaResetAt: codexCooldownUntil(),
      };
    }
    const error = opts.signal?.aborted ? "cancelled" : failureText(e, why, timeoutMinutes);
    // The backend's own words go to the process log only.
    log(
      `codex request failed: ${error} (${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300)})`,
    );
    return { ok: false, error };
  } finally {
    clearTimeout(hard);
    if (silence) clearTimeout(silence);
    opts.signal?.removeEventListener("abort", onAbort);
    release();
  }
}

/** Test seam: forget the cooldown and the response_format memory. */
export function resetCodexStateForTest(): void {
  const state = codexState();
  state.cooldownUntil = 0;
  state.noResponseFormat = false;
}
