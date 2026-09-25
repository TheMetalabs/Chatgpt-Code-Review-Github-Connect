/**
 * Review-loop SESSION — derived from durable GitHub history, never from in-memory job state.
 *
 * WHY: harbor jobs live in memory (a restart loses them), and a loop that re-anchored on every
 * re-issued `/review-loop` would see one round forever — the stuck classifier and the fix-round
 * budget could never fire. The session is therefore a pure fold over PR events that GitHub
 * persists (the App's records and markers, human stop comments, reviews), so every process and
 * every restart agrees on it. Starts are the App's START RECORDS (placed at the directive's own
 * time), never mutable human text — see readLoopEvents.
 *
 * CONTRACT
 * - A session STARTS at the first recorded start after the last terminal event, and
 *   stays anchored there: re-issuing a start inside an active session only updates the mode and
 *   the starter (the apply-permission subject) — it never resets the round count.
 * - Terminal events END an active session: a human stop directive, the bot's ESCALATE marker,
 *   the bot's STOPPED marker, a bot review with `ashlar-findings total=0` (CONVERGED), or a bot
 *   review whose marker records a NOT CLEAN outcome (review-loop.ts notCleanOutcomeOf: incomplete,
 *   raw, raw-unverified, unverified-clean). Such a review is not a clean pass and carries no
 *   structured finding, so the session it ends OWES the fixed loop-error handoff (owedHandoff) until
 *   it is settled (settlesOwed: the bot's handoff for its head, a stop, or a later clean review): its
 *   own loop step posts it, and when a crash or a failed post lost it, the next loop step on the PR (a
 *   push, another review) recovers it from this durable marker. A new start opens a new session.
 * - A terminal event with no active session is a no-op, except that the bot's STOPPED marker
 *   acknowledges a preceding human stop (endedBy "stop" → "stopped"), which makes the STOPPED
 *   emission idempotent.
 * - A clean (or not-clean) review ends the session only for the head the loop is waiting on. The loop moves to a
 *   new head through the driver's continuation (`continue`) or a push (`push`, injected by the
 *   push handler); a clean review of any OTHER head that is not the PR's live head is stale — it
 *   landed after the loop had moved on — and is ignored. A continuation posted AFTER a converged
 *   event, for a different head, while the converged head is not live, proves that the review
 *   was stale (the driver decided to continue before it landed): the session resumes with its
 *   anchor, mode and starter. A clean review of the live head always ends the session, and a
 *   push never resumes one (a human push after a real convergence starts nothing).
 * - Events are ordered as INSTANTS (isoMs), never as strings; an undatable event is ignored.
 * - Same-timestamp ties (GitHub timestamps are 1s resolution) order head moves first, then the
 *   App's terminal events, then starts, then human stops: a start posted in the same second as a
 *   handoff begins a new session, a stop in a start's second ends it, and a head move in a clean
 *   review's second marks it stale.
 * Authorship is the CALLER's job: only bot-authored markers/reviews may become escalate /
 * stopped / converged / continue events, and bot-authored comments never become start/stop events.
 */
import { isoMs, type NotCleanOutcome, type ReviewLoopMode } from "./review-loop.ts";

export type LoopEventKind = "start" | "stop" | "escalate" | "stopped" | "converged" | "not-clean" | "continue" | "push";

export interface LoopEvent {
  at: string; // ISO timestamp (created_at / submitted_at)
  kind: LoopEventKind;
  mode?: ReviewLoopMode; // start only
  actor?: string; // start / stop author
  /** converged / not-clean: the reviewed commit; escalate: the handoff's head; continue / push: the
   * head the loop moved to. */
  head?: string;
  /** not-clean only: the outcome its marker records. */
  outcome?: NotCleanOutcome;
  /** The issue comment's id (monotonic): a start record's id identifies its session exactly. */
  seq?: number;
}

/** The loop-error handoff a session that ended at a not-clean review owes (LoopSession.owedHandoff). */
export interface OwedHandoff {
  head?: string;
  outcome?: NotCleanOutcome;
  startIso?: string;
  startSeq?: number;
}

