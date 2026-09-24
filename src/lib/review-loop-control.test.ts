import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertNever,
  controlKey,
  emitControl,
  ownWrites,
  type ControlKind,
  type ControlRow,
  type ControlWrite,
  type EmitContext,
  type EmitOutcome,
} from "./review-loop-control.ts";
import { continueComment, escalateMarker, startComment, stoppedComment } from "./review-loop.ts";
import { readLoopEvents } from "./review-loop-engine.server.ts";
import { deriveLoopSession, type LoopEvent } from "./review-loop-session.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40);
const T0 = Date.parse("2026-03-01T00:00:00Z");
const SESSION = "2026-02-20T00:00:00Z";
const ref = (pr = 1) => ({ owner: "o", repo: "r", pr });
const unknownErr = () => Object.assign(new Error("GitHub issue comment 502: Bad Gateway"), { outcome: "unknown", status: 502 });
const rejectedErr = () => Object.assign(new Error("GitHub issue comment 422"), { outcome: "rejected", status: 422 });

const handoff = (pr = 1): ControlWrite => ({
  key: { kind: "handoff", ref: ref(pr), head: HEAD, sessionIso: SESSION },
  body: `${escalateMarker({ reason: "fix-failed", round: 1, pr, head: HEAD })}\n\nhandoff`,
  since: { iso: SESSION },
});

/** A GitHub fake: `plan` scripts each POST ("ok", "rejected", "landed" = stored then unknown, "lost"
 * = unknown, nothing stored); `hidden` keeps stored rows out of the list until it is cleared. */
