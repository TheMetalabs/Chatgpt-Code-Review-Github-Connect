import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertNever,
  controlKey,
  emitControl,
  LANDED_KEPT,
  ownWrites,
  type ControlKind,
  type ControlRow,
  type ControlWrite,
  type EmitContext,
  type EmitOutcome,
} from "./review-loop-control.ts";
import { canonicalContinuation, continueComment, escalateMarker, isoMs, parseStartMarker, startComment, stoppedComment } from "./review-loop.ts";
import { escalateNow, readLoopEvents, readLoopSession } from "./review-loop-engine.server.ts";
import { continueLoopOnPush, runPostReviewLoop, startLoop, stopLoop, type LoopRuntimeDeps } from "./review-loop-runtime.server.ts";
import { deriveLoopSession, type LoopEvent, type SessionRef } from "./review-loop-session.ts";
import { DEFAULT_SETTINGS, type BotSettings, type Finding, type Job, type SamplePr } from "./types.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40);
const T0 = Date.parse("2026-03-01T00:00:00Z");
const SESSION = "2026-02-20T00:00:00Z";
const ref = (pr = 1) => ({ owner: "o", repo: "r", pr });
const unknownErr = () => Object.assign(new Error("GitHub issue comment 502: Bad Gateway"), { outcome: "unknown", status: 502 });
const rejectedErr = () => Object.assign(new Error("GitHub issue comment 422"), { outcome: "rejected", status: 422 });

const handoff = (pr = 1, session: SessionRef = { at: SESSION }): ControlWrite => ({
  key: { kind: "handoff", ref: ref(pr), head: HEAD, session },
  body: `${escalateMarker({ reason: "fix-failed", round: 1, pr, head: HEAD })}\n\nhandoff`,
});

