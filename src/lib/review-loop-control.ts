/**
 * Review-loop CONTROL WRITES (#79 K1): the one gate through which the App's control comments —
 * start and stop records, continuations and handoffs — reach GitHub, and the journal of what this
 * process wrote.
 *
 * WHY: a control write has three outcomes, not two. A POST GitHub refused created nothing; a POST
 * that returned the row created it; a POST whose response was lost or that failed after creation
 * (outcome "unknown", see github-transport's GithubWriteError) may have landed. Handling that third
 * state at every call site separately left one gap per site: a write sent twice, an "ok" that was
 * not, a session that ended or stayed open on a guess. Here it is handled once:
 * - emitControl POSTs a write at most once while its outcome may have landed, joins concurrent
 *   emits of the same key, and returns a CLOSED outcome (posted | exists | unknown | rejected) that
 *   every caller handles in an exhaustive switch.
 * - OwnWrites journals every write. Every session read reconciles it against the listed history (a
 *   listed row the event collector reads confirms its entry) and folds the entries the list does
 *   not show as stand-in events: the loop reads its own writes — also when a later read lags behind
 *   a row an earlier one listed. Retention follows the state: an unresolved write (it may have
 *   landed and no list shows it, or a write-ahead stop not yet recorded) is kept for the life of
 *   the process, never by age or size; a landed one (its row created or listed) is kept until
 *   LANDED_KEPT later landings retire it; a refused or unsent one is dropped.
 *
 * DI-only (no transport import): it is reached only through the gated loop engine and runtime.
 * NON-GOALS: dedup across processes or restarts (the journal is in-process; single harbor instance).
 */
import {
  canonicalContinuation,
  isoMs,
  isSelfLogin,
  parseEscalateMarker,
  parseStartMarker,
  parseStopRecord,
  type ReviewLoopMode,
} from "./review-loop.ts";
import type { LoopEvent, LoopSession, SessionRef } from "./review-loop-session.ts";
import { retryWrite, writeOutcomeUnknown } from "./write-retry.ts";

export type ControlKind = "start" | "stop" | "continue" | "handoff";
export type PrRef = { owner: string; repo: string; pr: number };
export type ControlRow = { id?: number; userLogin: string; body: string; createdAt?: string; updatedAt?: string };
/** The created row as GitHub reported it (fakes may return only `id`; production reports a missing
 * created_at as ""). */
export type CreatedRow = { id?: number; userLogin?: string; createdAt?: string };

/** The GitHub calls a control write needs (structurally a subset of the engine's client). */
export interface ControlGithub {
  listIssueComments(token: string, owner: string, repo: string, pr: number): Promise<ControlRow[]>;
  createIssueComment(token: string, o: { owner: string; repo: string; pr: number; body: string }): Promise<CreatedRow>;
}

/** What a control write IS, independent of its text: the identity every dedup check keys on. A
 * continuation or handoff belongs to one session (its rows are matched only in it). */
export type ControlKey =
  | { kind: "start"; ref: PrRef; by: string; at: string; mode: ReviewLoopMode }
  | { kind: "stop"; ref: PrRef; by: string; at: string }
  | { kind: "continue"; ref: PrRef; head: string; session?: SessionRef }
  | { kind: "handoff"; ref: PrRef; head: string; session?: SessionRef };

export function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.pr}`.toLowerCase();
}

/**
 * The key string of a write. A continuation or handoff names its session by the anchor's INSTANT,
 * which is the whole of a session's identity: at one instant the fold (review-loop-session ORDER)
 * places the App's terminal records first, then every start, then human stops — so all starts in
 * one second are consecutive, the first opens the session (or re-issues an active one) and every
 * later one re-issues it. No two sessions are ever anchored in one second. Never by the anchor's
 * start RECORD (its comment id, or its marker): which of a second's starts anchors depends on what
 * a read lists (the first listed record, else the first stand-in), so that name changes with the
 * list mid-session — and a key that changed would POST the same continuation or handoff twice.
 * The record's id only scopes the write's rows (controlInSession, keepScope).
 */
export function controlKey(k: ControlKey): string {
  const pr = prKey(k.ref);
  switch (k.kind) {
    case "start":
      return `start:${pr}:${k.by.toLowerCase()}:${isoMs(k.at)}:${k.mode}`;
    case "stop":
      return `stop:${pr}:${k.by.toLowerCase()}:${isoMs(k.at)}`;
    case "continue":
    case "handoff":
      return `${k.kind}:${pr}@${k.head}#${datable(k.session?.at) ? isoMs(k.session?.at) : ""}`;
    default:
      return assertNever(k);
  }
}

