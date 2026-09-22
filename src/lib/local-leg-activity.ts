import type { ProviderProgress } from "./review-progress.ts";

/** Wall-clock ceiling for one local review leg, from ASHLAR_LOCAL_REVIEW_DEADLINE_MS. 0 = none.
 *
 * None is the default on purpose. The local reviewer is a multi-turn loop on a concurrency-1 server:
 * 30–40 minutes is a normal review, and it can take hours when other jobs are queued ahead of it.
 * A fixed 20-minute ceiling (the previous behaviour) therefore turned every queued review into
 * "Skipped local (deadline)". A leg that is genuinely stuck is made VISIBLE instead — queued at the
 * server vs generating vs no sign of life (see localLegDetail) — and the operator cancels it. */
export function localReviewDeadlineMs(env: Record<string, string | undefined> | undefined = typeof process !== "undefined" ? process.env : undefined): number {
  const raw = env?.ASHLAR_LOCAL_REVIEW_DEADLINE_MS;
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export type LocalLegPhase = "queued" | "generating";

/** Per-leg activity tracker. `aliveAt` is the last sign the server is alive for this request
 * (headers, heartbeat chunk, or output); `progressAt` is the last real progress (output tokens or a
 * completed turn). The two differ exactly when the request is queued behind other work. */
export type LocalLegState = {
  phase: LocalLegPhase;
  startedAt: number;
  aliveAt: number;
  progressAt: number;
  /** Last time the state was flushed into the job's providerProgress. */
  writtenAt: number;
  everAccepted: boolean;
  everGenerated: boolean;
};

export type LocalLegActivityKind = "keepalive" | "output" | "turn";

/** Throttle for heartbeat-only flushes: token deltas arrive many times a second. Phase changes
 * always flush immediately. */
export const LOCAL_LEG_FLUSH_MS = 5_000;

export function startLocalLeg(now: number): LocalLegState {
  return { phase: "queued", startedAt: now, aliveAt: now, progressAt: now, writtenAt: now, everAccepted: false, everGenerated: false };
}

export function applyLocalActivity(
  prev: LocalLegState,
  kind: LocalLegActivityKind,
  now: number,
  flushMs = LOCAL_LEG_FLUSH_MS,
): { state: LocalLegState; flush: boolean; accepted: boolean; generated: boolean } {
  let next: LocalLegState = { ...prev, aliveAt: now };
  let accepted = false;
  let generated = false;
  if (kind === "keepalive") {
    if (!prev.everAccepted) { accepted = true; next = { ...next, everAccepted: true }; }
  } else if (kind === "output") {
    if (!prev.everGenerated) { generated = true; }
    next = { ...next, phase: "generating", progressAt: now, everAccepted: true, everGenerated: true };
  } else {
    // A multi-turn boundary: the previous request completed (progress) and the next one is about to
    // be sent, so the leg is back to waiting for the server until output arrives again.
    next = { ...next, phase: "queued", progressAt: now };
  }
  const flush = next.phase !== prev.phase || now - prev.writtenAt >= flushMs;
  if (flush) next = { ...next, writtenAt: now };
  return { state: next, flush, accepted, generated };
}

export function localLegProgress(state: LocalLegState, runId: string, now: number): ProviderProgress {
  return {
    runId,
    stage: state.phase === "queued" ? "local_queued" : "local_generating",
    observedAt: state.progressAt,
    keepaliveAt: state.aliveAt,
    receivedAt: now,
  };
}
