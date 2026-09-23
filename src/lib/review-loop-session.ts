/**
 * Review-loop SESSION — derived from durable GitHub history, never from in-memory job state.
 *
 * WHY: harbor jobs live in memory (a restart loses them), and a loop that re-anchored on every
 * re-issued `/review-loop` would see one round forever — the stuck classifier and the fix-round
 * budget could never fire. The session is therefore a pure fold over PR events that GitHub
 * persists (comments, reviews, the PR body), so every process and every restart agrees on it.
 *
 * CONTRACT
 * - A session STARTS at the first human start directive after the last terminal event, and
 *   stays anchored there: re-issuing a start inside an active session only updates the mode and
 *   the starter (the apply-permission subject) — it never resets the round count.
 * - Terminal events END an active session: a human stop directive, the bot's ESCALATE marker,
 *   the bot's STOPPED marker, or a bot review with `ashlar-findings total=0` (CONVERGED).
 * - A terminal event with no active session is a no-op, except that the bot's STOPPED marker
 *   acknowledges a preceding human stop (endedBy "stop" → "stopped"), which makes the STOPPED
 *   emission idempotent.
 * - A clean review is CONVERGED only for the head the loop is waiting on. The loop moves to a
 *   new head through the driver's continuation (`continue`) or a push (`push`, injected by the
 *   push handler); a clean review of any OTHER head that is not the PR's live head is stale — it
 *   landed after the loop had moved on — and is ignored. A continuation posted AFTER a converged
 *   event, for a different head, while the converged head is not live, proves that the review
 *   was stale (the driver decided to continue before it landed): the session resumes with its
 *   anchor, mode and starter. A clean review of the live head always ends the session, and a
 *   push never resumes one (a human push after a real convergence starts nothing).
 * - Events are ordered as INSTANTS (isoMs), never as strings; an undatable event is ignored.
 * - Same-timestamp ties (GitHub timestamps are 1s resolution) order head moves first, then
 *   terminal events, then starts: a start posted in the same second as a handoff begins a new
 *   session, and a head move in a clean review's second marks it stale.
 * Authorship is the CALLER's job: only bot-authored markers/reviews may become escalate /
 * stopped / converged / continue events, and bot-authored comments never become start/stop events.
 */
import { isoMs, type ReviewLoopMode } from "./review-loop.ts";

export type LoopEventKind = "start" | "stop" | "escalate" | "stopped" | "converged" | "continue" | "push";

export interface LoopEvent {
  at: string; // ISO timestamp (created_at / submitted_at)
  kind: LoopEventKind;
  mode?: ReviewLoopMode; // start only
  actor?: string; // start / stop author
  /** converged: the reviewed commit; continue / push: the head the loop moved to. */
  head?: string;
}

export interface LoopSession {
  active: boolean;
  /** Anchor: the first start after the last terminal event (the round window starts here). */
  startIso?: string;
  /** The latest start's mode within the active session. */
  mode?: ReviewLoopMode;
  /** The latest start's author — the subject of the apply write-permission gate. */
  starter?: string;
  endedBy?: Exclude<LoopEventKind, "start" | "continue" | "push">;
  endedAt?: string;
}

const ORDER: Record<LoopEventKind, number> = { continue: -1, push: -1, stop: 0, escalate: 0, stopped: 0, converged: 0, start: 1 };

/** A clean review of `head` is stale when the loop already waits on another head and `head` is
 * not the live one. An unknown reviewed commit keeps the verdict (fail toward ending the loop). */
function staleClean(head: string | undefined, awaited: string | undefined, live: string | undefined): boolean {
  if (!head || head === live) return false;
  return awaited !== undefined && head !== awaited;
}

export function deriveLoopSession(events: readonly LoopEvent[], opts: { liveHead?: string } = {}): LoopSession {
  const sorted = events
    .map((e) => ({ e, t: isoMs(e.at) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t || ORDER[a.e.kind] - ORDER[b.e.kind])
    .map((x) => x.e);
  let s: LoopSession = { active: false };
  let awaited: string | undefined; // the head the active session waits on (latest continue / push)
  // A converged end that a later continuation may prove stale: the session it ended + its head.
  let resumable: { session: LoopSession; head: string } | undefined;
  for (const e of sorted) {
    if (e.kind === "start") {
      if (!s.active) awaited = undefined;
      s = s.active
        ? { ...s, mode: e.mode ?? s.mode, starter: e.actor ?? s.starter }
        : { active: true, startIso: e.at, mode: e.mode ?? "suggest", starter: e.actor };
      resumable = undefined;
    } else if (e.kind === "continue" || e.kind === "push") {
      if (s.active) awaited = e.head ?? awaited;
      else if (e.kind === "continue" && resumable && e.head && e.head !== resumable.head) {
        s = resumable.session;
        awaited = e.head;
        resumable = undefined;
      }
    } else if (s.active) {
      if (e.kind === "converged" && staleClean(e.head, awaited, opts.liveHead)) continue; // ignored
      resumable = e.kind === "converged" && e.head && e.head !== opts.liveHead ? { session: s, head: e.head } : undefined;
      s = { active: false, endedBy: e.kind, endedAt: e.at };
      awaited = undefined;
    } else {
      // After an end, a human stop, a handoff, or a clean review of the LIVE head settles it (no
      // later resume); a duplicate clean review of an older head does not.
      if (e.kind !== "converged" || e.head === opts.liveHead) resumable = undefined;
      if (e.kind === "stopped" && s.endedBy === "stop") s = { ...s, endedBy: "stopped" };
    }
  }
  return s;
}