export interface ControlWrite {
  key: ControlKey;
  /** Lazy so a continuation computes its round only when a POST is really sent — and so a caller
   * reaches emitControl with no await (the single-flight join point). */
  body: string | (() => Promise<string>);
}

/** In-session test for a REVIEW row (a round): strictly after the anchor, compared as instants.
 * The anchor is the start directive's time and a review it requested lands minutes later; a
 * review in the anchor's own second belongs to what came before. A row whose timestamp is missing
 * or unparseable cannot be proven in-session and is excluded. */
export function inSession(at: string | null | undefined, sinceMs: number): boolean {
  if (Number.isNaN(sinceMs)) return true; // no anchor: the whole history
  const t = isoMs(at);
  return !Number.isNaN(t) && t > sinceMs;
}

/** In-session test for one of the session's own CONTROL comments (handoff, continuation): posted
 * after the session's start record — by comment id when known (exact; timestamps tie within a
 * second, e.g. the last session's handoff and this session's start), else strictly by time. */
export function controlInSession(c: { id?: number; createdAt?: string }, since: { iso?: string; seq?: number }): boolean {
  if (since.seq !== undefined && c.id) return c.id > since.seq;
  return inSession(c.createdAt, isoMs(since.iso));
}

/** Same recorded start: requester, directive time (as an instant) and mode. */
export function sameStart(a: { mode: string; by: string; at: string } | null, b: { mode: string; by: string; at: string }): boolean {
  return !!a && a.mode === b.mode && a.by.toLowerCase() === b.by.toLowerCase() && isoMs(a.at) === isoMs(b.at);
}

/** The scope of a session's own control rows: after its start record (see controlInSession). */
function sessionScope(s: SessionRef | undefined): { iso?: string; seq?: number } {
  return { iso: s?.at, seq: s?.seq };
}

/** `w`, scoped no looser than `prior` (the same write, as its journal entry holds it): a read that
 * has no id for the session's start record — or an earlier one — never widens the rows that answer
 * for the write (the tightest known id wins); `w` brings its text. */
function keepScope(w: ControlWrite, prior: ControlWrite): ControlWrite {
  const k = w.key;
  const p = prior.key;
  if ((k.kind !== "continue" && k.kind !== "handoff") || p.kind !== k.kind) return w;
  const [a, b] = [k.session?.seq, p.session?.seq];
  const seq = a === undefined ? b : b === undefined ? a : Math.max(a, b);
  return seq === a ? w : { ...w, key: { ...k, session: { ...k.session, seq } } };
}

/** The ONE definition of "this listed row is that write" (the caller has proven the App wrote it). */
export function rowMatches(w: ControlWrite, row: ControlRow): boolean {
  const k = w.key;
  const bot = { authoredByBot: true };
  switch (k.kind) {
    case "start":
      return sameStart(parseStartMarker(row.body, bot), k);
    case "stop": {
      const rec = parseStopRecord(row.body, bot);
      return !!rec && rec.by.toLowerCase() === k.by.toLowerCase() && isoMs(rec.at) === isoMs(k.at);
    }
    case "continue": {
      const c = canonicalContinuation(row.body, bot);
      return !!c && c.pr === k.ref.pr && c.head === k.head && controlInSession(row, sessionScope(k.session));
    }
    case "handoff":
      return parseEscalateMarker(row.body, bot)?.head === k.head && controlInSession(row, sessionScope(k.session)); // full-SHA equality
    default:
      return assertNever(k);
  }
}

export function listedMatch(rows: readonly ControlRow[], w: ControlWrite, botLogin: string): ControlRow | undefined {
  return rows.find((r) => isSelfLogin(r.userLogin, botLogin) && rowMatches(w, r));
}

