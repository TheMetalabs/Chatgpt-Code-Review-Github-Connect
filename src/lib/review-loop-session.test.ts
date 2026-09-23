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
