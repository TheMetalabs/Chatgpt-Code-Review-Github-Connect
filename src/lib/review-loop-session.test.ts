import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveLoopSession, type LoopEvent } from "./review-loop-session.ts";

const ev = (at: string, kind: LoopEvent["kind"], extra: Partial<LoopEvent> = {}): LoopEvent => ({ at, kind, ...extra });

describe("deriveLoopSession (durable session fold)", () => {
  it("no start → no session", () => {
    assert.deepEqual(deriveLoopSession([]), { active: false });
    assert.equal(deriveLoopSession([ev("2026-01-01T00:00:00Z", "converged")]).active, false);
  });

  it("a start opens the session, anchored at the start; mode + starter come from it", () => {
    const s = deriveLoopSession([ev("2026-01-01T00:00:00Z", "start", { mode: "apply", actor: "alice" })]);
    assert.deepEqual(s, { active: true, startIso: "2026-01-01T00:00:00Z", mode: "apply", starter: "alice" });
  });

  it("a re-issued start keeps the anchor and updates mode + starter (the budget never resets)", () => {
    const s = deriveLoopSession([
      ev("2026-01-01T00:00:00Z", "start", { mode: "suggest", actor: "alice" }),
      ev("2026-01-03T00:00:00Z", "start", { mode: "apply", actor: "bob" }),
    ]);
    assert.deepEqual(s, { active: true, startIso: "2026-01-01T00:00:00Z", mode: "apply", starter: "bob" });
  });

  it("every terminal kind ends the session; a later start opens a NEW session", () => {
    for (const kind of ["stop", "escalate", "stopped", "converged"] as const) {
      const ended = deriveLoopSession([ev("2026-01-01T00:00:00Z", "start", { mode: "apply" }), ev("2026-01-02T00:00:00Z", kind)]);
      assert.deepEqual(ended, { active: false, endedBy: kind, endedAt: "2026-01-02T00:00:00Z" }, kind);
      const again = deriveLoopSession([
        ev("2026-01-01T00:00:00Z", "start", { mode: "apply" }),
        ev("2026-01-02T00:00:00Z", kind),
        ev("2026-01-03T00:00:00Z", "start", { mode: "suggest", actor: "c" }),
      ]);
      assert.deepEqual(again, { active: true, startIso: "2026-01-03T00:00:00Z", mode: "suggest", starter: "c" }, kind);
    }
  });

  it("events are folded in time order regardless of input order", () => {
    const s = deriveLoopSession([
      ev("2026-01-03T00:00:00Z", "start", { mode: "apply" }),
      ev("2026-01-02T00:00:00Z", "escalate"),
      ev("2026-01-01T00:00:00Z", "start", { mode: "suggest" }),
    ]);
    assert.equal(s.startIso, "2026-01-03T00:00:00Z");
  });

  it("same-second ties put terminal events first: a start in the handoff's second opens a new session", () => {
    const s = deriveLoopSession([
      ev("2026-01-01T00:00:00Z", "start", { mode: "apply" }),
      ev("2026-01-02T00:00:00Z", "start", { mode: "suggest", actor: "new" }),
      ev("2026-01-02T00:00:00Z", "escalate"),
    ]);
    assert.deepEqual(s, { active: true, startIso: "2026-01-02T00:00:00Z", mode: "suggest", starter: "new" });
  });

  it("the STOPPED marker acknowledges a prior human stop (idempotent emission); terminals with no session are no-ops", () => {
    const acked = deriveLoopSession([
      ev("2026-01-01T00:00:00Z", "start", { mode: "apply" }),
      ev("2026-01-02T00:00:00Z", "stop", { actor: "bob" }),
      ev("2026-01-02T00:00:05Z", "stopped"),
    ]);
    assert.equal(acked.endedBy, "stopped");
    const stray = deriveLoopSession([ev("2026-01-01T00:00:00Z", "stop"), ev("2026-01-02T00:00:00Z", "escalate")]);
    assert.deepEqual(stray, { active: false });
  });

  it("events without a timestamp are ignored (never fold an undatable event)", () => {
    assert.equal(deriveLoopSession([ev("", "start", { mode: "apply" })]).active, false);
  });
});

