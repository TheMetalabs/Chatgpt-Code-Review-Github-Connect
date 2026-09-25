/**
 * The control-write MATRIX (#79 K1): every way a control comment is written (11 entry paths over
 * the 4 control kinds) × what its POST did (× the 2xx body it answered, decoded as production
 * decodes it, and the created row's server created_at) × what the list shows × what happens next — and, for a continuation or handoff, × how
 * its session's anchor start is known (listed, lagging, lost) × a peer start in the anchor's second
 * (none, before or after the write); for a stop, × what the session was before it (active, or ended
 * by a stale clean review whose resuming continuation lands after the stop's own time) — checked
 * against what the loop owes a human:
 *   I1 exactly once — a write that may have landed is never POSTed again (≤ 1 row);
 *   I2 never silent — an unresolved result is always logged (never a SILENT_REASONS exit);
 *   I3 closed outcome — each entry point reports the outcome the cell implies;
 *   I4 reconcile — a row that shows up later confirms the write: one event, no leftover stand-in;
 *      and a later read that lags behind that row again still shows the write once, and the same
 *      session (a replica behind the one that listed it — and behind the session's start records,
 *      so the anchor may move to another start of its second);
 *   I5 read-your-writes — the loop acts on its own write before the list shows it;
 *   I6 a newer session is never ended by an older record — also one started in the same second
 *      as the older write's POST (GitHub orders events at one-second resolution);
 *   I7 a human stop survives a restart — even one that found the session ended (or kept from
 *      resuming) only by this process's own write that may not be durable;
 *   I8 a stop stays the boundary before a newer session — its record is owed while it is not
 *      posted: a redelivery sends a refused one and only looks for an unknown one, and once it
 *      landed a restart anchors the newer session at its own start; posted while that session
 *      runs — a redelivery after it started, or a retry after it started during the backoff —
 *      the record is no terminal signal (no STOPPED marker, no STOPPED sentence), while a record
 *      posted with no session running is the STOPPED acknowledgement.
 *   I9 every POST attempt is decided against a fresh read — × what happens BETWEEN the write's
 *      first POST (refused) and its retry: nothing, a stop and a newer start, a start alone (it
 *      re-issues the running session), a push that moves the PR head. A continuation or handoff
 *      whose session is over, or a continuation whose head moved, is never sent again: no row,
 *      no event (an unknown retry's stand-in neither), no journal entry, and the newer session
 *      runs on; a stop's retry takes the record form its own read decides (I8); a retry that
 *      cannot read the session is not sent at all.
 *  I10 the App's own commit is no moved head — × how the step's reads of the PR head follow its
 *      commit (GitHub syncs a PR's head after a ref update): synced, the first read still shows
 *      the parent, or no read of the call catches up. The commit's continuation is decided owed
 *      and POSTed, and the report never says the head moved (unless a human push really moved it).
 *  I11 a joiner decides for itself — × who joins the step's in-flight continuation: nobody; the push
 *      handler for its head (whose read knows its push); that handler, and then a stale clean review
 *      that only a read knowing the push sees as stale. A joiner shares what the step's emit sent,
 *      but never its supersession: whenever the joiner's own read owes the continuation it reports
 *      what was sent (its own POST, if the step sent none), never a quiet superseded exit.
 * One table instead of one test per bug: each review round found another cell of this space.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type BotSettings, type Finding, type Job, type SamplePr } from "./types.ts";
import {
  canonicalContinuation,
  continueComment,
  isoMs,
  isStoppedComment,
  parseEscalateMarker,
  parseStartMarker,
  parseStopRecord,
  REVIEW_LOOP_STOPPED_HUMAN,
  startComment,
} from "./review-loop.ts";
import { readLoopEvents, readLoopSession, reconstructRounds } from "./review-loop-engine.server.ts";
import { controlKey, ownWrites, type ControlKey } from "./review-loop-control.ts";
import { postedIssueComment } from "./github-transport.ts";
import {
  continueLoopOnPush,
  controlResultLogged,
  runPostReviewLoop,
  SILENT_REASONS,
  START_UNRESOLVED,
  startLoop,
  stopLoop,
  type ControlResult,
  type LoopRuntimeDeps,
  type LoopStepResult,
} from "./review-loop-runtime.server.ts";
import { sameSession, sessionRef, type LoopEvent, type LoopSession, type SessionRef } from "./review-loop-session.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40); // the reviewed head
const PUSHED = "b".repeat(40); // a human push (continue:push)
const LIVE = "c".repeat(40); // the live head a superseded step finds
const MOVED = "d".repeat(40); // a push that lands while the fix request runs
const NEW_SHA = "e".repeat(40); // the applied round's commit
const FRESH = "f".repeat(40); // a human push after the write (later: push / moved)
const STALE = "9".repeat(40); // a head the loop had left, whose clean review lands late (prior: stale-resume)
const T0 = Date.parse("2026-03-01T00:00:00Z"); // the world clock starts here
const ALICE_AT = "2026-02-20T00:00:00Z"; // alice's start directive; review rounds follow it
const ENV = { ASHLAR_FIX_AGENT: "1", ASHLAR_LOOP_ROUND_CAP: "5" } as NodeJS.ProcessEnv;
const EDIT = '{"summary":"guard removed","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}';
const iso = (ms: number) => new Date(ms).toISOString();
/** GitHub's one-second resolution (rows and webhook event times). */
const second = (ms: number) => iso(Math.floor(ms / 1000) * 1000);
const reviewDay = (i: number) => iso(Date.parse("2026-02-21T00:00:00Z") + i * 86_400_000);

// Reason strings the classifier keys on (the runtime keeps them private).
const SUPERSEDED = "superseded (head moved)";
const NEWER = "superseded by a newer loop request (a new session, another starter, or apply downgraded to suggest)";
const ALREADY_ESCALATED = "already escalated on this head";
const NO_SESSION = "no active loop session";

type Via =
  | "start:admission"
  | "start:self-heal"
  | "stop:webhook"
  | "continue:push"
  | "continue:applied"
  | "continue:superseded"
  | "continue:moved-mid-round"
  | "handoff:stuck"
  | "handoff:terminal"
  | "handoff:push-loop-error"
  | "handoff:post-commit";
type Write = "success" | "rejected" | "unknown-landed" | "unknown-lost";
/** The body of the 2xx a POST that created its row answered with: the row (a success), or no
 * usable row — a row without an id, JSON null, a primitive — which leaves the row created and its
 * outcome unknown: an unknown-landed write, as a 502 ("none": no 2xx) is. */
type Shape = "none" | "row" | "row-without-id" | "null" | "primitive";
/** The created row's created_at in that answer (a success): the row's own time, "" (GitHub's
 * missing created_at, as production decodes it) or malformed — the listed row keeps its time. */
type Stamp = "valid" | "empty" | "malformed";
type List = "normal" | "lagging" | "failing";
/** What happens after the call. newer-start-redelivery (a stop): carol starts a newer session,
 * then the stop is redelivered — by then GitHub accepts a record it refused. */
type Later =
  | "redelivery"
  | "newer-start"
  | "newer-start-redelivery"
  | "same-second-start"
  | "25h"
  | "row-appears"
  | "row-relapses"
  | "push"
  | "moved"
  | "stop-restart";