function world(plan: Array<"ok" | "rejected" | "landed" | "lost"> = ["ok"]) {
  let clock = T0;
  let posts = 0;
  const rows: ControlRow[] = [];
  const w = { hidden: false };
  const gh = {
    async listIssueComments() {
      return w.hidden ? [] : [...rows];
    },
    async listReviewComments() {
      return [];
    },
    async listPullReviews() {
      return [];
    },
    async createIssueComment(_t: string, o: { body: string }) {
      const step = plan[Math.min(posts++, plan.length - 1)];
      clock += 1_000; // the server stamps the row after the request left
      const row = { id: rows.length + 1, userLogin: BOT, body: o.body, createdAt: new Date(clock).toISOString() };
      if (step === "rejected") throw rejectedErr();
      if (step === "lost") throw unknownErr();
      rows.push(row);
      if (step === "landed") throw unknownErr();
      return { ...row }; // GitHub's response, not the stored row
    },
  };
  const ctx: EmitContext = {
    gh,
    token: "t",
    botLogin: BOT,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { gh, ctx, rows, w, posts: () => posts, clock: () => clock, tick: (ms: number) => void (clock += ms) };
}

describe("emitControl + OwnWrites (#79 K1: one gate, one journal)", () => {
  it("an unknown outcome is stamped at the POST that returned it, not after the retry schedule", async () => {
    const f = world(["rejected", "lost"]);
    const out = await emitControl(f.ctx, handoff());
    assert.equal(f.posts(), 2, "the refused POST is retried; the unknown one is never sent again");
    assert.equal(out.status, "unknown");
    // attempt 1 at T0 (refused, 1 s round trip), 2 s backoff, attempt 2 at T0+3s (unknown), then
    // only a 5 s rescan
    const attempt2 = new Date(T0 + 3_000).toISOString();
    assert.equal(out.status === "unknown" && out.attemptAt, attempt2);
    assert.equal(f.clock(), T0 + 9_000, "the schedule ran on past the attempt");
    const events = ownWrites(f.gh).standIns(ref(), [], BOT);
    assert.deepEqual(events, [{ at: attempt2, kind: "escalate" }], "folded at its attempt");
  });

  it("two concurrent emits of one key make one POST and share its outcome", async () => {
    const f = world(["ok"]);
    const [a, b] = await Promise.all([emitControl(f.ctx, handoff()), emitControl(f.ctx, handoff())]);
    assert.equal(f.posts(), 1);
    assert.deepEqual(a, { status: "posted" });
    assert.deepEqual(b, a);
    assert.deepEqual(await emitControl(f.ctx, handoff()), { status: "exists" }, "a later emit finds this process's own write");
    assert.equal(f.posts(), 1);
    // the session part of a key is the anchor instant (an id-less unknown start cannot change it)
    const k = { kind: "continue" as const, ref: ref(), head: HEAD };
    assert.equal(controlKey({ ...k, sessionIso: "2026-02-20T00:00:00Z" }), controlKey({ ...k, sessionIso: "2026-02-20T00:00:00.000Z" }));
  });

  it("no eviction: 10k other writes and 25 h later, a write that may have landed is still unknown and never re-sent", async () => {
    const f = world(["lost", "ok"]);
    f.w.hidden = true;
    assert.equal((await emitControl(f.ctx, handoff(1))).status, "unknown");
    for (let pr = 2; pr <= 10_001; pr++) ownWrites(f.gh).intend(handoff(pr));
    f.tick(25 * 60 * 60_000);
    const realNow = Date.now;
    Date.now = () => f.clock(); // no wall-clock TTL may hide it either
    try {
      assert.equal((await emitControl(f.ctx, handoff(1))).status, "unknown");
    } finally {
      Date.now = realNow;
    }
    assert.equal(f.posts(), 1, "one POST");
    assert.equal(ownWrites(f.gh).state(controlKey(handoff(1).key)), "unknown");
  });

  it("eviction by state: thousands of reconciled posted writes and refused writes are pruned; what may have landed, or is still owed, is kept", async () => {
    const N = 2_000;
    let posts = 0;
    let lose = true; // the first POST's outcome is unknown and nothing is stored
    const refused = new Set<number>(); // PRs whose POSTs GitHub refuses
    const byPr = new Map<number, ControlRow[]>();
    const gh = {
      async listIssueComments(_t: string, _o: string, _r: string, pr: number) {
        return [...(byPr.get(pr) ?? [])];
      },
      async createIssueComment(_t: string, o: { pr: number; body: string }) {
        posts++;
        if (lose) {
          lose = false;
          throw unknownErr();
        }
        if (refused.has(o.pr)) throw rejectedErr();
        const row = { id: posts, userLogin: BOT, body: o.body, createdAt: new Date(T0 + posts * 1_000).toISOString() };
        byPr.set(o.pr, [...(byPr.get(o.pr) ?? []), row]);
        return { ...row };
      },
    };
    const ctx: EmitContext = { gh, token: "t", botLogin: BOT, sleep: async () => {}, now: () => T0 };
    const journal = ownWrites(gh);
    const stateOf = (w: ControlWrite) => journal.state(controlKey(w.key));
    const reconcile = async (pr: number) => journal.standIns(ref(pr), await gh.listIssueComments("t", "o", "r", pr), BOT);

    assert.equal((await emitControl(ctx, handoff(1))).status, "unknown");
    const posted = Array.from({ length: N }, (_, i) => handoff(2 + i));
    for (const w of posted) {
      assert.equal((await emitControl(ctx, w)).status, "posted");
      assert.equal(stateOf(w), "posted", "kept until the list shows it (it stands in meanwhile)");
      assert.deepEqual(await reconcile(w.key.ref.pr), [], "a session read reconciles it");
      assert.equal(stateOf(w), undefined, "a reconciled write is evicted");
    }
    const rejected = Array.from({ length: N }, (_, i) => handoff(2 + N + i));
    for (const w of rejected) {
      refused.add(w.key.ref.pr);
      assert.equal((await emitControl(ctx, w)).status, "rejected");
      assert.equal(stateOf(w), undefined, "a refused write is evicted once no emit is in flight");
    }
    // Kept: a posted write no session read has reconciled yet, and a refused write-ahead stop (both fold).
    const unlisted = handoff(2 + 2 * N);
    assert.equal((await emitControl(ctx, unlisted)).status, "posted");
    const stopPr = 3 + 2 * N;
    const stop: ControlWrite = { key: { kind: "stop", ref: ref(stopPr), by: "bob", at: "2026-03-01T00:00:00Z" }, body: stoppedComment({ by: "bob", at: "2026-03-01T00:00:00Z" }) };
    journal.intend(stop);
    refused.add(stopPr);
    assert.equal((await emitControl(ctx, stop)).status, "rejected");
    assert.equal(journal.seen(handoff(4 + 2 * N), [], BOT), false);
    assert.deepEqual(journal.stats(), { prs: 3, entries: 3 }, "only unresolved entries remain, and no empty per-PR map");
    assert.equal(stateOf(stop), "rejected");
    assert.equal((await reconcile(stopPr)).length, 1, "the refused stop is still honored");
    assert.equal((await reconcile(unlisted.key.ref.pr)).length, 0, "listed now: reconciled and evicted");

    // An evicted write is still never sent twice: the listed row answers the emit's scan.
    const sent = posts;
    assert.deepEqual(await emitControl(ctx, posted[0]), { status: "exists" });
    // The write that may have landed still blocks a second POST.
    assert.equal((await emitControl(ctx, handoff(1))).status, "unknown");
    assert.equal(posts, sent, "no POST");
    assert.equal(stateOf(handoff(1)), "unknown");
    assert.deepEqual(journal.stats(), { prs: 2, entries: 2 });
  });

  it("a listed row confirms an unknown entry: no stand-in beside it, the entry is evicted, and a later emit is 'exists'", async () => {
    const f = world(["landed"]);
    f.w.hidden = true; // the row landed but the list lags through the whole schedule
    assert.equal((await emitControl(f.ctx, handoff())).status, "unknown");
    const key = controlKey(handoff().key);
    assert.equal(ownWrites(f.gh).standIns(ref(), [], BOT).length, 1, "folded while unlisted");
    assert.deepEqual(ownWrites(f.gh).unresolved(ref(), "handoff").map((u) => u.key), [key]);
    assert.deepEqual(ownWrites(f.gh).standIns(ref(), f.rows, BOT), [], "the real row replaces the stand-in");
    assert.equal(ownWrites(f.gh).state(key), undefined, "reconciled, then evicted: the listed row answers for it");
    assert.deepEqual(ownWrites(f.gh).unresolved(ref(), "handoff"), []);
    f.w.hidden = false; // the list that reconciled it: its scan finds the row
    assert.deepEqual(await emitControl(f.ctx, handoff()), { status: "exists" });
    assert.equal(f.posts(), 1);
  });

  it("a posted write whose 2xx row has createdAt '' (production's shape for a missing created_at) stands in at its attempt", async () => {
    const f = world(["ok"]);
    const gh = { ...f.gh, createIssueComment: async () => ({ id: 7, userLogin: BOT, createdAt: "" }) };
    f.w.hidden = true; // the list lags: only the journal knows the row
    assert.deepEqual(await emitControl({ ...f.ctx, gh, scanFirst: false }, handoff()), { status: "posted" });
    const events = ownWrites(gh).standIns(ref(), [], BOT);
    assert.deepEqual(events, [{ at: new Date(T0).toISOString(), kind: "escalate" }], "an undatable stand-in would be dropped by the fold");
    const session = deriveLoopSession([{ at: SESSION, kind: "start", actor: "alice", mode: "suggest" }, ...events]);
    assert.equal(session.active, false, "the posted handoff ends the session in this process");
  });

  it("a write-ahead intent folds at once; abandon drops only an unsent entry; the outcome switch is exhaustive", async () => {
    const f = world(["ok"]);
    const stop: ControlWrite = { key: { kind: "stop", ref: ref(), by: "bob", at: "2026-03-01T00:00:00Z" }, body: stoppedComment({ by: "bob", at: "2026-03-01T00:00:00Z" }) };
    ownWrites(f.gh).intend(stop);
    assert.deepEqual(ownWrites(f.gh).standIns(ref(), [], BOT), [{ at: "2026-03-01T00:00:00Z", kind: "stop", actor: "bob" }]);
    ownWrites(f.gh).abandon(stop);
    assert.deepEqual(ownWrites(f.gh).standIns(ref(), [], BOT), [], "an unsent intent is forgotten");
    ownWrites(f.gh).intend(stop);
    assert.deepEqual(await emitControl(f.ctx, stop), { status: "posted" });
    ownWrites(f.gh).abandon(stop);
    assert.equal(ownWrites(f.gh).state(controlKey(stop.key)), "posted", "a sent write is never abandoned");
    const label = (o: EmitOutcome): string => {
      switch (o.status) {
        case "posted":
        case "exists":
        case "rejected":
          return o.status;
        default:
          // @ts-expect-error — "unknown" is not handled: an outcome can never be dropped silently
          return assertNever(o);
      }
    };
    assert.throws(() => label({ status: "unknown", attemptAt: "", error: "e" }), /unhandled case/);
  });

  it("a listed row the collector cannot place (createdAt '' or malformed) does not retire the stand-in: one event, the session unchanged", async () => {
    const LATER = "2026-02-25T00:00:00Z";
    // The session's start record precedes every row this world stores (id 0): a continuation or
    // handoff row is matched by its id, as in production once the start is listed.
    const since = { iso: SESSION, seq: 0 };
    const writes: Record<ControlKind, ControlWrite> = {
      start: { key: { kind: "start", ref: ref(), by: "bob", at: LATER, mode: "apply" }, body: startComment({ mode: "apply", by: "bob", at: LATER }) },
      stop: { key: { kind: "stop", ref: ref(), by: "bob", at: LATER }, body: stoppedComment({ by: "bob", at: LATER }) },
      continue: {
        key: { kind: "continue", ref: ref(), head: HEAD, sessionIso: SESSION },
        body: continueComment({ mode: "suggest", round: 2, pr: 1, head: HEAD }),
        since,
      },
      handoff: { ...handoff(), since },
    };
    const anchor: LoopEvent = { at: SESSION, kind: "start", actor: "alice", mode: "suggest", seq: 0 };
    const bare = (es: LoopEvent[]) => es.map(({ seq: _seq, ...e }) => e); // a listed start adds its id
    for (const kind of Object.keys(writes) as ControlKind[]) {
      for (const plan of ["ok", "landed"] as const) {
        for (const createdAt of ["", "yesterday"]) {
          const label = `${kind} | ${plan} | createdAt=${JSON.stringify(createdAt)}`;
          const f = world([plan]);
          f.w.hidden = true; // the first session read finds only the journal
          const read = () => readLoopEvents(f.gh, "t", "o", "r", 1, { botLogin: BOT });
          assert.equal((await emitControl(f.ctx, writes[kind])).status, plan === "ok" ? "posted" : "unknown", label);
          const before = await read();
          assert.equal(before.length, 1, `${label}: the stand-in`);
          for (const r of f.rows) r.createdAt = createdAt;
          f.w.hidden = false; // the list catches up with a row it cannot date
          for (const pass of ["reconciles", "after"]) {
            const after = await read();
            assert.deepEqual(bare(after), bare(before), `${label} (${pass}): exactly one equivalent event`);
            assert.deepEqual(deriveLoopSession([anchor, ...after]), deriveLoopSession([anchor, ...before]), `${label} (${pass}): the session changed`);
          }
          // The other paths that meet the listed row — the handoff idempotency read (seen) and a
          // re-emit's scan or re-check — prove the write exists and leave its stand-in as it was.
          assert.equal(ownWrites(f.gh).seen(writes[kind], f.rows, BOT), true, `${label}: seen`);
          assert.equal((await emitControl(f.ctx, writes[kind])).status, "exists", `${label}: the listed row still proves the write`);
          const later = await read();
          assert.deepEqual(bare(later), bare(before), `${label} (seen, re-emit): exactly one equivalent event`);
          assert.deepEqual(deriveLoopSession([anchor, ...later]), deriveLoopSession([anchor, ...before]), `${label} (seen, re-emit): the session changed`);
          assert.equal(f.posts(), 1, `${label}: one POST`);
        }
      }
    }
  });
});
