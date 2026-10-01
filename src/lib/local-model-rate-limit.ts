const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Node clamps timers beyond the signed 32-bit delay range. Long Retry-After values are
// rechecked by the outer wait loop, so sleep in safe chunks instead of overflowing.
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export type ModelRateLimitMap = Record<string, number>;

function entries(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function durationMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === "m"
    ? 60_000
    : match[2]?.toLowerCase() === "s"
      ? 1_000
      : 1;
  const result = Math.round(amount * multiplier);
  return Number.isSafeInteger(result) && result >= 0 && result <= MAX_INTERVAL_MS ? result : undefined;
}

function parseEntry(entry: string): { model: string; intervalMs: number } | { error: string } {
  const separator = entry.indexOf("=");
  if (separator <= 0) return { error: "model rate limit must use model=duration (for example qwen=60s)" };
  const model = entry.slice(0, separator).trim();
  const rawDuration = entry.slice(separator + 1).trim();
  const intervalMs = durationMs(rawDuration);
  if (!model || intervalMs === undefined) {
    return { error: "model rate limit must use model=duration (for example qwen=60s)" };
  }
  return { model, intervalMs };
}

function setRateLimit(result: ModelRateLimitMap, model: string, intervalMs: number): void {
  Object.defineProperty(result, model, {
    configurable: true,
    enumerable: true,
    value: intervalMs,
    writable: true,
  });
}

export function modelRateLimitsProblem(value: unknown): string | null {
  if (typeof value !== "string") return "local_llm.model_rate_limits must be text";
  for (const entry of entries(value)) {
    const parsed = parseEntry(entry);
    if ("error" in parsed) return parsed.error;
  }
  return null;
}

/** Parse `model=duration` entries. Bare numbers are milliseconds; `s` and `m` are also accepted. */
export function parseLocalModelRateLimits(value: string | string[] | undefined = ""): ModelRateLimitMap {
  const result: ModelRateLimitMap = {};
  for (const entry of entries(value)) {
    const parsed = parseEntry(entry);
    if ("error" in parsed) continue;
    setRateLimit(result, parsed.model, parsed.intervalMs);
  }
  return result;
}

function configuredInterval(limits: ModelRateLimitMap, model: string): number {
  if (!Object.prototype.hasOwnProperty.call(limits, model)) return 0;
  const value = limits[model];
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("local model rate-limit wait aborted"), { name: "AbortError" });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal as AbortSignal));
    };
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, Math.min(ms, MAX_TIMER_DELAY_MS));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export type LocalModelRateLimiterOptions = {
  now?: () => number;
  sleep?: Sleep;
};

/** Process-wide, per-model request-start gate. Requests for different models do not share a queue. */
export class LocalModelRateLimiter {
  private limits: ModelRateLimitMap;
  private readonly nextAt = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: Sleep;

  constructor(limits: ModelRateLimitMap = {}, options: LocalModelRateLimiterOptions = {}) {
    this.limits = { ...limits };
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  configure(limits: ModelRateLimitMap): void {
    this.limits = { ...limits };
  }

  async wait(model: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortReason(signal);
    const previous = this.tails.get(model) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => turn);
    this.tails.set(model, current);
    try {
      await waitForPrevious(previous, signal);
      // A concurrent 429 can extend `nextAt` while this request is asleep. Recheck after
      // every sleep so an already queued request cannot bypass the newer Retry-After window.
      while (true) {
        const delay = Math.max(0, (this.nextAt.get(model) ?? 0) - this.now());
        if (delay <= 0) break;
        await this.sleep(delay, signal);
      }
      if (signal?.aborted) throw abortReason(signal);
      const interval = configuredInterval(this.limits, model);
      this.nextAt.set(model, this.now() + interval);
    } finally {
      release();
      if (this.tails.get(model) === current) this.tails.delete(model);
    }
  }

  noteRateLimit(model: string, retryAfterMs?: number): void {
    const fallback = configuredInterval(this.limits, model);
    const delay = Number.isFinite(retryAfterMs) && (retryAfterMs as number) >= 0
      ? retryAfterMs as number
      : fallback;
    this.nextAt.set(model, Math.max(this.nextAt.get(model) ?? 0, this.now() + delay));
  }
}

const GLOBAL_KEY = Symbol.for("ashlar.localModelRateLimiter");

/** The process-wide limiter shared by review, fix, and JSON-repair model calls. */
export function localModelRateLimiter(): LocalModelRateLimiter {
  const g = globalThis as unknown as Record<symbol, LocalModelRateLimiter | undefined>;
  return (g[GLOBAL_KEY] ??= new LocalModelRateLimiter());
}
