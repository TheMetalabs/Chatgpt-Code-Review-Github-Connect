/**
 * The control-write MATRIX (#79 K1): every way a control comment is written (9 entry paths over
 * the 4 control kinds) × what its POST did × what the list shows × what happens next, checked
 * against what the loop owes a human:
 *   I1 exactly once — a write that may have landed is never POSTed again (≤ 1 row);
 *   I2 never silent — an unresolved result is always logged (never a SILENT_REASONS exit);
 *   I3 closed outcome — each entry point reports the outcome the cell implies;
 *   I4 reconcile — a row that shows up later confirms the write: one event, no leftover stand-in;
 *   I5 read-your-writes — the loop acts on its own write before the list shows it;
 *   I6 a newer session is never ended by an older record.
 * One table instead of one test per bug: each review round found another cell of this space.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type BotSettings, type Finding, type Job, type SamplePr } from "./types.ts";
import {
  canonicalContinuation,
  isoMs,
  parseEscalateMarker,
  parseStartMarker,
  parseStopRecord,
  startComment,
} from "./review-loop.ts";
import { readLoopEvents, readLoopSession } from "./review-loop-engine.server.ts";
import { controlKey, ownWrites, type ControlKey } from "./review-loop-control.ts";
import {
  continueLoopOnPush,
  runPostReviewLoop,
  SILENT_REASONS,
  START_UNRESOLVED,
  startLoop,
  stopLoop,
  type LoopRuntimeDeps,
  type LoopStepResult,
} from "./review-loop-runtime.server.ts";
import type { LoopEvent } from "./review-loop-session.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40); // the reviewed head
const PUSHED = "b".repeat(40); // a human push (continue:push)
const LIVE = "c".repeat(40); // the live head a superseded step finds
const MOVED = "d".repeat(40); // a push that lands while the fix request runs
const NEW_SHA = "e".repeat(40); // the applied round's commit
const T0 = Date.parse("2026-03-01T00:00:00Z"); // the world clock starts here
const ALICE_AT = "2026-02-20T00:00:00Z"; // alice's start directive; review rounds follow it
const ENV = { ASHLAR_FIX_AGENT: "1", ASHLAR_LOOP_ROUND_CAP: "5" } as NodeJS.ProcessEnv;
const EDIT = '{"summary":"guard removed","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}';
const iso = (ms: number) => new Date(ms).toISOString();
const reviewDay = (i: number) => iso(Date.parse("2026-02-21T00:00:00Z") + i * 86_400_000);

// Reason strings the classifier keys on (the runtime keeps them private).
const SUPERSEDED = "superseded (head moved)";
const ALREADY_ESCALATED = "already escalated on this head";
const NO_SESSION = "no active loop session";

/** harbor's logging rule for a control entry point's result. */
const controlResultLogged = (r: { reason: string; unresolved?: true }) => r.unresolved === true || /failed/.test(r.reason);

type Via =
  | "start:admission"
  | "start:self-heal"
  | "stop:webhook"
  | "continue:push"
  | "continue:applied"
  | "continue:superseded"
  | "continue:moved-mid-round"
  | "handoff:stuck"
  | "handoff:terminal";
type Write = "success" | "rejected" | "unknown-landed" | "unknown-lost";
type List = "normal" | "lagging" | "failing";
type Later = "redelivery" | "newer-start" | "25h" | "row-appears";
type Phase = "call" | "view" | "again" | "follow";
type Cell = { via: Via; write: Write; list: List; later: Later };
type ControlResult = { posted: boolean; reason: string; unresolved?: true };
type Result = ControlResult | LoopStepResult;
/** posted / exists / unknown / rejected as the entry point reports it; `ran` a step that ran
 * (the self-heal); `resolved` a step result that needs nothing more (posted and exists collapse). */
type Cls = "posted" | "exists" | "unknown" | "rejected" | "unreadable" | "ran" | "resolved";

const VIAS: Via[] = [
  "start:admission",
  "start:self-heal",
  "stop:webhook",
  "continue:push",
  "continue:applied",
  "continue:superseded",
  "continue:moved-mid-round",
  "handoff:stuck",
  "handoff:terminal",
];
const WRITES: Write[] = ["success", "rejected", "unknown-landed", "unknown-lost"];
const LISTS: List[] = ["normal", "lagging", "failing"];
const LATERS: Later[] = ["redelivery", "newer-start", "25h", "row-appears"];