export interface LoopSession {
  active: boolean;
  /** Anchor: the first start after the last terminal event (the round window starts here). */
  startIso?: string;
  /** The anchor start record's comment id: the session's own control comments come after it
   * (id > startSeq) — exact where a second-resolution timestamp ties with the last session. */
  startSeq?: number;
  /** The latest start's mode within the active session. */
  mode?: ReviewLoopMode;
  /** The latest start's author — the subject of the apply write-permission gate. */
  starter?: string;
  endedBy?: Exclude<LoopEventKind, "start" | "continue" | "push">;
  endedAt?: string;
  /** The session ended at a not-clean review (endedBy "not-clean") and no bot handoff for its head
   * followed: the fixed loop-error handoff it owes, for that head and outcome, scoped to the session it
   * ended. */
  owedHandoff?: OwedHandoff;
}

// Same-second ties: head moves, then the App's terminal records (a new start in a handoff's
// second opens a NEW session), then starts, then human stops — a stop in a start's second is
// causally after it, and stopping is the safe reading.
const ORDER: Record<LoopEventKind, number> = { continue: -1, push: -1, escalate: 0, stopped: 0, converged: 0, "not-clean": 0, start: 1, stop: 2 };

/** A clean or not-clean review of `head` is stale when the loop already waits on another head and
 * `head` is not the live one. An unknown reviewed commit keeps the verdict (fail toward ending the loop). */
function staleVerdict(head: string | undefined, awaited: string | undefined, live: string | undefined): boolean {
  if (!head || head === live) return false;
  return awaited !== undefined && head !== awaited;
}

/** What settles the handoff a not-clean review owes, once its session ended: the bot's handoff for
 * its head, a human stop (the loop is stopped anyway), or a clean review of its head or of the live
 * head (the PR converged after all). Another review that is not clean leaves it owed: its own loop step
 * posts the handoff instead of a fix round. */
function settlesOwed(e: LoopEvent, owedHead: string | undefined, liveHead: string | undefined): boolean {
  if (e.kind === "escalate") return !e.head || !owedHead || e.head === owedHead;
  if (e.kind === "stop" || e.kind === "stopped") return true;
  if (e.kind === "converged") return !e.head || e.head === owedHead || e.head === liveHead;
  return false;
}

export function deriveLoopSession(events: readonly LoopEvent[], opts: { liveHead?: string } = {}): LoopSession {
  const sorted = events
    .map((e) => ({ e, t: isoMs(e.at) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t || ORDER[a.e.kind] - ORDER[b.e.kind])
    .map((x) => x.e);
  let s: LoopSession = { active: false };
  let awaited: string | undefined; // the head the active session waits on (latest continue / push)
  // A converged or not-clean end that a later continuation may prove stale: the session it ended +
  // its head (the driver decided to continue before that review landed).
  let resumable: { session: LoopSession; head: string } | undefined;
  for (const e of sorted) {
    if (e.kind === "start") {
      if (!s.active) awaited = undefined;
      s = s.active
        ? { ...s, mode: e.mode ?? s.mode, starter: e.actor ?? s.starter }
        : { active: true, startIso: e.at, ...(e.seq !== undefined ? { startSeq: e.seq } : {}), mode: e.mode ?? "suggest", starter: e.actor };
      resumable = undefined;
    } else if (e.kind === "continue" || e.kind === "push") {
      if (s.active) awaited = e.head ?? awaited;
      else if (e.kind === "continue" && resumable && e.head && e.head !== resumable.head) {
        s = resumable.session;
        awaited = e.head;
        resumable = undefined;
      }
    } else if (s.active) {
      const verdict = e.kind === "converged" || e.kind === "not-clean";
      if (verdict && staleVerdict(e.head, awaited, opts.liveHead)) continue; // ignored
      resumable = verdict && e.head && e.head !== opts.liveHead ? { session: s, head: e.head } : undefined;
      const owed = e.kind === "not-clean" ? { owedHandoff: { head: e.head, outcome: e.outcome, startIso: s.startIso, startSeq: s.startSeq } } : {};
      s = { active: false, endedBy: e.kind, endedAt: e.at, ...owed };
      awaited = undefined;
    } else {
      // After an end, a human stop, a handoff, or a clean or not-clean review of the LIVE head settles
      // it (no later resume); a duplicate review of an older head does not.
      if ((e.kind !== "converged" && e.kind !== "not-clean") || e.head === opts.liveHead) resumable = undefined;
      if (e.kind === "stopped" && s.endedBy === "stop") s = { ...s, endedBy: "stopped" };
      if (s.owedHandoff && settlesOwed(e, s.owedHandoff.head, opts.liveHead)) {
        const { owedHandoff: _settled, ...rest } = s;
        s = rest;
      }
    }
  }
  return s;
}