/** A real instant (GitHub reports a missing created_at as ""; a malformed one parses to NaN). */
export function datable(iso: string | null | undefined): boolean {
  return !Number.isNaN(isoMs(iso));
}

/**
 * Does the event collector (review-loop-engine readLoopEvents) turn this listed row of `w` into
 * `w`'s event? A start or stop RECORD carries its own time in its marker; a continuation or handoff
 * is placed at the row's createdAt, which must be a real instant. Only such a row retires the
 * write's stand-in: a row the collector skips would otherwise make the event vanish exactly when
 * the list catches up (it still proves the write exists — no second POST).
 */
export function collectable(w: ControlWrite, row: ControlRow): boolean {
  const k = w.key;
  switch (k.kind) {
    case "start":
    case "stop":
      return true;
    case "continue":
    case "handoff":
      return datable(row.createdAt);
    default:
      return assertNever(k);
  }
}

/**
 * posted   — THIS emit created the row: its POST returned it, or answered "unknown" and a re-check
 *            then listed it (the gate is exclusive per key, so that row is this emit's);
 * exists   — a matching row was listed before this emit sent anything, or an earlier emit wrote it;
 * unknown  — a POST may have landed and no list shows it: it is never sent again;
 * rejected — nothing was created (every attempt refused, or never sent).
 */
export type EmitOutcome =
  | { status: "posted" }
  | { status: "exists" }
  | { status: "unknown"; attemptAt: string; error: string }
  | { status: "rejected"; error: string };

type WriteState = "intent" | "sending" | "posted" | "unknown" | "rejected";

interface OwnWrite {
  /** Its journal key: controlKey of its write (never changes: see controlKey). */
  key: string;
  write: ControlWrite;
  /** Honored by the session fold before (and whatever) its POST: a stop from the first moment. */
  writeAhead: boolean;
  state: WriteState;
  /** Taken immediately BEFORE each POST (at GitHub's one-second resolution); frozen at the attempt
   * whose outcome is unknown. */
  attemptAt?: string;
  /** The server's row (posted) or the listed one (confirmed). */
  row?: CreatedRow;
  error?: string;
  inflight?: Promise<EmitOutcome>;
}

const message = (e: unknown): string => (e as Error)?.message ?? String(e);

/** Folded when a read does not list it: a write-ahead intent, a landed write (also one an earlier
 * read listed: a later read may come from a replica behind that one), or one that may have landed.
 * Not while its POST is in flight (no phantom), and not a refused write — a refused start stays
 * repairable by the loop step, a refused handoff leaves the session active. */
function folds(e: OwnWrite): boolean {
  return e.writeAhead || e.state === "posted" || e.state === "unknown";
}

/** Where a continuation or handoff stand-in is placed: at the server's time when it is a real
 * instant, else at its POST attempt — never at "now": a newer start between the two must not be
 * ended by an old session's handoff. The fold drops an undatable event, so a 2xx row whose
 * created_at is missing ("", github-transport's shape) or malformed is a missing time: it falls
 * back to the attempt (a non-empty malformed time is no time either). */
function standInAt(e: OwnWrite): string {
  const server = e.row?.createdAt;
  return server !== undefined && datable(server) ? server : (e.attemptAt ?? "");
}

/** The event an own write that a read does not list stands for (a continuation or handoff: at
 * standInAt). */
function standInEvent(e: OwnWrite): LoopEvent {
  const k = e.write.key;
  switch (k.kind) {
    case "start":
      return { at: k.at, kind: "start", mode: k.mode, actor: k.by, ...(e.row?.id ? { seq: e.row.id } : {}) };
    case "stop":
      return { at: k.at, kind: "stop", actor: k.by };
    case "continue":
      return { at: standInAt(e), kind: "continue", head: k.head };
    case "handoff":
      return { at: standInAt(e), kind: "escalate" };
    default:
      return assertNever(k);
  }
}

/**
 * How many LANDED writes (the row was created — a 2xx — or listed) the journal keeps, across all
 * PRs. A landed entry still answers a later emit of its key ("exists": no POST) and still stands in
 * for its row when a read omits it: a read served by a replica behind the one that listed the row,
 * or a failed idempotency read that does not suppress a handoff. Such lag lasts seconds, and GitHub
 * throttles the App's content creation (on the order of 80 comments a minute per token), so the
 * last 1,000 landings span far longer. The oldest landing is retired first, with no later read of
 * its PR needed (a terminal handoff or stop gets none). Unresolved entries are never counted here.
 */