const kindOf = (via: Via) => via.slice(0, via.indexOf(":")) as ControlKey["kind"];
/** The head a continuation under test is for. */
const CONTINUE_HEAD: Partial<Record<Via, string>> = {
  "continue:push": PUSHED,
  "continue:applied": NEW_SHA,
  "continue:superseded": LIVE,
  "continue:moved-mid-round": MOVED,
};

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
const sample = { changedPaths: ["src/a.ts"], files: [{ path: "src/a.ts", content: "export const a = 1;\n", language: "ts" }] } as unknown as SamplePr;
const settings = (mode: "suggest" | "apply"): BotSettings => ({ ...DEFAULT_SETTINGS, fixAgent: { provider: "local", delivery: "script-apply", mode, parallelPrs: 3 } });

function job(pr: number, over: Partial<Job> = {}): Job {
  return {
    deliveryId: "d",
    trigger: "issue_comment.mention",
    owner: "o",
    repo: "r",
    pr,
    title: "t",
    headSha: HEAD,
    baseSha: "b",
    sender: "alice",
    isFork: false,
    isDraft: false,
    origin: "github",
    thread: { kind: "mention", commentId: 1, userText: "@ashlar-bot review" },
    id: `job-${pr}`,
    status: "posted",
    createdAt: T0,
    updatedAt: T0,
    ingressMs: 1,
    traces: [],
    plan: "",
    candidates: [],
    findings: [finding],
    investigatedSafe: [],
    assumptions: [],
    ...over,
  } as Job;
}

const writeError = (outcome: "rejected" | "unknown", status: number) =>
  Object.assign(new Error(`GitHub issue comment ${status}`), { name: "GithubWriteError", status, outcome });

type IssueRow = { id: number; userLogin: string; body: string; createdAt: string };

/** One PR's GitHub, with a fake clock: ids grow with creation, the write under test follows the
 * cell's script, and the list outage (lag or failure) starts at that write's first POST. */
class World {
  clock = T0;
  phase: Phase = "call";
  readonly issues: IssueRow[] = [];
  readonly reviews: Array<{ head: string; total: number; at: string }> = [];
  readonly posted: string[] = [];
  readonly prompts: string[] = [];
  /** The phase of every POST of the write under test. */
  readonly underTest: Phase[] = [];
  rowsForWrite = 0;
  carolAt?: string;
  committed = false;
  private nextId = 1;
  private lagFrom = Infinity;
  private failing = false;
  private hook?: () => Promise<void>;
  readonly deps: LoopRuntimeDeps;
  readonly ref: { owner: string; repo: string; pr: number };
  readonly cell: Cell;
  readonly pr: number;

  constructor(cell: Cell, pr: number) {
    this.cell = cell;
    this.pr = pr;
    this.ref = { owner: "o", repo: "r", pr };
    const { via } = cell;
    if (kindOf(via) !== "start") this.store(BOT, startComment({ mode: this.mode(), by: "alice", at: ALICE_AT }), ALICE_AT);
    const rounds = via === "handoff:stuck" ? [5, 4, 3, 2, 2, 2] : [3];
    rounds.forEach((total, i) => this.reviews.push({ head: i === rounds.length - 1 ? HEAD : String(i).repeat(40), total, at: reviewDay(i) }));
    const read = () => {
      if (this.failing) throw new Error("list 502");
    };
    const gh: LoopRuntimeDeps["gh"] = {
      listIssueComments: async () => (read(), this.issues.filter((r) => r.id < this.lagFrom).map((r) => ({ ...r }))),
      listPullReviews: async () => (read(), this.reviews.map((r) => ({ userLogin: BOT, body: `<!-- ashlar-findings total=${r.total} -->`, commitId: r.head, submittedAt: r.at }))),
      listReviewComments: async () => (read(), this.reviews.map((r) => ({ userLogin: BOT, path: "src/a.ts", commitId: r.head, createdAt: r.at, body: "finding" }))),
      createIssueComment: async (_t, o) => this.create(o.body),
      fetchPullHeadRef: async () => ({ ref: "feature", sha: this.live(), fork: false, sameRepo: true }),
      fetchUserPermission: async () => "write",
      listReviewThreadRoots: async () => [],
      replyToReviewComment: async () => {},
      gitDataApi: () => ({
        baseTreeSha: async () => "tree",
        createBlob: async () => "blob",
        createTree: async () => "tree2",
        createCommit: async () => NEW_SHA,
        updateBranchRef: async () => void (this.committed = true),
      }),
    };
    const base: LoopRuntimeDeps = {
      gh,
      requestFix: async (prompt) => {
        this.prompts.push(prompt);
        return via === "handoff:terminal" && this.phase !== "follow" ? "not json" : EDIT;
      },
      validate: async () => ({ ok: true }),
      sleep: async (ms) => {
        this.clock += ms;
        const hook = this.hook;
        this.hook = undefined;
        if (hook) await hook();
      },
    };
    // The control-write clock (a non-literal object, so this compiles before the field exists).
    const clock = { now: () => this.clock };
    this.deps = Object.assign(base, clock);
  }

