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
 * - Same-timestamp ties (GitHub timestamps are 1s resolution) order terminal events BEFORE
 *   starts: a start posted in the same second as a handoff begins a new session.
 * Authorship is the CALLER's job: only bot-authored markers/reviews may become escalate /
 * stopped / converged events, and bot-authored comments never become start/stop events.
 */
import type { ReviewLoopMode } from "./review-loop.ts";

export type LoopEventKind = "start" | "stop" | "escalate" | "stopped" | "converged";

export interface LoopEvent {
  at: string; // ISO timestamp (created_at / submitted_at)
  kind: LoopEventKind;
  mode?: ReviewLoopMode; // start only
  actor?: string; // start / stop author
}

export interface LoopSession {
  active: boolean;
  /** Anchor: the first start after the last terminal event (the round window starts here). */
  startIso?: string;
  /** The latest start's mode within the active session. */
  mode?: ReviewLoopMode;
  /** The latest start's author — the subject of the apply write-permission gate. */
  starter?: string;
  endedBy?: Exclude<LoopEventKind, "start">;
  endedAt?: string;
}

const ORDER: Record<LoopEventKind, number> = { stop: 0, escalate: 0, stopped: 0, converged: 0, start: 1 };

export function deriveLoopSession(events: readonly LoopEvent[]): LoopSession {
  const sorted = [...events]
    .filter((e) => typeof e.at === "string" && e.at.length > 0)
    .sort((a, b) => (a.at === b.at ? ORDER[a.kind] - ORDER[b.kind] : a.at < b.at ? -1 : 1));
  let s: LoopSession = { active: false };
  for (const e of sorted) {
    if (e.kind === "start") {
      s = s.active
        ? { ...s, mode: e.mode ?? s.mode, starter: e.actor ?? s.starter }
        : { active: true, startIso: e.at, mode: e.mode ?? "suggest", starter: e.actor };
    } else if (s.active) {
      s = { active: false, endedBy: e.kind, endedAt: e.at };
    } else if (e.kind === "stopped" && s.endedBy === "stop") {
      s = { ...s, endedBy: "stopped" };
    }
  }
  return s;
}