describe("deriveLoopSession: a clean review ends the session only for the head the loop waits on", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const t = (i: number) => `2026-01-0${i}T00:00:00Z`;
  const start = ev(t(1), "start", { mode: "apply", actor: "alice" });
  const ACTIVE = { active: true, startIso: t(1), mode: "apply", starter: "alice" };

  it("a clean review of a head the loop already moved past (continue / push) is stale and ignored", () => {
    for (const kind of ["continue", "push"] as const) {
      const s = deriveLoopSession([start, ev(t(2), kind, { head: B }), ev(t(3), "converged", { head: A })], { liveHead: B });
      assert.deepEqual(s, ACTIVE, kind);
    }
  });

  it("a clean review of the LIVE head always ends the session", () => {
    const s = deriveLoopSession([start, ev(t(2), "continue", { head: B }), ev(t(3), "converged", { head: A })], { liveHead: A });
    assert.deepEqual(s, { active: false, endedBy: "converged", endedAt: t(3) });
  });

  it("a continuation posted AFTER a stale clean review resumes the session (anchor, mode, starter kept)", () => {
    const s = deriveLoopSession([start, ev(t(2), "converged", { head: A }), ev(t(3), "continue", { head: B })], { liveHead: B });
    assert.deepEqual(s, ACTIVE);
    const dup = deriveLoopSession(
      [start, ev(t(2), "converged", { head: A }), ev("2026-01-02T00:00:01Z", "converged", { head: A }), ev(t(3), "continue", { head: B })],
      { liveHead: B },
    );
    assert.deepEqual(dup, ACTIVE, "a duplicate clean review of the old head does not block the resume");
  });

  it("never resumes: the converged head is live, a stop or handoff followed it, the same head, or a mere push", () => {
    const ended = (events: LoopEvent[], liveHead?: string) => deriveLoopSession([start, ...events], { liveHead }).active;
    assert.equal(ended([ev(t(2), "converged", { head: A }), ev(t(3), "continue", { head: B })], A), false, "the live head is clean");
    assert.equal(ended([ev(t(2), "converged", { head: A }), ev(t(3), "stop", { actor: "bob" }), ev(t(4), "continue", { head: B })], B), false);
    assert.equal(ended([ev(t(2), "converged", { head: A }), ev(t(3), "escalate"), ev(t(4), "continue", { head: B })], B), false);
    assert.equal(ended([ev(t(2), "converged", { head: A }), ev(t(3), "continue", { head: A })], B), false, "same head");
    assert.equal(ended([ev(t(2), "converged", { head: A }), ev(t(3), "push", { head: B })], B), false, "a push after a real convergence starts nothing");
  });

  it("an unknown reviewed commit keeps the verdict (fails toward ending the loop)", () => {
    const s = deriveLoopSession([start, ev(t(2), "continue", { head: B }), ev(t(3), "converged")], { liveHead: B });
    assert.equal(s.active, false);
  });

  it("same second: the head move orders before the clean review (marks it stale)", () => {
    const s = deriveLoopSession([start, ev(t(2), "converged", { head: A }), ev(t(2), "continue", { head: B })], { liveHead: B });
    assert.deepEqual(s, ACTIVE);
  });

  it("a head move with no active session is a no-op; a new start forgets the old session's head", () => {
    assert.deepEqual(deriveLoopSession([ev(t(1), "continue", { head: B }), ev(t(2), "push", { head: B })]), { active: false });
    const s = deriveLoopSession(
      [start, ev(t(2), "continue", { head: B }), ev(t(3), "escalate"), ev(t(4), "start", { mode: "suggest", actor: "c" }), ev(t(5), "converged", { head: A })],
      { liveHead: B },
    );
    assert.equal(s.active, false, "the new session waits on no head yet: its clean review ends it");
  });
});