  mode(): "suggest" | "apply" {
    return this.cell.via === "continue:applied" ? "apply" : "suggest";
  }

  live(): string {
    switch (this.cell.via) {
      case "continue:push":
        return PUSHED;
      case "continue:superseded":
        return LIVE;
      case "continue:applied":
        return this.committed ? NEW_SHA : HEAD;
      case "continue:moved-mid-round":
        return this.prompts.length > 0 ? MOVED : HEAD;
      default:
        return HEAD;
    }
  }

  /** The journal key of the write under test. */
  key(): string {
    const ref = this.ref;
    switch (kindOf(this.cell.via)) {
      case "start":
        return controlKey({ kind: "start", ref, by: "alice", at: ALICE_AT, mode: "suggest" });
      case "stop":
        return controlKey({ kind: "stop", ref, by: "bob", at: iso(T0) });
      case "continue":
        return controlKey({ kind: "continue", ref, head: CONTINUE_HEAD[this.cell.via]!, sessionIso: ALICE_AT });
      case "handoff":
        return controlKey({ kind: "handoff", ref, head: HEAD, sessionIso: ALICE_AT });
    }
  }

  /** Is this POST the write under test? (Never in the follow phase: that is a new session's work.) */
  private underTestPost(body: string): boolean {
    if (this.phase === "follow") return false;
    const bot = { authoredByBot: true };
    switch (kindOf(this.cell.via)) {
      case "start":
        return parseStartMarker(body, bot)?.by === "alice";
      case "stop":
        return parseStopRecord(body, bot)?.by === "bob";
      case "continue":
        return canonicalContinuation(body, bot)?.head === CONTINUE_HEAD[this.cell.via];
      case "handoff":
        return parseEscalateMarker(body, bot)?.head === HEAD;
    }
  }

  private store(userLogin: string, body: string, createdAt: string): IssueRow {
    const row = { id: this.nextId++, userLogin, body, createdAt };
    this.issues.push(row);
    if (userLogin === BOT) this.posted.push(body);
    return row;
  }

  private async create(body: string) {
    this.clock += 1_000; // GitHub stamps the row after the request left
    const at = iso(this.clock);
    if (!this.underTestPost(body)) return this.store(BOT, body, at);
    if (this.underTest.length === 0) this.outage();
    this.underTest.push(this.phase);
    const { write } = this.cell;
    if (write === "rejected") throw writeError("rejected", 422);
    if (write === "unknown-lost") throw writeError("unknown", 502);
    const row = this.store(BOT, body, at);
    this.rowsForWrite += 1;
    if (write === "unknown-landed") throw writeError("unknown", 502);
    return row;
  }

  /** The list outage starts at the write's first POST; carol's newer start waits for its backoff. */
  private outage(): void {
    if (this.cell.list === "lagging") this.lagFrom = this.nextId;
    if (this.cell.list === "failing") this.failing = true;
    if (this.cell.later === "newer-start" && this.cell.write !== "success") this.hook = () => this.injectCarol();
  }

  disarm(): void {
    this.hook = undefined;
  }

  catchUp(): void {
    this.lagFrom = Infinity;
    this.failing = false;
  }

  async injectCarol(): Promise<void> {
    if (this.carolAt) return;
    this.carolAt = iso(this.clock);
    await startLoop("t", { ...this.ref, actor: "carol", mode: "suggest", at: this.carolAt }, settings("suggest"), this.deps, ENV);
  }