export const LANDED_KEPT = 1_000;

/**
 * Done with, so dropped at once: a write that neither landed nor folds (refused or unsent, not
 * write-ahead). Never while an emit is in flight. A landed write is retired by landing order
 * (LANDED_KEPT); an unknown write, and a write-ahead one whose record is not posted, never are.
 */
function settled(e: OwnWrite): boolean {
  if (e.inflight) return false;
  return !e.writeAhead && (e.state === "rejected" || e.state === "intent");
}

/** The control writes one GitHub client made in this process, retained by STATE: an entry that may
 * have landed, or a write-ahead one whose record is not posted, keeps blocking a second POST and
 * folding for as long as the process lives (no TTL, no cap); a landed entry is kept until
 * LANDED_KEPT later landings retire it — not when a read first lists its row; a settled entry is
 * dropped, and so is a PR's map once it is empty. */
export class OwnWrites {
  private readonly byPr = new Map<string, Map<string, OwnWrite>>();
  /** The landed entries, oldest landing first (a Set keeps insertion order). */
  private readonly landed = new Set<OwnWrite>();

  private entries(ref: PrRef): Map<string, OwnWrite> {
    const pr = prKey(ref);
    const found = this.byPr.get(pr);
    if (found) return found;
    const fresh = new Map<string, OwnWrite>();
    this.byPr.set(pr, fresh);
    return fresh;
  }

  /** The entry of `w`, if journaled. */
  private find(w: ControlWrite): OwnWrite | undefined {
    return this.byPr.get(prKey(w.key.ref))?.get(controlKey(w.key));
  }

  /** The entry of `w` (created unsent), carrying the latest text of the write and never a looser
   * session scope (keepScope). */
  upsert(w: ControlWrite): OwnWrite {
    const e = this.find(w);
    if (!e) {
      const key = controlKey(w.key);
      const fresh: OwnWrite = { key, write: w, writeAhead: false, state: "intent" };
      this.entries(w.key.ref).set(key, fresh);
      return fresh;
    }
    if (!e.inflight) e.write = keepScope(w, e.write);
    return e;
  }

  /** undefined: never journaled, dropped, or retired. */
  state(key: string): WriteState | undefined {
    for (const all of this.byPr.values()) {
      const e = all.get(key);
      if (e) return e.state;
    }
    return undefined;
  }

  /** Write-ahead: the fold honors `w` from now on, whatever its POST does. Never downgrades. */
  intend(w: ControlWrite): void {
    this.upsert(w).writeAhead = true;
  }

  /** Forget an intent that was never sent (a stop that stopped nothing). */
  abandon(w: ControlWrite): void {
    const e = this.find(w);
    if (e?.state === "intent" && !e.inflight) this.byPr.get(prKey(w.key.ref))?.delete(e.key);
    this.prune(w.key.ref);
  }

  /** A listed row that is `w`: confirms the entry (it is no longer unknown). Matched in the
   * entry's scope too (keepScope): a read with no id for the session's start record never lets an
   * older session's row confirm it. */
  seen(w: ControlWrite, rows: readonly ControlRow[], botLogin: string): boolean {
    const e = this.find(w);
    const hit = listedMatch(rows, e ? keepScope(w, e.write) : w, botLogin);
    if (hit && e) confirm(e, hit);
    this.prune(w.key.ref);
    return !!hit;
  }

  /** RECONCILE, then FOLD: every entry of the PR that a collectable listed row matches is confirmed
   * (that row is its event in this read); every other entry that folds becomes a stand-in event —
   * a landed one too, when this read omits a row an earlier read listed. Called on every session
   * read. */
  standIns(ref: PrRef, listed: readonly ControlRow[], botLogin: string): LoopEvent[] {
    const out: LoopEvent[] = [];
    for (const e of this.byPr.get(prKey(ref))?.values() ?? []) {
      const hit = listedMatch(listed, e.write, botLogin);
      if (hit && collectable(e.write, hit)) confirm(e, hit);
      else if (folds(e)) out.push(standInEvent(e));
    }
    this.prune(ref);
    return out;
  }