/** How the session's anchor start is known (a continuation or handoff cell): alice's start record
 * listed from the first read (row 1); stored with its response lost and the call's reads behind
 * the session's start records (an id-less stand-in, then listed); or lost (an id-less stand-in for
 * the life of the process — a read that lists bob's record anchors there, one behind it at hers). */
type Anchor = "listed" | "lagging" | "lost";
/** bob's start in alice's second — a re-issue of her session, whose record a read may list first
 * and so anchor there — recorded before the write's call or after it. */
type Peer = "none" | "before" | "after";
/** What alice's session was before bob's stop (a stop cell): active, or — stale-resume — ended by a
 * clean review of a head the loop had left (it landed after the driver moved on), with the
 * driver's continuation for the live head, which resumes the session, landing after the stop's own
 * time and before its webhook is handled: only the stop keeps the session over. */
type Prior = "none" | "stale-resume";
/** What happens between the write's first POST — which GitHub then refuses — and its retry, whose
 * result is the cell's `write` (I9): nothing (the cell's write result from the first POST on); dave
 * stops the session and carol starts a newer one; carol starts alone (a re-issue of the running
 * session); a human push moves the PR head (its push handler runs). A cell with an event reads the
 * list caught up afterwards (later: row-appears). */
type Between = "nothing" | "stop+new-start" | "new-start-only" | "head-moved";
/** Where the event comes: between the write's attempts (its first POST refused), or before its
 * FIRST attempt — while the stuck step waits for a lagging history to show its review (the step's
 * read of the session is older than that wait); the write's result then applies from its first
 * POST. */
type BetweenAt = "retry" | "first";
/** How the step's reads of the PR head follow its own commit (I10): GitHub updates a pull's head
 * asynchronously after a ref update (the sync that later sends `synchronize`), so a read right
 * after the commit may still show its parent — the first read only, or every read of the call. */
type HeadRead = "synced" | "lags-one" | "lags-call";
/** Who else asks for the step's continuation while it is in flight (I11): nobody; or the push
 * handler for its head — the App's own `synchronize` for its commit (continue:applied), the human's
 * push for a step whose head moved (continue:superseded) — whose read knows its push (pushedAt; and
 * is never behind the head: GitHub sends the webhook after the sync). It reaches the gate while the
 * step's first attempt is being decided, and joins it. push+stale-clean: then a clean review of the
 * reviewed head lands — stale for a read that knows the push, the end of the session for the step's
 * own read, which does not: the step's emit ends superseded while the joiner's read owes the write. */
type Join = "none" | "push" | "push+stale-clean";
type Phase = "call" | "view" | "again" | "follow";
type Cell = {
  via: Via;
  write: Write;
  shape: Shape;
  stamp: Stamp;
  list: List;
  later: Later;
  anchor: Anchor;
  peer: Peer;
  prior: Prior;
  between: Between;
  betweenAt: BetweenAt;
  headRead: HeadRead;
  join: Join;
};
type Result = ControlResult | LoopStepResult;
/** posted / exists / unknown / rejected as the entry point reports it; `ran` a step that ran
 * (the self-heal); `resolved` a step result that needs nothing more (posted and exists collapse). */
type Cls = "posted" | "exists" | "unknown" | "rejected" | "unreadable" | "ran" | "resolved" | "superseded";

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
  "handoff:push-loop-error",
  "handoff:post-commit",
];
const WRITES: Write[] = ["success", "rejected", "unknown-landed", "unknown-lost"];
/** The answers of a POST whose write is `write` (the first is the plain one). */
const SHAPES: Record<Write, Shape[]> = {
  success: ["row"],
  rejected: ["none"],
  "unknown-landed": ["none", "row-without-id", "null", "primitive"],
  "unknown-lost": ["none"],
};
const STAMPS: Stamp[] = ["valid", "empty", "malformed"];
const LISTS: List[] = ["normal", "lagging", "failing"];
const LATERS: Later[] = ["redelivery", "newer-start", "newer-start-redelivery", "same-second-start", "25h", "row-appears", "row-relapses", "push", "moved", "stop-restart"];
const ANCHORS: Anchor[] = ["listed", "lagging", "lost"];
const PEERS: Peer[] = ["none", "before", "after"];
const PRIORS: Prior[] = ["none", "stale-resume"];
const BETWEENS: Between[] = ["nothing", "stop+new-start", "new-start-only", "head-moved"];
const HEAD_READS: HeadRead[] = ["synced", "lags-one", "lags-call"];
const JOINS: Join[] = ["none", "push", "push+stale-clean"];

const kindOf = (via: Via) => via.slice(0, via.indexOf(":")) as ControlKey["kind"];
/** A later event that means nothing for a path is not a cell: a newer start in the same second as
 * the POST matters only where the write is stamped at its attempt (a continuation or handoff); a
 * human push, or a step whose head moved, reads a session a handoff may have ended; a stop's
 * redelivery after a newer start tests the boundary only a stop draws. */
function applies(via: Via, later: Later): boolean {
  if (later === "same-second-start") return kindOf(via) === "continue" || kindOf(via) === "handoff";
  if (later === "newer-start-redelivery") return kindOf(via) === "stop";
  if (later === "push" || later === "moved") return kindOf(via) === "handoff";
  return true;
}
/** Only a continuation or handoff names its session (its anchor start). */
const sessionScoped = (via: Via) => kindOf(via) === "continue" || kindOf(via) === "handoff";
/** Every POST attempt of a write of this kind is decided by a fresh read of the session — for a
 * stop, which form its record takes (a start record is owed in every session: nothing to read). */
const decidedByRead = (via: Via) => sessionScoped(via) || kindOf(via) === "stop";
/** A refused continuation of a push or an applied round is followed by the loop-error handoff for
 * its head, decided by a fresh read of the session like every control POST: sent only when the
 * list is readable — a list failing through the call decides (so sends) neither. */
const refusalHandedOff = (c: Cell) => c.write === "rejected" && (c.via === "continue:push" || c.via === "continue:applied") && c.list !== "failing";
/** The events between the attempts of a write of this kind (I9). */
const betweens = (via: Via): readonly Between[] => (decidedByRead(via) ? BETWEENS : ["nothing"]);
/** Where an event can come for this path: before the first attempt only where the path waits before
 * it (the stuck step's history re-reads). */
const betweenAts = (via: Via, between: Between): readonly BetweenAt[] => (between !== "nothing" && via === "handoff:stuck" ? ["retry", "first"] : ["retry"]);
/** The paths whose step commits (an applied round): its continuation, or the loop-error handoff after
 * that continuation is refused. */
const commits = (via: Via) => via === "continue:applied" || via === "handoff:post-commit";
/** How the step's head reads follow its commit (I10), on the paths that commit — with the plain 2xx
 * answer: how GitHub's answer is decoded does not depend on what a head read shows. */
const headReads = (via: Via, write: Write, shape: Shape, stamp: Stamp): readonly HeadRead[] =>
  commits(via) && shape === SHAPES[write][0] && stamp === "valid" ? HEAD_READS : ["synced"];
/** Who joins the step's continuation (I11), on the paths whose step emits one, with the plain 2xx
 * answer. Not a refused continuation, nor a retry the failing list leaves undecided (so refused):
 * both callers then hand off, in the order the event loop picks — the handoff paths' own cells. The
 * stale clean review supersedes the step's first attempt, so it has no event between attempts. */
