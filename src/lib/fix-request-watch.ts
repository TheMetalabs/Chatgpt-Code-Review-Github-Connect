/**
 * Fix-request watcher — how long a fix request may take, and whether it is still worth taking.
 *
 * WHY: providers queue. The local LLM serializes reviews AND fixes, so a request can wait an hour
 * before its first token. A deadline counted from SEND expires in the queue and hands off a false
 * fix-failed; and a request whose PR moved on (a new head, an operator stop) is still generated in
 * full, only to be discarded at commit time. The watcher follows the provider's phases:
 *   queued     — the provider accepted the request but produced nothing yet (keepalives);
 *   generating — the first output token (or a buffered reply) arrived.
 *
 * CONTRACT
 * - The generation deadline counts from the FIRST output (queue time excluded): generationMs.
 * - Queue ceiling: a request still queued after queueMaxMs is abandoned (a backstop, not a norm).
 * - Liveness: once the provider has shown a sign of life, silence longer than livenessMs means it
 *   died (a streaming server sends keepalives while queued or generating). 0 = off.
 * - Relevance: stillWanted() is consulted every checkEveryMs while queued (and throughout for a
 *   provider that reports no activity) and once when generation starts; a non-null reason aborts
 *   the request — the queue slot is released before, or the generation cut right after, it starts.
 *   A failing check never cancels (fail open: the commit path re-verifies the head anyway).
 * - A provider that reports no activity (reportsActivity:false) is timed as generating from send.
 * - Every expiry or cancel ABORTS the provider call (signal) and rejects with FixRequestStop.
 * NON-GOALS: parsing the answer, retries and handoffs (the runtime owns those).
 */

export type FixPhase = "queued" | "generating";

export interface FixRequestControl {
  signal: AbortSignal;
  onActivity: (phase: FixPhase) => void;
}

export type WatchedRequest = (prompt: string, ctl: FixRequestControl) => Promise<string>;

export type FixStopWhy = "cancelled" | "generation-deadline" | "queue-deadline" | "silent";

export class FixRequestStop extends Error {
  readonly why: FixStopWhy;
  constructor(why: FixStopWhy, message: string) {
    super(message);
    this.name = "FixRequestStop";
    this.why = why;
  }
}

export interface FixWatchConfig {
  generationMs: number;
  queueMaxMs: number;
  livenessMs: number;
  checkEveryMs: number;
  tickMs: number;
  reportsActivity: boolean;
  /** null = still wanted; otherwise the reason to cancel (e.g. "head moved", "loop stopped"). */
  stillWanted: () => Promise<string | null>;
  now?: () => number;
}

function span(ms: number): string {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
}

export function watchFixRequest(request: WatchedRequest, prompt: string, cfg: FixWatchConfig): Promise<string> {
  const now = cfg.now ?? Date.now;
  const ac = new AbortController();
  const sentAt = now();
  let phase: FixPhase = cfg.reportsActivity ? "queued" : "generating";
  let generatingAt: number | undefined = cfg.reportsActivity ? undefined : sentAt;
  let lastSign: number | undefined;
  let lastCheck = sentAt;
  let checking = false;
  let done = false;

  return new Promise<string>((resolve, reject) => {
    // Declared up front for the closures; assigned once below, before any of them can run.
    const handle: { timer?: ReturnType<typeof setInterval> } = {};
    const settle = () => {
      done = true;
      if (handle.timer !== undefined) clearInterval(handle.timer);
    };
    // Settle FIRST, then abort: the provider's own abort rejection must not hide why it ended.
    const stop = (err: FixRequestStop) => {
      if (done) return;
      settle();
      reject(err);
      ac.abort();
    };
    const check = async () => {
      if (checking || done) return;
      checking = true;
      try {
        const why = await cfg.stillWanted();
        if (why) stop(new FixRequestStop("cancelled", `fix request cancelled: ${why}`));
      } catch {
        /* fail open — the commit path re-verifies the head */
      } finally {
        checking = false;
      }
    };
    const onActivity = (p: FixPhase) => {
      if (done) return;
      lastSign = now();
      if (p === "generating" && phase === "queued") {
        phase = "generating";
        generatingAt = lastSign;
        void check(); // the last cheap moment to skip a stale generation
      }
    };
    handle.timer = setInterval(() => {
      if (done) return;
      const t = now();
      if (phase === "generating" && generatingAt !== undefined && t - generatingAt > cfg.generationMs) {
        return stop(new FixRequestStop("generation-deadline", `fix generation exceeded its ${span(cfg.generationMs)} deadline`));
      }
      if (phase === "queued" && t - sentAt > cfg.queueMaxMs) {
        return stop(new FixRequestStop("queue-deadline", `fix request waited over ${span(cfg.queueMaxMs)} in the provider queue`));
      }
      if (cfg.reportsActivity && cfg.livenessMs > 0 && lastSign !== undefined && t - lastSign > cfg.livenessMs) {
        return stop(new FixRequestStop("silent", `fix request showed no sign of life for ${span(cfg.livenessMs)}`));
      }
      if ((phase === "queued" || !cfg.reportsActivity) && t - lastCheck >= cfg.checkEveryMs) {
        lastCheck = t;
        void check();
      }
    }, cfg.tickMs);
    (handle.timer as { unref?: () => void }).unref?.();
    request(prompt, { signal: ac.signal, onActivity }).then(
      (value) => {
        if (done) return;
        settle();
        resolve(value);
      },
      (error) => {
        if (done) return;
        settle();
        reject(error);
      },
    );
  });
}