  /** Drop the PR's settled entries (and its map once it is empty), record its new landings, and
   * retire the oldest landings past LANDED_KEPT. */
  prune(ref: PrRef): void {
    const pr = prKey(ref);
    const all = this.byPr.get(pr);
    if (all) {
      for (const [key, e] of all) {
        if (settled(e)) all.delete(key);
        else if (e.state === "posted") this.landed.add(e); // already there: keeps its first place
      }
      if (all.size === 0) this.byPr.delete(pr);
    }
    this.retire();
  }

  /** Retire the oldest landed entries past LANDED_KEPT (their rows exist; see LANDED_KEPT). */
  private retire(): void {
    for (const e of this.landed) {
      if (this.landed.size <= LANDED_KEPT) return;
      this.landed.delete(e);
      const pr = prKey(e.write.key.ref);
      const all = this.byPr.get(pr);
      if (all?.get(e.key) === e) all.delete(e.key);
      if (all?.size === 0) this.byPr.delete(pr);
    }
  }

  /** What the journal holds (retention is observable: tests pin what is kept and what is not). */
  stats(): { prs: number; entries: number } {
    let entries = 0;
    for (const all of this.byPr.values()) entries += all.size;
    return { prs: this.byPr.size, entries };
  }

  /**
   * The kind of THIS process's own write that ended session `s` when that write may not be
   * durable: a handoff whose outcome is unknown, or a stop whose record is not posted (unsent,
   * refused or unknown). Only this process sees that end — a restart forgets it and the durable
   * history may still show the session active — so a gate must never treat it as a settled end.
   * Call it with a session read that just reconciled the journal.
   */
  unconfirmedEnd(ref: PrRef, s: Pick<LoopSession, "active" | "endedBy" | "endedAt">): "handoff" | "stop" | undefined {
    if (s.active) return undefined;
    const at = isoMs(s.endedAt);
    for (const e of this.byPr.get(prKey(ref))?.values() ?? []) {
      const k = e.write.key;
      if (s.endedBy === "escalate" && k.kind === "handoff" && e.state === "unknown" && isoMs(e.attemptAt) === at) return "handoff";
      if (s.endedBy === "stop" && k.kind === "stop" && e.writeAhead && e.state !== "posted" && isoMs(k.at) === at) return "stop";
    }
    return undefined;
  }

  /** The writes of `kind` on this PR whose outcome is still unknown. */
  unresolved(ref: PrRef, kind: ControlKind): Array<{ key: string; attemptAt: string }> {
    const out: Array<{ key: string; attemptAt: string }> = [];
    for (const [key, e] of this.byPr.get(prKey(ref)) ?? []) {
      if (e.state === "unknown" && e.write.key.kind === kind) out.push({ key, attemptAt: e.attemptAt ?? "" });
    }
    return out;
  }
}

/** A listed row that is `e`'s write confirms it — only a row the collector turns into its event:
 * an uncollectable one leaves the entry (and its stand-in) as it was. */
function confirm(e: OwnWrite, row: ControlRow): void {
  if (e.state === "sending") return; // its POST answers for it
  if (!collectable(e.write, row)) return;
  e.state = "posted";
  e.row = { id: row.id, userLogin: row.userLogin, createdAt: row.createdAt };
}

const journals = new WeakMap<object, OwnWrites>();

/** The journal of one GitHub client: production memoizes one client; each test fake is its own. */
export function ownWrites(client: object): OwnWrites {
  const found = journals.get(client);
  if (found) return found;
  const fresh = new OwnWrites();
  journals.set(client, fresh);
  return fresh;
}

/** Delays before each attempt of a control POST: one transient refusal must not stall the loop. */
export const CONTROL_RETRY_DELAYS_MS: readonly number[] = [0, 2_000, 5_000];

export interface EmitContext {
  gh: ControlGithub;
  token: string;
  botLogin: string;
  sleep: (ms: number) => Promise<void>;
  /** The clock of attemptAt (tests inject it). */
  now: () => number;
  /** Scan before the first POST (false when the caller just scanned). */
  scanFirst?: boolean;
}