/** One write of each kind on PR 1, after the session anchor (ANCHOR). */
function writeOfEachKind(): Record<ControlKind, ControlWrite> {
  const LATER = "2026-02-25T00:00:00Z";
  // The session's start record precedes every row a world stores (id 0): a continuation or
  // handoff row is matched by its id, as in production once the start is listed.
  const session = { at: SESSION, seq: 0 };
  return {
    start: { key: { kind: "start", ref: ref(), by: "bob", at: LATER, mode: "apply" }, body: startComment({ mode: "apply", by: "bob", at: LATER }) },
    stop: { key: { kind: "stop", ref: ref(), by: "bob", at: LATER }, body: stoppedComment({ by: "bob", at: LATER }) },
    continue: {
      key: { kind: "continue", ref: ref(), head: HEAD, session },
      body: continueComment({ mode: "suggest", round: 2, pr: 1, head: HEAD }),
    },
    handoff: handoff(1, session),
  };
}
const ANCHOR: LoopEvent = { at: SESSION, kind: "start", actor: "alice", mode: "suggest", seq: 0 };

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
    // a session is named by its anchor instant, not its spelling
    const k = { kind: "continue" as const, ref: ref(), head: HEAD };
    assert.equal(controlKey({ ...k, session: { at: "2026-02-20T00:00:00Z" } }), controlKey({ ...k, session: { at: "2026-02-20T00:00:00.000Z" } }));
  });

  it("a session read while an emit is in flight (refused and backing off, or rendering its body) keeps its entry: a concurrent emit joins it", async () => {
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setImmediate(r));
      assert.ok(done(), "the first emit reached its pause");
    };
    const continuation = (body: ControlWrite["body"]): ControlWrite => ({
      key: { kind: "continue", ref: ref(), head: HEAD, session: { at: SESSION } },
      body,
    });
    const text = continueComment({ mode: "suggest", round: 2, pr: 1, head: HEAD });
    for (const pause of ["backoff", "body"] as const) {
      const f = world(pause === "backoff" ? ["rejected", "ok"] : ["ok"]);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let paused = false;
      const hold = async () => {
        paused = true;
        await gate;
      };
      // backoff: the first POST is refused and the retry waits (state "rejected"); body: the lazy
      // body is still being computed (state "intent")
      const ctx: EmitContext = { ...f.ctx, sleep: pause === "backoff" ? hold : f.ctx.sleep };
      const w = continuation(pause === "body" ? async () => (await hold(), text) : text);
      const first = emitControl(ctx, w);
      await until(() => paused);
      assert.deepEqual(ownWrites(f.gh).standIns(ref(), f.rows, BOT), [], `${pause}: a session read meanwhile`);
      const second = emitControl(ctx, w);
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.deepEqual(a, { status: "posted" }, pause);
      assert.deepEqual(b, a, `${pause}: the concurrent emit shares the first one's outcome`);
      assert.equal(f.posts(), pause === "backoff" ? 2 : 1, `${pause}: one successful POST`);
      assert.equal(f.rows.length, 1, `${pause}: one row`);
    }
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

  it("retention by state: a refused write is dropped at once; a landed one, listed or not, is kept until LANDED_KEPT later landings retire it; what may have landed, or is still owed, never is", async () => {
    const N = LANDED_KEPT + 500;
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
    // A refused write-ahead stop: honored until recorded.
    const stop: ControlWrite = { key: { kind: "stop", ref: ref(2), by: "bob", at: "2026-03-01T00:00:00Z" }, body: stoppedComment({ by: "bob", at: "2026-03-01T00:00:00Z" }) };
    journal.intend(stop);
    refused.add(2);
    assert.equal((await emitControl(ctx, stop)).status, "rejected");
    const posted = Array.from({ length: N }, (_, i) => handoff(3 + i));
    for (const [i, w] of posted.entries()) {
      assert.equal((await emitControl(ctx, w)).status, "posted");
      // half are reconciled by a session read, half are never read again (a terminal write)
      if (i % 2 === 0) assert.deepEqual(await reconcile(w.key.ref.pr), [], "a session read reconciles it");
      assert.equal(stateOf(w), "posted", "kept: it answers a later emit, and stands in when a read omits its row");
    }
    const rejected = Array.from({ length: N }, (_, i) => handoff(3 + N + i));
    for (const w of rejected) {
      refused.add(w.key.ref.pr);
      assert.equal((await emitControl(ctx, w)).status, "rejected");
      assert.equal(stateOf(w), undefined, "a refused write is dropped once no emit is in flight");
    }
    assert.equal(journal.seen(handoff(3 + 2 * N), [], BOT), false);
    assert.deepEqual(journal.stats(), { prs: LANDED_KEPT + 2, entries: LANDED_KEPT + 2 }, "the last LANDED_KEPT landings and the two unresolved entries; no empty per-PR map");
    assert.equal(stateOf(posted[N - LANDED_KEPT - 1]), undefined, "the oldest landings are retired");
    assert.equal(stateOf(posted[N - LANDED_KEPT]), "posted");
    assert.equal(journal.standIns(posted[N - 1].key.ref, [], BOT).length, 1, "a kept landing stands in for a read that omits its row");
    assert.equal(stateOf(stop), "rejected");
    assert.equal((await reconcile(2)).length, 1, "the refused stop is still honored");

    // A retired write is still never sent twice: the listed row answers the emit's scan.
    const sent = posts;
    assert.deepEqual(await emitControl(ctx, posted[0]), { status: "exists" });
    // The write that may have landed still blocks a second POST.
    assert.equal((await emitControl(ctx, handoff(1))).status, "unknown");
    assert.equal(posts, sent, "no POST");
    assert.equal(stateOf(handoff(1)), "unknown");
  });

  it("a listed row confirms an unknown entry: no stand-in beside it, and a later emit is 'exists'", async () => {
    const f = world(["landed"]);
    f.w.hidden = true; // the row landed but the list lags through the whole schedule
    assert.equal((await emitControl(f.ctx, handoff())).status, "unknown");
    const key = controlKey(handoff().key);
    assert.equal(ownWrites(f.gh).standIns(ref(), [], BOT).length, 1, "folded while unlisted");
    assert.deepEqual(ownWrites(f.gh).unresolved(ref(), "handoff").map((u) => u.key), [key]);
    assert.deepEqual(ownWrites(f.gh).standIns(ref(), f.rows, BOT), [], "the real row replaces the stand-in");
    assert.equal(ownWrites(f.gh).state(key), "posted");
    assert.deepEqual(ownWrites(f.gh).unresolved(ref(), "handoff"), []);
    assert.deepEqual(await emitControl(f.ctx, handoff()), { status: "exists" });
    assert.equal(f.posts(), 1);
  });

  it("a read behind a row an earlier read listed (a lagging replica) still shows the write, and nothing POSTs it again", async () => {
    const writes = writeOfEachKind();
    const at = (es: LoopEvent[]) => es.map((e) => ({ ...e, at: new Date(isoMs(e.at)).toISOString() })); // a record's marker time may be spelled otherwise
    for (const kind of Object.keys(writes) as ControlKind[]) {
      for (const plan of ["ok", "landed"] as const) {
        const label = `${kind} | ${plan}`;
        const f = world([plan]);
        f.w.hidden = true;
        const read = () => readLoopEvents(f.gh, "t", "o", "r", 1, { botLogin: BOT });
        assert.equal((await emitControl(f.ctx, writes[kind])).status, plan === "ok" ? "posted" : "unknown", label);
        f.w.hidden = false;
        const listed = await read(); // reconciles: the row is the write's event now
        assert.equal(listed.length, 1, `${label}: the listed row`);
        assert.equal(ownWrites(f.gh).state(controlKey(writes[kind].key)), "posted", `${label}: confirmed`);
        f.w.hidden = true; // the next read comes from a replica behind the one that listed it
        const behind = await read();
        assert.deepEqual(at(behind), at(listed), `${label}: the same event`);
        assert.deepEqual(deriveLoopSession([ANCHOR, ...behind]), deriveLoopSession([ANCHOR, ...listed]), `${label}: the session changed`);
        assert.deepEqual(await emitControl(f.ctx, writes[kind]), { status: "exists" }, `${label}: a later emit`);
        assert.equal(f.posts(), 1, `${label}: one POST`);
      }
    }
  });

  it("escalateNow after its handoff was listed once: a lagging or failed idempotency read posts no second handoff", async () => {
    for (const plan of ["ok", "landed"] as const) {
      for (const read of ["lagging", "failed"] as const) {
        const label = `${plan} | ${read}`;
        const f = world([plan]);
        const opts = { owner: "o", repo: "r", pr: 1, head: HEAD, reason: "fix-failed" as const, rounds: [], roundCap: 3, botLogin: BOT, session: { at: SESSION }, sleep: f.ctx.sleep, now: f.ctx.now };
        const first = await escalateNow(f.gh, "t", opts);
        assert.equal(first.escalated || first.ambiguous, true, label);
        const session = async () => deriveLoopSession([ANCHOR, ...(await readLoopEvents(f.gh, "t", "o", "r", 1, { botLogin: BOT }))]);
        const ended = await session(); // lists the handoff: reconciled
        assert.equal(ended.active, false, label);
        if (read === "lagging") f.w.hidden = true;
        const list = f.gh.listIssueComments;
        if (read === "failed") f.gh.listIssueComments = async () => Promise.reject(new Error("GitHub 502 on list"));
        assert.deepEqual(await escalateNow(f.gh, "t", opts), { escalated: false }, `${label}: the journal answers`);
        f.gh.listIssueComments = list;
        if (read === "lagging") assert.deepEqual(await session(), ended, `${label}: the handoff still ends the session`);
        assert.equal(f.posts(), 1, `${label}: one handoff POST`);
      }
    }
  });

  it("a landed terminal write whose PR is never read again (a handoff, a stop) is retired after LANDED_KEPT later landings; an unknown one never is", async () => {
    const START_AT = "2026-02-20T00:00:00Z";
    const byPr = new Map<number, ControlRow[]>();
    let id = 0;
    let posts = 0;
    let listFails = false;
    const rowsOf = (pr: number) => byPr.get(pr) ?? [];
    const gh = {
      async listIssueComments(_t: string, _o: string, _r: string, pr: number) {
        if (listFails) throw new Error("GitHub 502 on list");
        return [...rowsOf(pr)];
      },
      async listReviewComments() {
        return [];
      },
      async listPullReviews() {
        return [];
      },
      async fetchPullHeadRef() {
        return { ref: "feature", sha: HEAD, fork: false, sameRepo: true };
      },
      async createIssueComment(_t: string, o: { pr: number; body: string }) {
        posts++;
        if (o.pr === 1) throw unknownErr(); // lost: nothing stored
        const row = { id: ++id, userLogin: BOT, body: o.body, createdAt: new Date(T0 + id * 1_000).toISOString() };
        byPr.set(o.pr, [...rowsOf(o.pr), row]);
        return { ...row };
      },
    };
    const clock = { sleep: async () => {}, now: () => T0 };
    const handoffOn = (pr: number) =>
      escalateNow(gh as never, "t", { owner: "o", repo: "r", pr, head: HEAD, reason: "fix-failed", rounds: [], roundCap: 3, botLogin: BOT, session: { at: START_AT }, ...clock });
    const journal = ownWrites(gh);
    const handoffKey = (pr: number) => controlKey({ kind: "handoff", ref: ref(pr), head: HEAD, session: { at: START_AT } });

    assert.equal((await handoffOn(1)).ambiguous, true, "PR 1: the handoff's outcome is unknown");
    // PR 2: a stop that ends an active session (its record is the session's last control write)
    byPr.set(2, [{ id: ++id, userLogin: BOT, body: startComment({ mode: "suggest", by: "alice", at: START_AT }), createdAt: START_AT }]);
    const settings: BotSettings = { ...DEFAULT_SETTINGS, fixAgent: { provider: "local", delivery: "script-apply", mode: "suggest", parallelPrs: 3 } };
    const deps = { gh, requestFix: async () => "", validate: async () => ({ ok: true }), ...clock } as unknown as LoopRuntimeDeps;
    const STOP_AT = "2026-02-21T00:00:00Z";
    const env = { ASHLAR_FIX_AGENT: "1" } as NodeJS.ProcessEnv;
    assert.deepEqual(await stopLoop("t", { owner: "o", repo: "r", pr: 2, actor: "bob", stopAt: STOP_AT }, settings, deps, env), { posted: true, reason: "stopped" });
    const stopKey = controlKey({ kind: "stop", ref: ref(2), by: "bob", at: STOP_AT });
    assert.equal(journal.state(stopKey), "posted");
    // PRs 3.. each get one handoff, and no session read follows any of them
    const last = 3 + LANDED_KEPT;
    for (let pr = 3; pr <= last; pr++) assert.equal((await handoffOn(pr)).escalated, true, `PR ${pr}`);
    assert.deepEqual(journal.stats(), { prs: LANDED_KEPT + 1, entries: LANDED_KEPT + 1 }, "the last LANDED_KEPT landings and the unknown handoff");
    assert.equal(journal.state(stopKey), undefined, "the stop record was the oldest landing: retired");
    assert.equal(journal.state(handoffKey(3)), undefined, "retired");
    assert.equal(journal.state(handoffKey(4)), "posted");
    assert.equal(journal.state(handoffKey(1)), "unknown", "an unknown write is never retired");
    const sent = posts;
    listFails = true; // the idempotency read fails: the journal still answers for what it kept
    assert.equal((await handoffOn(1)).ambiguous, true);
    assert.deepEqual(await handoffOn(last), { escalated: false });
    assert.equal(posts, sent, "no second POST");
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
    const writes = writeOfEachKind();
    const anchor = ANCHOR;
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

describe("session identity: one continuation and one handoff per head per SESSION — named by its anchor instant; its start record's id only scopes the rows (#79 K1)", () => {
  const START = "2026-02-20T00:00:00Z"; // alice's and bob's start directives: the same second
  const PUSHED = "b".repeat(40);
  const bot = { authoredByBot: true };
  const continuation = (session: SessionRef): ControlWrite => ({
    key: { kind: "continue", ref: ref(), head: HEAD, session },
    body: continueComment({ mode: "suggest", round: 2, pr: 1, head: HEAD }),
  });
  const escalateIn = (f: ReturnType<typeof world>, session: SessionRef) =>
    escalateNow(f.gh, "t", { owner: "o", repo: "r", pr: 1, head: HEAD, reason: "fix-failed", rounds: [], roundCap: 3, botLogin: BOT, session, sleep: f.ctx.sleep, now: f.ctx.now });
  /** A start record stored by the fake (ids grow with creation). */
  const recordStart = (f: ReturnType<typeof world>, by: string, mode: "suggest" | "apply"): number => {
    const row = { id: f.rows.length + 1, userLogin: BOT, body: startComment({ mode, by, at: START }), createdAt: START };
    f.rows.push(row);
    return row.id;
  };

  it("the fold anchors at most one session in a second: whatever order a read lists a second's starts and terminal records in, the anchor instant is the same", () => {
    // at one instant the fold orders the App's terminal records, then starts, then human stops:
    // the second's starts are consecutive, so the first opens the session and the rest re-issue it
    const second: LoopEvent[] = [
      { at: START, kind: "start", actor: "alice", mode: "suggest", seq: 3 },
      { at: START, kind: "start", actor: "bob", mode: "apply" },
      { at: START, kind: "escalate" },
      { at: START, kind: "start", actor: "carol", mode: "suggest", seq: 2 },
    ];
    const orders = (xs: LoopEvent[]): LoopEvent[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((o) => [x, ...o])));
    for (const before of [[], [{ at: "2026-02-19T00:00:00Z", kind: "start", actor: "dave", mode: "suggest" }]] as LoopEvent[][]) {
      for (const stop of [[], [{ at: START, kind: "stop", actor: "erin" }]] as LoopEvent[][]) {
        const seen = new Set<string>();
        for (const order of orders([...second, ...stop])) {
          const s = deriveLoopSession([...before, ...order]);
          seen.add(JSON.stringify([s.active, isoMs(s.startIso), s.endedBy, isoMs(s.endedAt)]));
        }
        assert.equal(seen.size, 1, `${before.length} earlier start(s), ${stop.length} stop(s): ${[...seen].join(" | ")}`);
      }
    }
  });

  it("two starts in one second are ONE session: the second start's continuation and handoff find the first's posted or unknown ones — no second POST", async () => {
    for (const aStart of ["listed", "id-less"] as const) {
      for (const prior of ["posted", "unknown"] as const) {
        const label = `alice's start ${aStart} | her session's writes ${prior}`;
        // the continuation and handoff are the first two POSTs; every later one would succeed
        const f = world(prior === "posted" ? ["ok"] : ["lost", "lost", "ok"]);
        const aliceSeq = aStart === "listed" ? recordStart(f, "alice", "suggest") : undefined;
        const A: SessionRef = { at: START, ...(aliceSeq !== undefined ? { seq: aliceSeq } : {}) };
        assert.equal((await emitControl(f.ctx, continuation(A))).status, prior === "posted" ? "posted" : "unknown", label);
        const aHandoff = await escalateIn(f, A);
        assert.equal(prior === "posted" ? aHandoff.escalated : aHandoff.ambiguous, true, `${label}: ${JSON.stringify(aHandoff)}`);
        assert.equal(f.posts(), 2, label);
        // bob's start in the same second, recorded after those writes: it re-issues the session —
        // and a read that lists his record first (alice's id-less) anchors it there
        const B: SessionRef = { at: START, seq: recordStart(f, "bob", "apply") };
        for (const session of [B, A]) {
          const again = await emitControl(f.ctx, continuation(session));
          assert.equal(again.status, prior === "posted" ? "exists" : "unknown", `${label}: the continuation again (${JSON.stringify(session)})`);
          const handoffAgain = await escalateIn(f, session);
          assert.equal(handoffAgain.escalated, false, `${label}: the handoff again (${JSON.stringify(session)})`);
          assert.equal(handoffAgain.ambiguous, prior === "unknown" ? true : undefined, `${label}: ${JSON.stringify(handoffAgain)}`);
        }
        assert.equal(f.posts(), 2, `${label}: no second POST`);
      }
    }
  });

  it("a session that learns its start record's id between two emits keeps its one entry: no second POST", async () => {
    for (const kind of ["continue", "handoff"] as const) {
      for (const plan of ["ok", "landed", "lost"] as const) {
        const label = `${kind} | ${plan}`;
        const f = world([plan]);
        f.w.hidden = true; // the write's row is never listed here: only the journal answers
        const idless: SessionRef = { at: START };
        const listed: SessionRef = { ...idless, seq: recordStart(f, "alice", "suggest") };
        const expected = plan === "ok" ? "posted" : "unknown";
        const again = plan === "ok" ? "exists" : "unknown";
        const emit = async (session: SessionRef): Promise<string> => {
          if (kind === "continue") return (await emitControl(f.ctx, continuation(session))).status;
          const r = await escalateIn(f, session);
          return r.escalated ? "posted" : r.ambiguous ? "unknown" : r.error ? `error: ${r.error}` : "exists";
        };
        assert.equal(await emit(idless), expected, `${label}: while the start has no id`);
        assert.equal(await emit(listed), again, `${label}: once the start is listed`);
        assert.equal(await emit(idless), again, `${label}: named without its id again`);
        assert.equal(f.posts(), 1, `${label}: one POST`);
        const key = controlKey(kind === "continue" ? continuation(listed).key : handoff(1, listed).key);
        assert.equal(key, controlKey(kind === "continue" ? continuation(idless).key : handoff(1, idless).key), `${label}: one key`);
        assert.equal(ownWrites(f.gh).state(key), plan === "ok" ? "posted" : "unknown", label);
        assert.equal(ownWrites(f.gh).stats().entries, 1, `${label}: one entry`);
      }
    }
  });

  it("an emit whose read has no id for the session's start record, or an earlier one, keeps the entry's id scope: an older session's row never answers for it", async () => {
    for (const caller of [{ at: START }, { at: START, seq: 3 }] as SessionRef[]) {
      const label = JSON.stringify(caller);
      const f = world(["lost"]);
      const listed: SessionRef = { at: START, seq: 5 };
      assert.equal((await emitControl(f.ctx, continuation(listed))).status, "unknown", label);
      // the last session's continuation for the head: posted after alice's directive but before her
      // start record (id 4 < 5), so it is in her session by time (and by the looser id) only
      f.rows.push({ id: 4, userLogin: BOT, body: continuation(listed).body as string, createdAt: "2026-02-20T00:00:01Z" });
      assert.equal((await emitControl(f.ctx, continuation(caller))).status, "unknown", `${label}: the older row never confirms this session's write`);
      assert.equal((await emitControl(f.ctx, continuation(listed))).status, "unknown", label);
      assert.equal(f.posts(), 1, label);
    }
  });

  it("a handoff read whose session has no id for its start record keeps the entry's id scope: an older session's row never confirms the unknown handoff", async () => {
    const f = world(["lost"]);
    const listed: SessionRef = { at: START, seq: 5 };
    const key = controlKey(handoff(1, listed).key);
    assert.equal((await escalateIn(f, listed)).ambiguous, true);
    // the last session's handoff for the head: posted after alice's directive but before her start
    // record (id 3 < 5), so it is in her session by time only
    f.rows.push({ id: 3, userLogin: BOT, body: handoff(1, listed).body as string, createdAt: "2026-02-20T00:00:01Z" });
    for (const session of [{ at: START }, listed]) {
      const r = await escalateIn(f, session);
      assert.deepEqual([r.escalated, r.ambiguous], [false, true], `${JSON.stringify(session)}: ${JSON.stringify(r)}`);
      assert.equal(ownWrites(f.gh).state(key), "unknown", `${JSON.stringify(session)}: the older row never confirms this session's handoff`);
    }
    assert.equal(f.posts(), 1);
  });

  const NEW_SHA = "e".repeat(40); // a fix round's commit
  const ROUND_AT = "2026-02-21T00:00:00Z"; // the review of HEAD, in the session
  /** One PR through the runtime (push handler, loop step): `script` decides each POST ("ok";
   * "landed" = stored, then unknown; "lost" = unknown, nothing stored); `view.shown` is what the
   * list returns; `view.onFix` / `view.onCommit` run while a fix round requests its fix / writes
   * its commit. */
  function pushWorld(script: (body: string) => "ok" | "landed" | "lost") {
    let clock = T0;
    const rows: ControlRow[] = [];
    const posts: string[] = [];
    const view = { shown: (_id: number) => true, head: PUSHED, committed: false, onFix: async () => {}, onCommit: async () => {} };
    const round = () => ({ userLogin: BOT, commitId: HEAD, path: "src/a.ts", body: "<!-- ashlar-findings total=2 -->", submittedAt: ROUND_AT, createdAt: ROUND_AT });
    const gh = {
      async listIssueComments() {
        return rows.filter((r) => view.shown(r.id ?? 0)).map((r) => ({ ...r }));
      },
      async listReviewComments() {
        return [round()];
      },
      async listPullReviews() {
        return [round()];
      },
      async fetchPullHeadRef() {
        return { ref: "feature", sha: view.committed ? NEW_SHA : view.head, fork: false, sameRepo: true };
      },
      async fetchUserPermission() {
        return "write";
      },
      async listReviewThreadRoots() {
        return [];
      },
      async replyToReviewComment() {},
      gitDataApi: () => ({
        baseTreeSha: async () => "tree",
        createBlob: async () => "blob",
        createTree: async () => "tree2",
        createCommit: async () => NEW_SHA,
        updateBranchRef: async () => {
          view.committed = true;
          await view.onCommit();
        },
      }),
      async createIssueComment(_t: string, o: { body: string }) {
        posts.push(o.body);
        clock += 1_000;
        const step = script(o.body);
        if (step === "lost") throw unknownErr();
        const row = { id: rows.length + 1, userLogin: BOT, body: o.body, createdAt: new Date(clock).toISOString() };
        rows.push(row);
        if (step === "landed") throw unknownErr();
        return { ...row };
      },
    };
    const requestFix = async () => {
      await view.onFix();
      return '{"summary":"guard added","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}';
    };
    const deps = { gh, requestFix, validate: async () => ({ ok: true }), sleep: async (ms: number) => void (clock += ms), now: () => clock } as unknown as LoopRuntimeDeps;
    const settingsOf = (mode: "suggest" | "apply"): BotSettings => ({ ...DEFAULT_SETTINGS, fixAgent: { provider: "local", delivery: "script-apply", mode, parallelPrs: 3 } });
    const settings = settingsOf("suggest");
    const env = { ASHLAR_FIX_AGENT: "1" } as NodeJS.ProcessEnv;
    const finding: Finding = {
      id: "f1",
      status: "accepted",
      severity: "P1",
      file: "src/a.ts",
      line: 3,
      side: "RIGHT",
      title: "null deref",
      failureScenario: "x is undefined",
      rootCause: "missing guard",
      evidence: "line 3",
      recommendedFix: "guard it",
      recommendedTest: "add a test",
    } as Finding;
    const job = { owner: "o", repo: "r", pr: 1, headSha: HEAD, origin: "github", sender: "alice", id: "job", createdAt: T0, findings: [finding], thread: { kind: "mention", commentId: 1, userText: "review" } } as unknown as Job;
    const sample = { changedPaths: ["src/a.ts"], files: [{ path: "src/a.ts", content: "export const a = 1;\n", language: "ts" }] } as unknown as SamplePr;
    return {
      gh,
      rows,
      posts,
      view,
      step: (mode: "suggest" | "apply") => runPostReviewLoop("t", job, sample, settingsOf(mode), deps, env),
      start: (actor: string, mode: "suggest" | "apply") => startLoop("t", { owner: "o", repo: "r", pr: 1, actor, mode, at: START }, settings, deps, env),
      push: () => continueLoopOnPush("t", { owner: "o", repo: "r", pr: 1, headSha: PUSHED, actor: "alice" }, settings, deps, env),
      session: () => readLoopSession(gh, "t", "o", "r", 1, { botLogin: BOT }),
      continuations: () => posts.filter((b) => canonicalContinuation(b, bot) !== null).length,
      suggestions: () => posts.filter((b) => b.startsWith("### Ashlar fix agent — suggestion")).length,
    };
  }

  it("push handler: a session whose start record is listed only after its continuation was sent requests that review once", async () => {
    for (const cont of ["ok", "lost"] as const) {
      // alice's start record lands but its response is lost, and the list lags behind it
      const f = pushWorld((body) => (parseStartMarker(body, bot) ? "landed" : cont));
      f.view.shown = () => false;
      assert.equal((await f.start("alice", "suggest")).unresolved, true, cont);
      assert.equal((await f.session()).startSeq, undefined, `${cont}: the session has no start id yet`);
      const first = await f.push();
      assert.equal(first.posted || first.unresolved, true, `${cont}: ${JSON.stringify(first)}`);
      f.view.shown = (id) => id === 1; // the start record is listed; the continuation still lags
      assert.equal((await f.session()).startSeq, 1, `${cont}: the session learned its start id`);
      const again = await f.push();
      assert.equal(again.reason.startsWith(cont === "ok" ? "already continued" : "continuation outcome unknown"), true, `${cont}: ${JSON.stringify(again)}`);
      assert.equal(f.continuations(), 1, `${cont}: one continuation POST`);
    }
  });

  it("push handler: a start in the same second as an id-less one re-issues that session: its continuation is found, never POSTed again", async () => {
    for (const cont of ["ok", "lost"] as const) {
      let continuations = 0;
      // alice's start record is lost; her session's continuation `cont`; everything later lands
      const f = pushWorld((body) => {
        const start = parseStartMarker(body, bot);
        if (start) return start.by === "alice" ? "lost" : "ok";
        return continuations++ === 0 ? cont : "ok";
      });
      assert.equal((await f.start("alice", "suggest")).unresolved, true, cont);
      const first = await f.push();
      assert.equal(first.posted || first.unresolved, true, `${cont}: ${JSON.stringify(first)}`);
      assert.deepEqual(await f.start("bob", "apply"), { posted: true, reason: "started" }, cont);
      const s = await f.session();
      // bob's listed record now anchors the session (listed before alice's stand-in): same second
      assert.deepEqual([s.active, isoMs(s.startIso), s.startSeq], [true, isoMs(START), f.rows.length], `${cont}: ${JSON.stringify(s)}`);
      const again = await f.push();
      assert.equal(again.reason.startsWith(cont === "ok" ? "already continued" : "continuation outcome unknown"), true, `${cont}: ${JSON.stringify(again)}`);
      assert.equal(f.continuations(), 1, `${cont}: one continuation POST`);
    }
  });

  it("push handler: the list catching up to, or relapsing behind, a same-second start moves the session's anchor between its two starts — one continuation", async () => {
    // alice's start record is lost (a stand-in with no id for the life of the process); bob's, in
    // the same second, is stored (`bobStart`: its response too, or not). Which of the two anchors
    // depends on what a read lists: bob's listed record first, else alice's stand-in.
    for (const bobStart of ["ok", "landed"] as const) {
      for (const list of ["catches-up", "relapses"] as const) {
        const label = `bob's start ${bobStart} | the list ${list}`;
        const f = pushWorld((body) => {
          const start = parseStartMarker(body, bot);
          return start?.by === "alice" ? "lost" : start ? bobStart : "ok";
        });
        if (list === "catches-up") f.view.shown = () => false; // behind every row
        await f.start("alice", "suggest");
        await f.start("bob", "suggest");
        const before = await f.session();
        assert.deepEqual(await f.push(), { posted: true, reason: "continued" }, label);
        // bob's record (id 1) is listed, the continuation (id 2) not yet; or a replica behind both
        f.view.shown = list === "catches-up" ? (id) => id <= 1 : () => false;
        const after = await f.session();
        assert.notEqual(after.startSeq, before.startSeq, `${label}: the anchor moved to the other start`);
        assert.deepEqual([after.active, isoMs(after.startIso)], [true, isoMs(before.startIso)], `${label}: the same session`);
        assert.deepEqual(await f.push(), { posted: false, reason: "already continued" }, label);
        assert.equal(f.continuations(), 1, `${label}: one continuation POST`);
      }
    }
  });

  it("a start in the same second as a fix round's session re-issues it: a suggest round posts its suggestion, an applied round its continuation", async () => {
    for (const mode of ["suggest", "apply"] as const) {
      // alice's start record is lost (her session has no id); bob's start in the same second lands
      // while the round runs — its record now anchors the session (the fold lists it first)
      const f = pushWorld((body) => (parseStartMarker(body, bot)?.by === "alice" ? "lost" : "ok"));
      f.view.head = HEAD;
      assert.equal((await f.start("alice", mode)).unresolved, true, mode);
      const bob = () => f.start("bob", mode).then(() => {});
      if (mode === "suggest") f.view.onFix = bob;
      else f.view.onCommit = bob; // after the last checkpoint before the commit
      const r = await f.step(mode);
      const s = await f.session();
      const bobSeq = f.rows.find((row) => parseStartMarker(row.body, bot)?.by === "bob")?.id;
      assert.deepEqual([s.active, isoMs(s.startIso), s.startSeq], [true, isoMs(START), bobSeq], `${mode}: bob's record anchors the same session`);
      if (mode === "suggest") {
        assert.equal(r.ran, true, `${mode}: ${JSON.stringify(r)}`);
        assert.equal(f.suggestions(), 1, `${mode}: the round's suggestion`);
      } else {
        assert.equal(r.ran && r.step === "fix" && r.continued, true, `${mode}: ${JSON.stringify(r)}`);
        assert.equal(f.continuations(), 1, `${mode}: the round's continuation`);
      }
    }
  });

  it("a fix round whose anchor moves between two same-second starts recorded before it (the list catches up to one, or relapses behind it) is not taken over", async () => {
    for (const mode of ["suggest", "apply"] as const) {
      for (const list of ["catches-up", "relapses"] as const) {
        const label = `${mode} | the list ${list}`;
        // alice's start record is lost; bob's, in the same second, is stored before the round
        const f = pushWorld((body) => (parseStartMarker(body, bot)?.by === "alice" ? "lost" : "ok"));
        f.view.head = HEAD;
        if (list === "catches-up") f.view.shown = () => false; // behind every row
        await f.start("alice", mode);
        await f.start("bob", mode);
        const before = await f.session();
        // nothing new is started: only what the list shows changes, while the fix request runs
        // (suggest: the report checkpoint reads it) or once the commit is written (apply: the
        // post-commit check reads it; the starter check before the commit is another matter)
        const flip = async () => void (f.view.shown = list === "catches-up" ? () => true : () => false);
        if (mode === "suggest") f.view.onFix = flip;
        else f.view.onCommit = flip;
        const r = await f.step(mode);
        const after = await f.session();
        assert.notEqual(after.startSeq, before.startSeq, `${label}: the anchor moved to the other start`);
        assert.deepEqual([after.active, isoMs(after.startIso)], [true, isoMs(before.startIso)], `${label}: the same session`);
        if (mode === "suggest") {
          assert.equal(r.ran, true, `${label}: ${JSON.stringify(r)}`);
          assert.equal(f.suggestions(), 1, `${label}: the round's suggestion`);
        } else {
          assert.equal(r.ran && r.step === "fix" && r.continued, true, `${label}: ${JSON.stringify(r)}`);
          assert.equal(f.continuations(), 1, `${label}: the round's continuation`);
        }
      }
    }
  });
});
