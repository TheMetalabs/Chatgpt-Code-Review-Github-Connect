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
 *   A failing check never cancels (fail open: the commit path re-verifies relevance anyway). A
 *   check that does not answer within checkEveryMs releases the latch for the next tick (a hung
 *   read never disables the checks that follow), yet its late answer still counts; a check asked
 *   for while one is outstanding runs right after it instead of being dropped.
 * - A provider that reports no activity (reportsActivity:false) is timed as generating from send.
 * - Every expiry or cancel ABORTS the provider call (signal) and rejects with FixRequestStop; a
 *   provider that throws synchronously is settled exactly like one that rejects.
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
    // A check that arrives while one is still outstanding is not dropped: it runs right after
    // (the generation-start check in particular). A probe abandoned by its bound keeps its answer:
    // a late "cancel" still stops the request.
    let recheck = false;
    const check = async (): Promise<void> => {
      if (done) return;
      if (checking) {
        recheck = true;
        return;
      }
      checking = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const probe = Promise.resolve().then(() => cfg.stillWanted());
      probe.then(
        (why) => {
          if (why) stop(new FixRequestStop("cancelled", `fix request cancelled: ${why}`));
        },
        () => {
          /* fail open — the commit path re-verifies relevance */
        },
      );
      try {
        // Bounded: a hung read releases the latch for the next tick (fail open meanwhile).
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(1, cfg.checkEveryMs));
          (timer as { unref?: () => void }).unref?.();
        });
        await Promise.race([probe.then(() => undefined, () => undefined), bound]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        checking = false;
        if (recheck && !done) {
          recheck = false;
          void check();
        }
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
    let pending: Promise<string>;
    try {
      pending = request(prompt, { signal: ac.signal, onActivity });
    } catch (error) {
      // A synchronous throw settles like a rejection: clear the timer, reject, abort.
      settle();
      reject(error);
      ac.abort();
      return;
    }
    pending.then(
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