  /** The entry call of the cell's path (also its redelivery). */
  enter(): Promise<Result> {
    const s = settings(this.mode());
    switch (this.cell.via) {
      case "start:admission":
        return startLoop("t", { ...this.ref, actor: "alice", mode: "suggest", at: ALICE_AT }, s, this.deps, ENV);
      case "start:self-heal": {
        const thread = { kind: "mention" as const, commentId: 5, userText: "/review-loop", loop: { kind: "start" as const, mode: "suggest" as const }, eventAt: ALICE_AT };
        return runPostReviewLoop("t", job(this.pr, { thread }), sample, s, this.deps, ENV);
      }
      case "stop:webhook":
        return stopLoop("t", { ...this.ref, actor: "bob", stopAt: iso(T0) }, s, this.deps, ENV);
      case "continue:push":
        return continueLoopOnPush("t", { ...this.ref, headSha: PUSHED, actor: "alice" }, s, this.deps, ENV);
      default:
        return runPostReviewLoop("t", job(this.pr), sample, s, this.deps, ENV);
    }
  }

  /** A plain review of `head` (no loop directive): a loop round iff a session is active. */
  plainStep(head = HEAD, id = "plain"): Promise<LoopStepResult> {
    return runPostReviewLoop("t", job(this.pr, { headSha: head, id }), sample, settings(this.mode()), this.deps, ENV);
  }

  session() {
    return readLoopSession(this.deps.gh, "t", "o", "r", this.pr, { botLogin: BOT, pr: { sha: this.live() } });
  }

  /** The events that stand for the write under test. */
  async eventsOfWrite(): Promise<LoopEvent[]> {
    const events = await readLoopEvents(this.deps.gh, "t", "o", "r", this.pr, { botLogin: BOT, pr: { sha: this.live() } });
    return events.filter((e) => {
      switch (kindOf(this.cell.via)) {
        case "start":
          return e.kind === "start" && e.actor?.toLowerCase() === "alice" && isoMs(e.at) === isoMs(ALICE_AT);
        case "stop":
          return e.kind === "stop" && e.actor === "bob" && isoMs(e.at) === T0;
        case "continue":
          return e.kind === "continue" && e.head === CONTINUE_HEAD[this.cell.via];
        case "handoff":
          return e.kind === "escalate";
      }
    });
  }
}

// ── classification ──────────────────────────────────────────────────────────────

function controlClass(r: ControlResult): string {
  const why = r.reason;
  if (/list 502/.test(why)) return "unreadable";
  if (why === "started" || why === "stopped" || why === "continued") return r.posted ? "posted" : `other: ${why}`;
  if (/already (recorded|continued)$/.test(why)) return "exists";
  if (why.startsWith(START_UNRESOLVED) || /outcome unknown/.test(why)) return "unknown";
  if (/^(start failed|stop failed|continue on push failed)/.test(why)) return "rejected";
  if (why === NO_SESSION || why === SUPERSEDED) return "resolved";
  return `other: ${why}`;
}

function stepClass(w: World, r: LoopStepResult): string {
  const { via } = w.cell;
  if (r.ran && r.step === "escalated") {
    if (via.startsWith("handoff:")) return "posted";
    return via === "continue:applied" && r.reason === "loop-error" ? "rejected" : `other: ${JSON.stringify(r)}`;
  }
  if (r.ran && via === "start:self-heal") return "ran";
  if (r.ran && via === "continue:applied") {
    if (r.continued === true) return "resolved";
    const report = w.posted.find((b) => b.startsWith("### Ashlar fix agent — applied")) ?? "";
    const handoffs = w.posted.filter((b) => b.startsWith("<!-- ashlar-loop-escalate")).length;
    return /Continuation outcome unknown/.test(report) && handoffs === 0 ? "unknown" : `other: ${JSON.stringify(r)}`;
  }
  if (r.ran) return `other: ${JSON.stringify(r)}`;
  const why = r.reason;
  if (/^loop step failed|could not be read/.test(why)) return "unreadable";
  if (/^start failed|could not be requested|failed to post/.test(why)) return "rejected";
  if (why.startsWith(START_UNRESOLVED) || /outcome is unknown|handed off \(outcome unknown\)/.test(why)) return "unknown";
  if (why === SUPERSEDED || why === ALREADY_ESCALATED || why === NO_SESSION) return "resolved";
  return `other: ${why}`;
}

const isControl = (r: Result): r is ControlResult => "posted" in r;
const classify = (w: World, r: Result): string => (isControl(r) ? controlClass(r) : stepClass(w, r));