/**
 * Emit one control write: at most one POST that may have landed per key in this process. The
 * journal answers for a write whose outcome is unknown for the life of the process, and for a
 * landed one until LANDED_KEPT later landings retire it; after that its row answers the scan made
 * before a POST (by the emit, or by its caller) — only a scan that fails or lags that far behind
 * could let a second one through. Synchronous up to the join, so a concurrent emit of the same key
 * shares this one's outcome.
 */
export function emitControl(ctx: EmitContext, w: ControlWrite): Promise<EmitOutcome> {
  const journal = ownWrites(ctx.gh);
  const e = journal.upsert(w);
  if (e.inflight) return e.inflight;
  const run = emitOnce(ctx, e).finally(() => {
    e.inflight = undefined;
    journal.prune(w.key.ref); // a refused write is settled now; a landed one is recorded
  });
  e.inflight = run;
  return run;
}

async function emitOnce(ctx: EmitContext, e: OwnWrite): Promise<EmitOutcome> {
  switch (e.state) {
    case "posted":
      return { status: "exists" };
    case "unknown":
    case "sending": // unreachable (a POST in flight is joined above); never risk a second one
      return recheck(ctx, e);
    case "intent":
    case "rejected":
      return send(ctx, e);
    default:
      return assertNever(e.state);
  }
}

/** An attempt instant at GitHub's one-second resolution. GitHub stamps rows and webhook event times
 * in whole seconds, so a stand-in must tie with a same-second start exactly as its row would (the
 * fold's tie-break then opens the newer session); a millisecond stamp would order it AFTER that
 * start and end the newer session with an older session's handoff. */
function attemptSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

function unknownOutcome(e: OwnWrite): EmitOutcome {
  return { status: "unknown", attemptAt: e.attemptAt ?? "", error: e.error ?? "the write's outcome is unknown" };
}

/** A write that may have landed is only ever looked for again. A failed read finds nothing — so
 * does one whose answer is no list of rows (never a TypeError: the outcome stays closed). */
async function recheck(ctx: EmitContext, e: OwnWrite): Promise<EmitOutcome> {
  const { ref } = e.write.key;
  const hit = await ctx.gh
    .listIssueComments(ctx.token, ref.owner, ref.repo, ref.pr)
    .then((rows) => listedMatch(rows, e.write, ctx.botLogin))
    .catch(() => undefined);
  if (!hit) return unknownOutcome(e);
  confirm(e, hit);
  return { status: "exists" };
}

async function send(ctx: EmitContext, e: OwnWrite): Promise<EmitOutcome> {
  const { ref } = e.write.key;
  const where = { owner: ref.owner, repo: ref.repo, pr: ref.pr };
  let body: string | undefined;
  let mayHaveLanded = false; // one of THIS emit's POSTs answered "unknown"
  const r = await retryWrite({
    delays: CONTROL_RETRY_DELAYS_MS,
    sleep: ctx.sleep,
    scanFirst: ctx.scanFirst,
    seen: async () => {
      const rows = await ctx.gh.listIssueComments(ctx.token, ref.owner, ref.repo, ref.pr);
      const hit = listedMatch(rows, e.write, ctx.botLogin);
      if (hit) confirm(e, hit);
      return !!hit;
    },
    post: async () => {
      const w = e.write.body;
      body ??= typeof w === "string" ? w : await w();
      e.attemptAt = attemptSecond(ctx.now());
      e.state = "sending";
      try {
        e.row = await ctx.gh.createIssueComment(ctx.token, { ...where, body });
        e.state = "posted";
      } catch (err) {
        e.state = writeOutcomeUnknown(err) ? "unknown" : "rejected";
        mayHaveLanded ||= e.state === "unknown";
        e.error = message(err);
        throw err;
      }
    },
  });
  if ("posted" in r) return { status: "posted" };
  // Listed after this emit's own unknown POST: that row is the POST's. Callers read "exists" as
  // someone else's write (a handoff caller then skips its report and replies silently).
  if ("exists" in r) return { status: mayHaveLanded ? "posted" : "exists" };
  if (e.state === "unknown") return unknownOutcome(e);
  e.state = "rejected"; // also a body that could not be rendered: nothing was sent
  return { status: "rejected", error: message(r.error) };
}