function joins(via: Via, write: Write, shape: Shape, stamp: Stamp, list: List, between: Between): readonly Join[] {
  const stepContinues = via === "continue:applied" || via === "continue:superseded";
  if (!stepContinues || write === "rejected" || shape !== SHAPES[write][0] || stamp !== "valid") return ["none"];
  if (between === "nothing") return JOINS;
  return list === "failing" ? ["none"] : ["none", "push"];
}

/** What the write's retry is, decided after the event between its attempts (I9): still owed (sent,
 * with the cell's write result), superseded (never sent again), or undecided (the session could not
 * be read: not sent). A continuation's moved head decides it with no session read. */
type Fate = "owed" | "superseded" | "undecided";
function fateAtRetry(c: Cell): Fate {
  if (c.between === "nothing") return "owed";
  if (c.between === "head-moved" && kindOf(c.via) === "continue") return "superseded";
  // the list outage starts at the write's first POST: a first attempt's read is not behind it
  if (decidedByRead(c.via) && c.list === "failing" && c.betweenAt === "retry") return "undecided";
  return c.between === "stop+new-start" && sessionScoped(c.via) ? "superseded" : "owed";
}
/** The call's reads are behind the session's start records (from the first one stored). */
const callBehindStarts = (c: Cell) => c.anchor === "lagging";

/** The head a continuation under test is for. */
const CONTINUE_HEAD: Partial<Record<Via, string>> = {
  "continue:push": PUSHED,
  "continue:applied": NEW_SHA,
  "continue:superseded": LIVE,
  "continue:moved-mid-round": MOVED,
};
/** The head a handoff under test is for: the reviewed head, or — the loop-error handoff after a
 * refused continuation — the pushed head (push handler) or the round's commit (post-commit). */