/** A step path's result collapses outcomes the cell distinguishes. */
function norm(via: Via, e: Cls, when: "first" | "again"): Cls {
  if (via === "start:self-heal") return e === "posted" || e === "exists" || e === "unknown" ? "ran" : e;
  if (via.startsWith("continue:") && via !== "continue:push") return e === "posted" || e === "exists" ? "resolved" : e;
  if (via.startsWith("handoff:")) return e === "exists" || (when === "again" && e === "posted") ? "resolved" : e;
  return e;
}

function expectFirst(c: Cell): Cls {
  if (c.via === "start:self-heal" && c.list === "failing" && c.write !== "rejected") return "unreadable"; // re-reads after the emit
  const e: Cls = c.write === "success" ? "posted" : c.write === "rejected" ? "rejected" : c.write === "unknown-landed" && c.list === "normal" ? "exists" : "unknown";
  return norm(c.via, e, "first");
}

function expectAgain(c: Cell, caughtUp: boolean): Cls {
  const list = caughtUp ? "normal" : c.list;
  if (list === "failing" && c.via !== "start:admission") return "unreadable"; // it reads the session before emitting
  let e: Cls = c.write === "success" ? "exists" : c.write === "rejected" ? "rejected" : c.write === "unknown-landed" && list === "normal" ? "exists" : "unknown";
  // A refused continuation of a push or an applied round ended the session with a loop-error
  // handoff for that head: the redelivery has nothing left to do.
  if (c.write === "rejected" && (c.via === "continue:push" || c.via === "continue:applied")) e = "resolved";
  return norm(c.via, e, "again");
}

// ── invariants ──────────────────────────────────────────────────────────────────

/** I2: an unresolved outcome — or any result while the write's outcome is still unknown — is logged. */
function assertLogged(w: World, r: Result, cls: string, label: string): void {
  const unresolved = cls === "unknown" || cls === "rejected" || cls === "unreadable" || ownWrites(w.deps.gh).state(w.key()) === "unknown";
  if (!unresolved) return;
  const logged = isControl(r) ? controlResultLogged(r) : !(r.ran === false && SILENT_REASONS.includes(r.reason));
  assert.ok(logged, `I2 ${label}: an unresolved result is silent: ${JSON.stringify(r)}`);
}

/** I1: no POST of the write after one that may have landed; at most one row. */
function assertExactlyOnce(w: World): void {
  if (w.cell.write !== "rejected") assert.ok(w.underTest.length <= 1, `I1: ${w.underTest.length} POSTs (${w.underTest.join(", ")})`);
  assert.ok(w.rowsForWrite <= 1, `I1: ${w.rowsForWrite} rows`);
}

/** I5: the loop acts on its own write before the list shows it. */
async function assertReadsOwnWrite(w: World): Promise<void> {
  const { via, write } = w.cell;
  const before = w.prompts.length;
  if (via === "start:admission") {
    const r = await w.plainStep();
    assert.equal(r.ran, write !== "rejected", `I5: a plain review step after the start: ${JSON.stringify(r)}`);
  } else if (via === "stop:webhook") {
    const r = await w.plainStep();
    assert.equal(r.ran, false, `I5: a step ran past the stop: ${JSON.stringify(r)}`);
    assert.equal(w.prompts.length, before, "I5: a fix was requested past the stop");
  } else if (via.startsWith("handoff:")) {
    await w.enter(); // the same review again
    if (write !== "rejected") assert.equal(w.prompts.length, before, "I5: a fix ran past the handoff");
  } else if (via.startsWith("continue:")) {
    const n = (await w.eventsOfWrite()).length;
    assert.equal(n, write === "rejected" ? 0 : 1, `I5: ${n} continue events for the head`);
  }
}

/** I4: once the row is listed, one session read confirms the entry and no stand-in is left. */
async function assertReconciled(w: World): Promise<void> {
  const { write } = w.cell;
  w.catchUp();
  await w.session();
  if (write === "success" || write === "unknown-landed") assert.equal(ownWrites(w.deps.gh).state(w.key()), "posted", "I4: the listed row confirms the journal entry");
  const n = (await w.eventsOfWrite()).length;
  const expected = write !== "rejected" || kindOf(w.cell.via) === "stop" ? 1 : 0; // a refused stop still stands (write-ahead)
  assert.equal(n, expected, `I4: ${n} events for the write`);
}

/** I6: carol's newer start is never ended by an older record; a step in her session runs. */
async function assertNewerSessionLives(w: World): Promise<void> {
  const { via, write } = w.cell;
  if (w.cell.list === "failing") w.catchUp();
  const s = await w.session();
  if (write === "rejected" && (via === "continue:push" || via === "continue:applied")) {
    // the loop-error handoff for the refused continuation came AFTER carol's start: it ends her
    // (re-issued) session legitimately — it is not an older record
    assert.ok(!s.active && s.endedBy === "escalate", `I6: ${JSON.stringify(s)}`);
    return;
  }
  // the step first (the runtime's own session read), then the durable session it saw
  w.clock += 1_000;
  w.reviews.push({ head: w.live(), total: 3, at: iso(w.clock) });
  w.phase = "follow";
  const r = await w.plainStep(w.live(), "follow");
  assert.equal(r.ran, true, `I6: the newer session's step did not run: ${JSON.stringify(r)}`);
  assert.ok(s.active, `I6: the newer session was ended: ${JSON.stringify(s)}`);
  const ended = kindOf(via) === "stop" || (kindOf(via) === "handoff" && write !== "rejected");
  if (ended) assert.equal(isoMs(s.startIso), isoMs(w.carolAt), `I6: the session is not carol's: ${JSON.stringify(s)}`);
  else assert.equal(s.starter, "carol", `I6: carol's start is not the latest: ${JSON.stringify(s)}`);
}

/** Cells that fail on this tree, by the fix that closes them: node:test reports them as todo, not
 * failed. Each fix deletes its group; the last one deletes gap(). A pattern is
 * `via | write | list | later`, each part `*` or a comma list. */
const OPEN: ReadonlyArray<readonly [string, string]> = [
  ["stop", "stop:webhook | success | normal,failing | row-appears"],
  ["stop", "stop:webhook | success | lagging | *"],
  ["stop", "stop:webhook | rejected | * | newer-start,row-appears"],
  ["stop", "stop:webhook | unknown-landed | normal | row-appears"],
  ["harbor", "start:admission | unknown-landed | lagging,failing | *"],
  ["harbor", "start:admission | unknown-lost | * | *"],
  ["harbor", "stop:webhook | unknown-landed | lagging,failing | *"],
  ["harbor", "stop:webhook | unknown-lost | * | *"],
  ["harbor", "continue:push | unknown-landed | lagging,failing | *"],
  ["harbor", "continue:push | unknown-lost | * | *"],
];

function gap(c: Cell): string | undefined {
  const parts = [c.via, c.write, c.list, c.later];
  const hit = OPEN.find(([, p]) => p.split(" | ").every((alt, i) => alt === "*" || alt.split(",").includes(parts[i])));
  return hit && `open until the ${hit[0]} fix (#79 K1)`;
}

async function runCell(c: Cell, pr: number): Promise<void> {
  const w = new World(c, pr);
  const realNow = Date.now;
  const realInfo = console.info;
  Date.now = () => w.clock; // defeats any wall-clock TTL in the 25 h cells
  console.info = () => {}; // the step trace is noise here
  try {
    const first = await w.enter();
    const cls = classify(w, first);
    assert.equal(cls, expectFirst(c), `I3 first: ${JSON.stringify(first)}`);
    assertLogged(w, first, cls, "first");
    w.disarm();
    if (c.later === "newer-start") {
      await w.injectCarol(); // a success had no backoff to inject it in
      await assertNewerSessionLives(w);
    } else {
      // I5 on a readable list (not beside carol's start, which would answer for the write)
      if (c.list !== "failing") {
        w.phase = "view";
        await assertReadsOwnWrite(w);
      }
      if (c.later === "25h") w.clock += 25 * 60 * 60_000;
      if (c.later === "row-appears") await assertReconciled(w);
      w.phase = "again";
      const again = await w.enter();
      const againCls = classify(w, again);
      assert.equal(againCls, expectAgain(c, c.later === "row-appears"), `I3 again: ${JSON.stringify(again)}`);
      assertLogged(w, again, againCls, "again");
    }
    assertExactlyOnce(w);
  } finally {
    Date.now = realNow;
    console.info = realInfo;
  }
}

describe("control writes: kind × write result × list read × later event (#79 K1)", () => {
  let row = 0;
  for (const via of VIAS)
    for (const write of WRITES)
      for (const list of LISTS)
        for (const later of LATERS) {
          const cell = { via, write, list, later };
          const pr = 1000 + row++;
          it(`${via} | ${write} | ${list} | ${later}`, { todo: gap(cell) }, () => runCell(cell, pr));
        }
});