const HANDOFF_HEAD: Partial<Record<Via, string>> = {
  "handoff:stuck": HEAD,
  "handoff:terminal": HEAD,
  "handoff:push-loop-error": PUSHED,
  "handoff:post-commit": NEW_SHA,
};
/** The continuation GitHub always refuses in a path whose write under test is the handoff after it. */
const REFUSED_CONTINUATION: Partial<Record<Via, string>> = {
  "handoff:push-loop-error": PUSHED,
  "handoff:post-commit": NEW_SHA,
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
  /** The body of every POST of the write under test (in the order of underTest). */
  readonly underTestBodies: string[] = [];
  /** Whether carol's newer session had started at each POST of the write under test. */
  readonly underTestNewer: boolean[] = [];
  rowsForWrite = 0;
  carolAt?: string;
  /** The PR's head after a human push (later: push / moved). */
  pushedHead?: string;
  /** When the write under test first left (its attempt instant). */
  firstAttemptMs?: number;
  /** The first comment id at or after the write under test's first POST. */
  private writeFrom?: number;
  committed = false;
  /** The session the write under test is emitted in, as the call reads it. */
  callSession?: SessionRef;
  private nextId = 1;
  private lagFrom = Infinity;
  /** The list is behind the session's start records (from the first one stored). */
  private startsHidden = false;
  private firstStartId?: number;
  private failing = false;
  /** The step's review is not in the history yet (a lagging list): before the first attempt. */
  private reviewLags = false;
  /** The step's reads of the PR head since its commit (I10). */
  private headReadsAfterCommit = 0;
  /** Another caller's event runs (a stop, a start, a human push): its reads are not the step's. */
  private inEvent = false;
  /** The POSTs of a continuation GitHub always refuses (REFUSED_CONTINUATION). */
  refusedContinuations = 0;
  /** Every read so far, by the caller's token ("t" the step and the other events, "p" the joiner). */
  private readonly readsBy = new Map<string, number>();
  /** The push handler that joined the step's continuation (I11), and its push's time. */
  joined?: Promise<ControlResult>;
  pushedAt?: string;
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
    if (this.sameSecond()) this.clock = T0 + 250; // a sub-second clock: attempts are not on a second boundary
    if (kindOf(via) !== "start" && cell.anchor === "listed") this.store(BOT, startComment({ mode: this.mode(), by: "alice", at: ALICE_AT }), ALICE_AT);
    const rounds = via === "handoff:stuck" ? [5, 4, 3, 2, 2, 2] : [3];
    rounds.forEach((total, i) => this.reviews.push({ head: i === rounds.length - 1 ? HEAD : String(i).repeat(40), total, at: reviewDay(i) }));
    if (cell.prior === "stale-resume") {
      this.reviews.push({ head: STALE, total: 0, at: reviewDay(rounds.length) });
      this.store(BOT, continueComment({ mode: this.mode(), round: 2, pr, head: HEAD }), iso(T0 + 30_000));
      this.clock = T0 + 60_000; // bob's stop (at T0) is handled after the continuation landed
    }
    const read = (token: string) => {
      this.readsBy.set(token, (this.readsBy.get(token) ?? 0) + 1);
      if (this.failing) throw new Error("list 502");
    };
    const gh: LoopRuntimeDeps["gh"] = {
      listIssueComments: async (t) => (read(t), this.issues.filter((r) => r.id < this.visibleBefore()).map((r) => ({ ...r }))),
      listPullReviews: async (t) => (read(t), this.history().map((r) => ({ userLogin: BOT, body: `<!-- ashlar-findings total=${r.total} -->`, commitId: r.head, submittedAt: r.at }))),
      listReviewComments: async (t) => (read(t), this.history().map((r) => ({ userLogin: BOT, path: "src/a.ts", commitId: r.head, createdAt: r.at, body: "finding" }))),
      createIssueComment: async (_t, o) => this.create(o.body),
      fetchPullHeadRef: async (token) => {
        this.readsBy.set(token, (this.readsBy.get(token) ?? 0) + 1);
        const sha = this.headRead(token);
        if (this.joinsNow(token)) await this.joinPush(); // the step's first attempt is being decided
        return { ref: "feature", sha, fork: false, sameRepo: true };
      },
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

  /** The reviews a read lists: all of them, or — lagging — not yet the step's own. */
  private history() {
    return this.reviewLags ? this.reviews.slice(0, -1) : this.reviews;
  }

  /** Before the first attempt (I9): the history lags behind the step's review, so the step waits and
   * re-reads it; the event comes during that wait, and the review shows up with it. */
  armFirstAttempt(): void {
    if (this.cell.between === "nothing" || this.cell.betweenAt !== "first") return;
    this.reviewLags = true;
    this.hook = async () => {
      this.reviewLags = false;
      await this.betweenAttempts();
    };
  }

  /** The first row id a read does not list (the list is prefix-consistent). */
  private visibleBefore(): number {
    return Math.min(this.lagFrom, this.startsHidden ? (this.firstStartId ?? Infinity) : Infinity);
  }

  /** The session's anchor start (alice's) as the cell has it, and bob's peer start before the call. */
  async setup(): Promise<void> {
    if (!sessionScoped(this.cell.via)) return;
    this.startsHidden = callBehindStarts(this.cell);
    if (this.cell.anchor !== "listed") await startLoop("t", { ...this.ref, actor: "alice", mode: this.mode(), at: ALICE_AT }, settings(this.mode()), this.deps, ENV);
    if (this.cell.peer === "before") await this.startPeer();
  }

  /** After the call: the list lists the session's start records; bob's peer start after the write
   * (recorded whatever the list does meanwhile). */
  async afterCall(): Promise<void> {
    this.startsHidden = false;
    if (this.cell.peer !== "after") return;
    const failing = this.failing;
    this.failing = false;
    await this.startPeer();
    this.failing = failing;
  }

  private async startPeer(): Promise<void> {
    const r = await startLoop("t", { ...this.ref, actor: "bob", mode: this.mode(), at: ALICE_AT }, settings(this.mode()), this.deps, ENV);
    assert.equal(r.posted, true, `bob's start: ${JSON.stringify(r)}`);
  }

  /** GitHub stamps a row in the second its request left (not a second later), and carol's newer
   * start is in that same second: only GitHub's 1 s resolution orders the two. */
  sameSecond(): boolean {
    return this.cell.later === "same-second-start";
  }

  mode(): "suggest" | "apply" {
    return this.cell.via === "continue:applied" || this.cell.via === "handoff:post-commit" ? "apply" : "suggest";
  }

  live(): string {
    if (this.pushedHead) return this.pushedHead;
    switch (this.cell.via) {
      case "continue:push":
      case "handoff:push-loop-error":
        return PUSHED;
      case "continue:superseded":
        return LIVE;
      case "continue:applied":
      case "handoff:post-commit":
        return this.committed ? NEW_SHA : HEAD;
      case "continue:moved-mid-round":
        return this.prompts.length > 0 ? MOVED : HEAD;
      default:
        return HEAD;
    }
  }

  /** The PR head a read shows: the live one — except that the step's reads in the call (token "t",
   * not another caller's event) may still show its commit's parent (I10). */
  private headRead(token: string): string {
    const live = this.live();
    if (token !== "t" || this.inEvent || this.phase !== "call" || !this.committed || live !== NEW_SHA) return live;
    switch (this.cell.headRead) {
      case "synced":
        return live;
      case "lags-one":
        return this.headReadsAfterCommit++ === 0 ? HEAD : live;
      case "lags-call":
        return HEAD;
    }
  }

  /** Is this head read the step's, deciding its continuation's first attempt, with the joiner still
   * to come (I11)? The step's emit is in flight and has sent nothing (its entry is an intent). */
  private joinsNow(token: string): boolean {
    if (this.cell.join === "none" || this.joined || token !== "t" || this.inEvent || this.phase !== "call") return false;
    return ownWrites(this.deps.gh).state(this.key()) === "intent";
  }

  /** The push handler for the continuation's head runs up to the gate and joins the step's emit
   * (its reads resolve at once; then it waits on the gate). push+stale-clean: then the clean
   * review of the reviewed head lands. */
  private async joinPush(): Promise<void> {
    const headSha = CONTINUE_HEAD[this.cell.via]!;
    const actor = this.cell.via === "continue:applied" ? BOT : "alice"; // the App's own push, or the human's
    const pushedAt = second(this.clock);
    this.pushedAt = pushedAt;
    this.joined = continueLoopOnPush("p", { ...this.ref, headSha, actor, pushedAt }, settings(this.mode()), this.deps, ENV);
    let seen = -1;
    for (let quiet = 0, i = 0; quiet < 3 && i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      const n = this.readsBy.get("p") ?? 0;
      quiet = n === seen ? quiet + 1 : 0;
      seen = n;
    }
    if (this.cell.join !== "push+stale-clean") return;
    this.clock += 1_000;
    this.reviews.push({ head: HEAD, total: 0, at: iso(this.clock) });
  }

  /** The joiner's push, as its own read folds it. */
  pushEvent(): LoopEvent {
    return { at: this.pushedAt ?? "", kind: "push", head: CONTINUE_HEAD[this.cell.via] };
  }

  /** The journal key of the write under test (in the session its call read). */
  key(): string {
    const ref = this.ref;
    const session = this.callSession;
    switch (kindOf(this.cell.via)) {
      case "start":
        return controlKey({ kind: "start", ref, by: "alice", at: ALICE_AT, mode: "suggest" });
      case "stop":
        return controlKey({ kind: "stop", ref, by: "bob", at: iso(T0) });
      case "continue":
        return controlKey({ kind: "continue", ref, head: CONTINUE_HEAD[this.cell.via]!, session });
      case "handoff":
        return controlKey({ kind: "handoff", ref, head: HANDOFF_HEAD[this.cell.via]!, session });
    }
  }

  /** Is this POST the write under test? (Never in the follow phase: that is a new session's work.) */
  private underTestPost(body: string): boolean {
    if (this.phase === "follow") return false;
    const bot = { authoredByBot: true };
    switch (kindOf(this.cell.via)) {
      case "start":
        return parseStartMarker(body, bot)?.by === "alice";
      case "stop": // by its text, not by the parser under test (assertStopRecordForms parses it)
        return body.includes(`<!-- ashlar-loop-stop at=${iso(T0)} by=bob -->`);
      case "continue":
        return canonicalContinuation(body, bot)?.head === CONTINUE_HEAD[this.cell.via];
      case "handoff":
        return parseEscalateMarker(body, bot)?.head === HANDOFF_HEAD[this.cell.via];
    }
  }

  private store(userLogin: string, body: string, createdAt: string): IssueRow {
    const row = { id: this.nextId++, userLogin, body, createdAt };
    this.issues.push(row);
    if (userLogin === BOT) this.posted.push(body);
    return row;
  }

  /** GitHub's 2xx answer to the POST that created `row` — the row, or the cell's shape for the
   * write under test, with its stamp — decoded as production decodes it (a shape with no usable
   * row throws). */
  private answer(row: IssueRow, shape: Shape = "row", stamp: Stamp = "valid") {
    const createdAt = stamp === "valid" ? row.createdAt : stamp === "empty" ? "" : "yesterday";
    const created = { id: row.id, user: { login: row.userLogin }, created_at: createdAt, body: row.body };
    const { id: _id, ...withoutId } = created;
    const json = shape === "row-without-id" ? withoutId : shape === "null" ? null : shape === "primitive" ? "created" : created;
    return postedIssueComment(201, JSON.stringify(json));
  }

  private async create(body: string) {
    const sentAt = this.clock;
    this.clock += 1_000; // GitHub stamps the row after the request left
    const at = this.sameSecond() ? second(sentAt) : iso(this.clock);
    const refused = REFUSED_CONTINUATION[this.cell.via];
    if (refused && canonicalContinuation(body, { authoredByBot: true })?.head === refused) {
      this.refusedContinuations += 1;
      throw writeError("rejected", 422);
    }
    const start = parseStartMarker(body, { authoredByBot: true });
    if (start && sessionScoped(this.cell.via) && isoMs(start.at) === isoMs(ALICE_AT)) {
      // the session's start records: alice's follows the cell's anchor, bob's lands
      if (start.by === "alice" && this.cell.anchor === "lost") throw writeError("unknown", 502);
      const row = this.store(BOT, body, at);
      this.firstStartId ??= row.id;
      if (start.by === "alice" && this.cell.anchor === "lagging") throw writeError("unknown", 502);
      return this.answer(row);
    }
    if (!this.underTestPost(body)) return this.answer(this.store(BOT, body, at));
    if (this.underTest.length === 0) {
      this.firstAttemptMs = sentAt;
      this.writeFrom = this.nextId;
      this.outage();
    }
    this.underTest.push(this.phase);
    this.underTestBodies.push(body);
    this.underTestNewer.push(this.carolAt !== undefined);
    if (this.cell.between !== "nothing" && this.cell.betweenAt === "retry" && this.underTest.length === 1) {
      this.hook = () => this.betweenAttempts(); // during the backoff before the retry
      throw writeError("rejected", 422);
    }
    const { write, shape, stamp } = this.cell;
    if (write === "rejected" && !this.refusalPassed()) throw writeError("rejected", 422);
    if (write === "unknown-lost") throw writeError("unknown", 502);
    const row = this.store(BOT, body, at);
    this.rowsForWrite += 1;
    if (write === "unknown-landed" && shape === "none") throw writeError("unknown", 502);
    return this.answer(row, shape, stamp); // a shape with no usable row: unknown-landed too
  }

  /** A refused write is refused for good — except a stop redelivered after a newer start. */
  private refusalPassed(): boolean {
    return this.cell.later === "newer-start-redelivery" && this.phase === "again";
  }

  /** The list outage starts at the write's first POST; carol's newer start waits for its backoff. */
  private outage(): void {
    if (this.cell.list === "lagging") this.lagFrom = this.nextId;
    if (this.cell.list === "failing") this.failing = true;
    if (this.newerStart() && this.cell.write !== "success") this.hook = () => this.injectCarol();
  }

  newerStart(): boolean {
    return this.cell.later === "newer-start" || this.sameSecond();
  }

  disarm(): void {
    this.hook = undefined;
  }

  catchUp(): void {
    this.lagFrom = Infinity;
    this.failing = false;
    this.startsHidden = false;
  }

  /** A read served by a replica behind the write under test again, after one listed its row —
   * and, where the session's start records were not always listed, behind those too. */
  relapse(): void {
    this.failing = false;
    this.lagFrom = this.writeFrom ?? this.nextId;
    this.startsHidden = this.cell.anchor !== "listed";
  }

  /** Another caller's event (its reads are its own, never the step's). */
  private async event(run: () => Promise<void>): Promise<void> {
    const outer = this.inEvent;
    this.inEvent = true;
    try {
      await run();
    } finally {
      this.inEvent = outer;
    }
  }

  /** The cell's event between the write's refused first POST and its retry (I9). */
  private betweenAttempts(): Promise<void> {
    return this.event(() => this.between());
  }

  private async between(): Promise<void> {
    switch (this.cell.between) {
      case "nothing":
        return;
      case "stop+new-start": // dave's stop ends the session; carol's start, a second later, opens a newer one
        this.clock += 1_000;
        await stopLoop("t", { ...this.ref, actor: "dave", stopAt: iso(this.clock) }, settings(this.mode()), this.deps, ENV);
        this.clock += 1_000;
        this.carolAt = iso(this.clock);
        await startLoop("t", { ...this.ref, actor: "carol", mode: "suggest", at: this.carolAt }, settings("suggest"), this.deps, ENV);
        return;
      case "new-start-only": // carol's start re-issues the running session
        this.clock += 1_000;
        this.carolAt = iso(this.clock);
        await startLoop("t", { ...this.ref, actor: "carol", mode: "suggest", at: this.carolAt }, settings("suggest"), this.deps, ENV);
        return;
      case "head-moved": // a human push; its handler asks for the pushed head's review
        this.pushedHead = FRESH;
        await continueLoopOnPush("t", { ...this.ref, headSha: FRESH, actor: "alice" }, settings(this.mode()), this.deps, ENV);
        return;
    }
  }

  async injectCarol(): Promise<void> {
    if (this.carolAt) return;
    // carol's directive time: now, or — same-second — the second the write under test left in
    // (her webhook is handled later, during the write's backoff or after the call)
    const at = this.sameSecond() && this.firstAttemptMs !== undefined ? second(this.firstAttemptMs) : iso(this.clock);
    this.carolAt = at;
    await this.event(async () => void (await startLoop("t", { ...this.ref, actor: "carol", mode: "suggest", at }, settings("suggest"), this.deps, ENV)));
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
      case "handoff:push-loop-error":
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

  /** The events that stand for the write under test — only those the fold can place (it drops an
   * event whose time is no real instant). */
  async eventsOfWrite(gh: LoopRuntimeDeps["gh"] = this.deps.gh): Promise<LoopEvent[]> {
    const events = await readLoopEvents(gh, "t", "o", "r", this.pr, { botLogin: BOT, pr: { sha: this.live() } });
    return events.filter((e) => {
      if (Number.isNaN(isoMs(e.at))) return false;
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

/** What a human push (continueLoopOnPush) or a step whose head moved (a superseded step asks for
 * the live head's review) reports after the write: nothing to continue once a handoff is durable,
 * a request for the new head while the session is active — and, while the handoff that ended the
 * session exists only in this process (its outcome unknown), a logged "unknown", never a quiet exit. */
function expectNextHead(c: Cell): Cls {
  if (c.list === "failing") return "unreadable";
  if (c.write === "rejected") return c.later === "push" ? "posted" : "resolved";
  return c.write === "success" || (c.write === "unknown-landed" && c.list === "normal") ? "resolved" : "unknown";
}

// ── classification ──────────────────────────────────────────────────────────────

function controlClass(w: World, r: ControlResult): string {
  const why = r.reason;
  if (/list 502/.test(why)) return "unreadable";
  // the push handler's refused continuation: its result's tail is the loop-error handoff under test
  const tail = /^continue on push failed: .*; handoff (posted|failed|superseded|outcome unknown)/.exec(why)?.[1];
  if (w.cell.via === "handoff:push-loop-error" && tail) return ({ posted: "posted", failed: "rejected", superseded: "superseded" } as Record<string, string>)[tail] ?? "unknown";
  if (why === "started" || why === "stopped" || why === "continued") return r.posted ? "posted" : `other: ${why}`;
  if (/already (recorded|continued)$/.test(why)) return "exists";
  if (why.startsWith(START_UNRESOLVED) || /outcome unknown/.test(why)) return "unknown";
  if (/^(start failed|stop failed|continue on push failed)/.test(why)) return "rejected";
  if (why === NO_SESSION || why === SUPERSEDED || why === NEWER) return "resolved";
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
    if (/The loop ended meanwhile|The PR head moved meanwhile/.test(report) && handoffs === 0) return "superseded";
    return /Continuation outcome unknown/.test(report) && handoffs === 0 ? "unknown" : `other: ${JSON.stringify(r)}`;
  }
  if (r.ran) return `other: ${JSON.stringify(r)}`;
  const why = r.reason;
  if (/^loop step failed|could not be read/.test(why)) return "unreadable";
  // before "rejected": a post-commit handoff's detail quotes the refused continuation
  if (why.startsWith(START_UNRESOLVED) || /outcome is unknown|handed off \(outcome unknown\)/.test(why)) return "unknown";
  if (/^start failed|could not be requested|failed to post/.test(why)) return "rejected";
  if (why === SUPERSEDED || why === ALREADY_ESCALATED || why === NO_SESSION || why === NEWER) return "resolved";
  return `other: ${why}`;
}

const isControl = (r: Result): r is ControlResult => "posted" in r;
const classify = (w: World, r: Result): string => (isControl(r) ? controlClass(w, r) : stepClass(w, r));

/** A step path's result collapses outcomes the cell distinguishes. */
function norm(via: Via, e: Cls, when: "first" | "again"): Cls {
  if (via === "start:self-heal") return e === "posted" || e === "exists" || e === "unknown" ? "ran" : e;
  if (via.startsWith("continue:") && via !== "continue:push") return e === "posted" || e === "exists" ? "resolved" : e;
  if (via.startsWith("handoff:")) return e === "exists" || (when === "again" && e === "posted") ? "resolved" : e;
  return e;
}

function expectFirst(c: Cell): Cls {
  if (c.via === "start:self-heal" && c.list === "failing" && c.write !== "rejected") return "unreadable"; // re-reads after the emit
  // a control entry point whose refused write cannot be decided again (nor its loop-error handoff)
  // reports the unreadable list; a step reports the handoff that failed to post
  const entry = c.via === "continue:push" || c.via === "handoff:push-loop-error" || c.via === "stop:webhook";
  if (entry && decidedByRead(c.via) && c.write === "rejected" && c.list === "failing") return "unreadable";
  // a POST that answered "unknown" and whose row the re-check lists was posted by this call (a
  // list behind the session's start records is behind the write's row too)
  const listed = c.list === "normal" && !callBehindStarts(c);
  const e: Cls = c.write === "success" || (c.write === "unknown-landed" && listed) ? "posted" : c.write === "rejected" ? "rejected" : "unknown";
  return norm(c.via, e, "first");
}

/** The first call of a cell with an event between its write's attempts (I9): a retry still owed
 * reports its write result; one not sent (undecided) reports the refusal; a superseded write reports
 * the quiet exit its path takes — or, where the path owed more (the push handler's loop-error
 * handoff, an applied round's report), that it was superseded. */
function expectFirstBetween(c: Cell): Cls {
  switch (fateAtRetry(c)) {
    case "owed":
      return expectFirst(c);
    case "undecided":
      return expectFirst({ ...c, write: "rejected" });
    case "superseded":
      return c.via === "handoff:push-loop-error" || c.via === "continue:applied" ? "superseded" : "resolved";
  }
}

/** The step's first call where the push handler joined its continuation (I11): the stale clean
 * review supersedes the step's own first attempt (its read ends the session converged) — an applied
 * round's report says so, a superseded step exits quietly; otherwise the joiner changes nothing for
 * the step. */
function expectFirstJoined(c: Cell): Cls {
  if (c.join === "push+stale-clean") return c.via === "continue:applied" ? "superseded" : "resolved";
  return c.between === "nothing" ? expectFirst(c) : expectFirstBetween(c);
}

/** What the joiner reports (I11): where its own read supersedes the write too (a stop and a newer
 * start, a moved head), that; otherwise the continuation is owed and it reports what was sent — the
 * step's POST it shared, or (stale-clean: only the step's read superseded it) its own, with the
 * cell's write result — as a push handler does. */
function expectJoiner(c: Cell): Cls {
  if (c.join === "push" && fateAtRetry(c) === "superseded") return "resolved";
  return expectFirst({ ...c, via: "continue:push" });
}

function expectAgain(c: Cell, caughtUp: boolean): Cls {
  const list = caughtUp ? "normal" : c.list;
  if (list === "failing" && c.via !== "start:admission") return "unreadable"; // it reads the session before emitting
  let e: Cls = c.write === "success" ? "exists" : c.write === "rejected" ? "rejected" : c.write === "unknown-landed" && list === "normal" ? "exists" : "unknown";
  // A refused continuation of a push or an applied round ended the session with a loop-error
  // handoff for that head: the redelivery has nothing left to do — unless the list failed through
  // the call, which decided no handoff: then the redelivery asks again, and is refused again (the
  // push handler hands off now; the step's continuation for the moved head only reports it).
  if (c.write === "rejected" && (c.via === "continue:push" || c.via === "continue:applied")) e = refusalHandedOff(c) ? "resolved" : "rejected";
  return norm(c.via, e, "again");
}

// ── invariants ──────────────────────────────────────────────────────────────────

/** I2: an unresolved outcome — or any result while the write's outcome is still unknown — is logged.
 * `sender`: false for a caller that sent no attempt of the write: its own read superseded it before
 * any (push+stale-clean: the step), and the joiner that sent it reports that write's outcome. */
function assertLogged(w: World, r: Result, cls: string, label: string, sender = true): void {
  const unresolved = cls === "unknown" || cls === "rejected" || cls === "unreadable" || (sender && ownWrites(w.deps.gh).state(w.key()) === "unknown");
  if (!unresolved) return;
  // a control result that posted its record acted on the PR: that is not a silent exit
  const logged = isControl(r) ? r.posted || controlResultLogged(r) : !(r.ran === false && SILENT_REASONS.includes(r.reason));
  assert.ok(logged, `I2 ${label}: an unresolved result is silent: ${JSON.stringify(r)}`);
}

/** I1: no POST of the write after one that may have landed; at most one row. (A cell with an
 * event between the attempts has its first POST refused: at most one more.) */
function assertExactlyOnce(w: World): void {
  const refused = w.cell.between !== "nothing" && w.cell.betweenAt === "retry" ? 1 : 0;
  if (w.cell.write !== "rejected") assert.ok(w.underTest.length <= 1 + refused, `I1: ${w.underTest.length} POSTs (${w.underTest.join(", ")})`);
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
    await w.enter(); // the same review (or push) again
    if (write !== "rejected") assert.equal(w.prompts.length, before, "I5: a fix ran past the handoff");
    const s = await w.session();
    assert.equal(s.active, write === "rejected", `I5: the session read does not show this process's own handoff: ${JSON.stringify(s)}`);
  } else if (via.startsWith("continue:")) {
    const n = (await w.eventsOfWrite()).length;
    assert.equal(n, write === "rejected" ? 0 : 1, `I5: ${n} continue events for the head`);
  }
}

/** I4: once the row is listed, one session read confirms the entry and no stand-in is left; the
 * entry is kept, so a later read that lags behind the row again (`relapse`) still shows the write
 * once, and the same session. */
async function assertReconciled(w: World, relapse: boolean): Promise<void> {
  const { write } = w.cell;
  w.catchUp();
  const listed = await w.session();
  if (write === "success" || write === "unknown-landed") assert.equal(ownWrites(w.deps.gh).state(w.key()), "posted", "I4: the listed row confirms the journal entry");
  const n = (await w.eventsOfWrite()).length;
  const expected = write !== "rejected" || kindOf(w.cell.via) === "stop" ? 1 : 0; // a refused stop still stands (write-ahead)
  assert.equal(n, expected, `I4: ${n} events for the write`);
  if (!relapse) return;
  w.relapse();
  const behind = (await w.eventsOfWrite()).length;
  assert.equal(behind, expected, `I4: ${behind} events for the write in a read behind its listed row`);
  // the same session — whichever start of its second the read anchors at
  const identity = (s: LoopSession) => [s.active, isoMs(s.startIso), s.mode, s.endedBy, isoMs(s.endedAt)];
  const relapsed = await w.session();
  assert.deepEqual(identity(relapsed), identity(listed), `I4: a read behind the listed row changed the session: ${JSON.stringify([listed, relapsed])}`);
  if (w.cell.anchor === "listed" && w.cell.peer === "none") assert.deepEqual(relapsed, listed, "I4: a read behind the listed row changed the session");
}

/** I2 across kinds: the session a handoff ended is read by the next head's handlers too. */
async function assertNextHeadHeard(w: World): Promise<void> {
  const { later } = w.cell;
  w.phase = "view";
  w.pushedHead = FRESH;
  const r =
    later === "push"
      ? await continueLoopOnPush("t", { ...w.ref, headSha: FRESH, actor: "alice" }, settings(w.mode()), w.deps, ENV)
      : await w.plainStep(HEAD, "moved"); // the review of the old head: superseded by FRESH
  const cls = classify(w, r);
  assert.equal(cls, expectNextHead(w.cell), `I3 ${later}: ${JSON.stringify(r)}`);
  assertLogged(w, r, cls, later);
}

/** I7: dave stops the loop after the write — by an edited comment or the PR body, which only the
 * App's record keeps. After a restart (a fresh journal: durable history only, the list caught up)
 * the session is over, whatever the write did. */
async function assertStopSurvivesRestart(w: World): Promise<void> {
  if (w.cell.list === "failing") w.catchUp(); // an unreadable session fails the stop: harbor redelivers it
  w.phase = "view";
  w.clock += 60_000;
  const r = await stopLoop("t", { ...w.ref, actor: "dave", stopAt: iso(w.clock) }, settings(w.mode()), w.deps, ENV);
  assertLogged(w, r, classify(w, r), "stop");
  w.catchUp();
  const restarted = { ...w.deps.gh }; // another client object: an empty journal
  const s = await readLoopSession(restarted, "t", "o", "r", w.pr, { botLogin: BOT, pr: { sha: w.live() } });
  assert.equal(s.active, false, `I7: the stop is lost after a restart: ${JSON.stringify(r)} → ${JSON.stringify(s)}`);
}

/** What bob's stop, redelivered after carol's newer start, reports: its refused record is sent
 * (GitHub accepts it now), a landed one is found, one whose outcome is unknown and that no read
 * lists stays unknown — never re-sent, never "no active loop session". */
function expectBoundary(c: Cell): Cls {
  if (c.write === "rejected") return "posted";
  return expectAgain(c, c.list === "failing");
}

/** I8: bob's stop ended alice's session and carol has started a newer one since. The stop's
 * redelivery owes its record; in this process carol's session is her own, and — once the record
 * landed — after a restart too (a fresh journal: durable history only), with no round from before
 * the stop. A record whose outcome is unknown and that never landed is not re-sent: only this
 * process keeps that boundary. */
async function assertStopBoundaryOwed(w: World): Promise<void> {
  await w.injectCarol();
  if (w.cell.list === "failing") w.catchUp(); // an unreadable session fails the stop: harbor redelivers it
  w.clock += 60_000;
  w.phase = "again";
  const r = await w.enter(); // bob's stop, redelivered
  const cls = classify(w, r);
  assert.equal(cls, expectBoundary(w.cell), `I3 boundary: ${JSON.stringify(r)}`);
  assertLogged(w, r, cls, "boundary");
  const own = (s: LoopSession) => s.active && isoMs(s.startIso) === isoMs(w.carolAt);
  const here = await w.session();
  assert.ok(own(here), `I8: carol's session is not her own in this process: ${JSON.stringify(here)}`);
  if (w.rowsForWrite === 0) return;
  w.catchUp();
  const restarted = { ...w.deps.gh }; // another client object: an empty journal
  const s = await readLoopSession(restarted, "t", "o", "r", w.pr, { botLogin: BOT, pr: { sha: w.live() } });
  assert.ok(own(s), `I8: after a restart carol's start re-issues the stopped session: ${JSON.stringify(s)}`);
  const rounds = await reconstructRounds(restarted, "t", "o", "r", w.pr, { botLogin: BOT, sinceIso: s.startIso });
  assert.equal(rounds.length, 0, "I8: a round from before the stop counts in carol's session");
}

/** I8 (the record's form): bob's record, whenever it is sent, records his stop; it is the STOPPED
 * acknowledgement — the terminal signal watchers detect by its marker — except when it is sent
 * while carol's newer session runs (the redelivery after her start, or a retry after she started
 * during its backoff): then it opens with the record line alone and says nothing a STOPPED
 * detector matches. Carol's session starts after bob's stop in every stop cell. */
function assertStopRecordForms(w: World): void {
  const bot = { authoredByBot: true };
  w.underTestBodies.forEach((body, i) => {
    const phase = w.underTest[i];
    assert.deepEqual(parseStopRecord(body, bot), { at: iso(T0), by: "bob" }, `I8: the ${phase} POST does not record bob's stop`);
    const newerRuns = w.underTestNewer[i];
    assert.equal(isStoppedComment(body, bot), !newerRuns, `I8: the ${phase} POST ${newerRuns ? "is a STOPPED signal while carol's session runs" : "is no STOPPED acknowledgement"}: ${body}`);
    if (newerRuns) assert.ok(!body.includes(REVIEW_LOOP_STOPPED_HUMAN) && !body.includes("ashlar-loop-stopped"), `I8: a STOPPED detector matches it: ${body}`);
  });
}

/** I6: carol's newer start is never ended by an older record; a step in her session runs. */
async function assertNewerSessionLives(w: World): Promise<void> {
  const { via, write } = w.cell;
  if (w.cell.list === "failing") w.catchUp();
  const s = await w.session();
  if (refusalHandedOff(w.cell)) {
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

/** I9: the write's retry was decided after the event between its attempts. A write superseded or
 * undecided there is never POSTed again and leaves nothing: no row, no event (an unknown retry's
 * stand-in neither), no journal entry — in this process and after a restart; one still owed stands
 * as its write result says. A stop is the exception it always was: its intent stands in until its
 * record lands (write-ahead). carol's newer session (after a stop) runs on, anchored at her start,
 * and a step in it runs. */
async function assertBetween(w: World): Promise<void> {
  const c = w.cell;
  const fate = fateAtRetry(c);
  const writeAhead = kindOf(c.via) === "stop";
  if (fate !== "owed") {
    const refused = c.betweenAt === "retry" ? 1 : 0; // only a refused first POST came before
    assert.equal(w.underTest.length, refused, `I9: a write ${fate} at its retry was POSTed (${w.underTest.join(", ")})`);
    if (!writeAhead) assert.equal(ownWrites(w.deps.gh).state(w.key()), undefined, `I9: a write ${fate} at its retry left a journal entry`);
  }
  w.catchUp();
  const here = (await w.eventsOfWrite()).length;
  assert.equal(here, writeAhead || (fate === "owed" && c.write !== "rejected") ? 1 : 0, `I9: ${here} events of the write in this process`);
  const restarted = { ...w.deps.gh }; // another client object: an empty journal
  const durable = (await w.eventsOfWrite(restarted)).length;
  assert.equal(durable, w.rowsForWrite, `I9: ${durable} events of the write after a restart`);
  // carol's start after a stop opens her own session (bob's stop, or dave's, is its boundary)
  if (c.between !== "stop+new-start" && !(writeAhead && c.between === "new-start-only")) return;
  const s = await w.session();
  assert.ok(s.active && isoMs(s.startIso) === isoMs(w.carolAt), `I9: carol's newer session does not run as her own: ${JSON.stringify(s)}`);
  w.clock += 1_000;
  w.reviews.push({ head: w.live(), total: 3, at: iso(w.clock) });
  w.phase = "follow";
  const r = await w.plainStep(w.live(), "follow");
  assert.equal(r.ran, true, `I9: a step in carol's newer session did not run: ${JSON.stringify(r)}`);
}

/** I10: the App's own commit is no moved head, whatever the step's reads of the PR head showed of it
 * (still its parent, once or through the call): the commit's continuation was decided owed and
 * POSTed in the call (the write under test, or the refused one before the handoff under test), and
 * the report never says the head moved — unless a human push moved it (between: head-moved). */
function assertOwnCommitNoMove(w: World): void {
  const { via, headRead, between } = w.cell;
  const posts = via === "continue:applied" ? w.underTest.filter((p) => p === "call").length : w.refusedContinuations;
  assert.ok(posts >= 1, `I10: the commit's continuation was not POSTed in the call (head read ${headRead})`);
  if (between === "head-moved") return;
  const report = w.posted.find((b) => b.startsWith("### Ashlar fix agent — applied")) ?? "";
  assert.ok(!/The PR head moved meanwhile/.test(report), `I10: the report says the head moved (head read ${headRead}): ${report}`);
}

/** I11: a joiner never inherits another caller's supersession. Whenever its own read owes the
 * continuation — its session runs (with its push folded) and the head is still the continuation's —
 * it reports what was sent, never a quiet superseded or no-session exit; and the continuation stands
 * once in this process, and as its rows after a restart. */
async function assertJoined(w: World, r: ControlResult): Promise<void> {
  const cls = controlClass(w, r);
  assert.equal(cls, expectJoiner(w.cell), `I3 joiner: ${JSON.stringify(r)}`);
  assertLogged(w, r, cls, "joiner");
  w.catchUp();
  const own = await readLoopSession(w.deps.gh, "p", "o", "r", w.pr, { botLogin: BOT, pr: { sha: w.live() }, extra: [w.pushEvent()] });
  const owes = w.live() === CONTINUE_HEAD[w.cell.via] && own.active && sameSession(sessionRef(own), w.callSession);
  if (owes) assert.notEqual(cls, "resolved", `I11: the joiner's own read owes the continuation, yet it reports ${JSON.stringify(r)}`);
  if (w.cell.between !== "nothing") return; // I9 checks the write (assertBetween)
  assert.equal((await w.eventsOfWrite()).length, 1, "I11: the continuation does not stand once in this process");
  const restarted = { ...w.deps.gh }; // another client object: an empty journal
  assert.equal((await w.eventsOfWrite(restarted)).length, w.rowsForWrite, "I11: the continuation after a restart is not its rows");
}

async function runCell(c: Cell, pr: number): Promise<void> {
  const w = new World(c, pr);
  const realNow = Date.now;
  const realInfo = console.info;
  Date.now = () => w.clock; // defeats any wall-clock TTL in the 25 h cells
  console.info = () => {}; // the step trace is noise here
  try {
    await w.setup();
    if (sessionScoped(c.via)) w.callSession = sessionRef(await w.session());
    w.armFirstAttempt();
    const first = await w.enter();
    const joiner = w.joined ? await w.joined : undefined; // the joiner's call ends with the step's
    const cls = classify(w, first);
    const expected = c.join !== "none" ? expectFirstJoined(c) : c.between === "nothing" ? expectFirst(c) : expectFirstBetween(c);
    assert.equal(cls, expected, `I3 first: ${JSON.stringify(first)}`);
    assertLogged(w, first, cls, "first", c.join !== "push+stale-clean");
    assert.equal(joiner !== undefined, c.join !== "none", "I11: the push handler ran while the step's continuation was being decided");
    w.disarm();
    await w.afterCall();
    if (joiner) await assertJoined(w, joiner);
    if (c.between !== "nothing") {
      await assertBetween(w);
    } else if (joiner) {
      // the joined continuation is checked (assertJoined)
    } else if (w.newerStart()) {
      await w.injectCarol(); // a success had no backoff to inject it in
      await assertNewerSessionLives(w);
    } else if (c.later === "push" || c.later === "moved") {
      await assertNextHeadHeard(w);
    } else if (c.later === "stop-restart") {
      await assertStopSurvivesRestart(w);
    } else if (c.later === "newer-start-redelivery") {
      await assertStopBoundaryOwed(w);
    } else {
      // I5 on a readable list (not beside carol's start, which would answer for the write)
      if (c.list !== "failing") {
        w.phase = "view";
        await assertReadsOwnWrite(w);
      }
      if (c.later === "25h") w.clock += 25 * 60 * 60_000;
      const listed = c.later === "row-appears" || c.later === "row-relapses";
      if (listed) await assertReconciled(w, c.later === "row-relapses");
      w.phase = "again";
      // after a relapse the list lags again, but the journal already holds what the listed row told it
      const again = await w.enter();
      const againCls = classify(w, again);
      assert.equal(againCls, expectAgain(c, listed), `I3 again: ${JSON.stringify(again)}`);
      assertLogged(w, again, againCls, "again");
    }
    assertExactlyOnce(w);
    if (kindOf(c.via) === "stop") assertStopRecordForms(w);
    if (commits(c.via)) assertOwnCommitNoMove(w);
  } finally {
    Date.now = realNow;
    console.info = realInfo;
  }
}

describe("control writes: kind (× a stop's prior session) × write result (× 2xx body × created_at) × list read × later event, or what happens between the write's attempts (× anchor start × peer start × how the step's head reads follow its commit × who joins the step's continuation) (#79 K1)", () => {
  let row = 0;
  for (const via of VIAS)
    for (const prior of kindOf(via) === "stop" ? PRIORS : (["none"] as const))
      for (const write of WRITES)
        for (const shape of SHAPES[write])
          for (const stamp of shape === "row" ? STAMPS : (["valid"] as const))
            for (const list of LISTS)
              for (const between of betweens(via))
                for (const betweenAt of betweenAts(via, between))
                  for (const join of joins(via, write, shape, stamp, list, between))
                    for (const later of between === "nothing" && join === "none" ? LATERS : (["row-appears"] as const))
                      for (const anchor of sessionScoped(via) ? ANCHORS : (["listed"] as const))
                        for (const peer of sessionScoped(via) ? PEERS : (["none"] as const))
                          for (const headRead of headReads(via, write, shape, stamp)) {
                            if (!applies(via, later)) continue;
                            const cell = { via, write, shape, stamp, list, later, anchor, peer, prior, between, betweenAt, headRead, join };
                            const pr = 1000 + row++;
                            const answer = shape === SHAPES[write][0] ? "" : ` (2xx ${shape})`;
                            const time = stamp === "valid" ? "" : ` (created_at ${stamp})`;
                            const where = betweenAt === "retry" ? "between attempts" : "before the first attempt";
                            const next = between === "nothing" ? (join === "none" ? later : "joined") : `${where}: ${between}`;
                            const session = anchor === "listed" && peer === "none" ? "" : ` | anchor ${anchor}, peer ${peer}`;
                            const before = prior === "none" ? "" : ` | prior ${prior}`;
                            const commit = headRead === "synced" ? "" : ` | head read ${headRead}`;
                            const joined = join === "none" ? "" : ` | joined by ${join}`;
                            it(`${via} | ${write}${answer}${time} | ${list} | ${next}${session}${before}${commit}${joined}`, () => runCell(cell, pr));
                          }
});
