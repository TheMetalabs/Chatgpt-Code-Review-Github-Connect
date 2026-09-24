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
 * - OwnWrites journals every write, never evicted by age or size. Every session read reconciles it
 *   against the listed history (a listed row confirms its entry) and folds the entries the list does
 *   not show yet as stand-in events: the loop reads its own writes.
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
import type { LoopEvent, LoopSession } from "./review-loop-session.ts";
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

/** What a control write IS, independent of its text: the identity every dedup check keys on. */
export type ControlKey =
  | { kind: "start"; ref: PrRef; by: string; at: string; mode: ReviewLoopMode }
  | { kind: "stop"; ref: PrRef; by: string; at: string }
  | { kind: "continue"; ref: PrRef; head: string; sessionIso?: string }
  | { kind: "handoff"; ref: PrRef; head: string; sessionIso?: string };

export function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.pr}`.toLowerCase();
}

/**
 * The key string of a write. A session is named by its anchor INSTANT, never by the start record's
 * comment id: a start whose POST outcome is unknown has no id until it is listed, and a key that
 * changed mid-session would let the same continuation or handoff be POSTed twice.
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
      return `${k.kind}:${pr}@${k.head}#${k.sessionIso ? isoMs(k.sessionIso) : ""}`;
    default:
      return assertNever(k);
  }
}

export interface ControlWrite {
  key: ControlKey;
  /** Lazy so a continuation computes its round only when a POST is really sent — and so a caller
   * reaches emitControl with no await (the single-flight join point). */
  body: string | (() => Promise<string>);
  /** The session a continuation or handoff belongs to (its rows are matched only in it). */
  since?: { iso?: string; seq?: number };
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
      return !!c && c.pr === k.ref.pr && c.head === k.head && controlInSession(row, w.since ?? {});
    }
    case "handoff":
      return parseEscalateMarker(row.body, bot)?.head === k.head && controlInSession(row, w.since ?? {}); // full-SHA equality
    default:
      return assertNever(k);
  }
}

export function listedMatch(rows: readonly ControlRow[], w: ControlWrite, botLogin: string): ControlRow | undefined {
  return rows.find((r) => isSelfLogin(r.userLogin, botLogin) && rowMatches(w, r));
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

/** Folded while not listed: a write-ahead intent, a posted write, or one that may have landed. Not
 * while its POST is in flight (no phantom), and not a refused write — a refused start stays
 * repairable by the loop step, a refused handoff leaves the session active. */
function folds(e: OwnWrite): boolean {
  return e.writeAhead || e.state === "posted" || e.state === "unknown";
}

/** The event an own write that is not listed yet stands for. A continuation or handoff is placed
 * at the server's time, or at its POST attempt when the outcome is unknown — never at "now": a
 * newer start between the two must not be ended by an old session's handoff. A 2xx row with no
 * created_at reaches here as "" (github.server's shape), and the fold drops an undatable event:
 * that is a missing time too, so it falls back to the attempt. */
function standInEvent(e: OwnWrite): LoopEvent {
  const k = e.write.key;
  switch (k.kind) {
    case "start":
      return { at: k.at, kind: "start", mode: k.mode, actor: k.by, ...(e.row?.id ? { seq: e.row.id } : {}) };
    case "stop":
      return { at: k.at, kind: "stop", actor: k.by };
    case "continue":
      return { at: e.row?.createdAt || e.attemptAt || "", kind: "continue", head: k.head };
    case "handoff":
      return { at: e.row?.createdAt || e.attemptAt || "", kind: "escalate" };
    default:
      return assertNever(k);
  }
}

/** The control writes one GitHub client made in this process. No TTL and no size cap: an entry that
 * may have landed must keep blocking a second POST for as long as the process lives. */
export class OwnWrites {
  private readonly byPr = new Map<string, Map<string, OwnWrite>>();

  private entries(ref: PrRef): Map<string, OwnWrite> {
    const pr = prKey(ref);
    const found = this.byPr.get(pr);
    if (found) return found;
    const fresh = new Map<string, OwnWrite>();
    this.byPr.set(pr, fresh);
    return fresh;
  }

  /** The entry of `w` (created unsent), carrying the latest text and session scope of the write. */
  upsert(w: ControlWrite): OwnWrite {
    const all = this.entries(w.key.ref);
    const key = controlKey(w.key);
    const e = all.get(key);
    if (!e) {
      const fresh: OwnWrite = { write: w, writeAhead: false, state: "intent" };
      all.set(key, fresh);
      return fresh;
    }
    if (!e.inflight) e.write = w;
    return e;
  }

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
    const all = this.entries(w.key.ref);
    const key = controlKey(w.key);
    if (all.get(key)?.state === "intent" && !all.get(key)?.inflight) all.delete(key);
  }

  /** A listed row that is `w`: confirms the entry (it is no longer unknown). */
  seen(w: ControlWrite, rows: readonly ControlRow[], botLogin: string): boolean {
    const hit = listedMatch(rows, w, botLogin);
    const e = this.entries(w.key.ref).get(controlKey(w.key));
    if (hit && e) confirm(e, hit);
    return !!hit;
  }

  /** RECONCILE, then FOLD: every entry of the PR that a listed row matches is confirmed; every
   * other entry that folds becomes a stand-in event. Called on every session read. */
  standIns(ref: PrRef, listed: readonly ControlRow[], botLogin: string): LoopEvent[] {
    const out: LoopEvent[] = [];
    for (const e of this.byPr.get(prKey(ref))?.values() ?? []) {
      const hit = listedMatch(listed, e.write, botLogin);
      if (hit) confirm(e, hit);
      else if (folds(e)) out.push(standInEvent(e));
    }
    return out;
  }

  /**
   * The kind of THIS process's own write that ended session `s` when that write may not be
   * durable: a handoff whose outcome is unknown. Only this process sees that end — a restart
   * forgets it and the durable history may still show the session active — so a gate must never
   * treat it as a settled end. Call it with a session read that just reconciled the journal.
   */
  unconfirmedEnd(ref: PrRef, s: Pick<LoopSession, "active" | "endedBy" | "endedAt">): "handoff" | undefined {
    if (s.active || s.endedBy !== "escalate") return undefined;
    const at = isoMs(s.endedAt);
    return this.unresolved(ref, "handoff").some((u) => isoMs(u.attemptAt) === at) ? "handoff" : undefined;
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

function confirm(e: OwnWrite, row: ControlRow): void {
  if (e.state === "sending") return; // its POST answers for it
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
 * Emit one control write: at most one POST that may have landed, ever, per key in this process.
 * Synchronous up to the join, so a concurrent emit of the same key shares this one's outcome.
 */
export function emitControl(ctx: EmitContext, w: ControlWrite): Promise<EmitOutcome> {
  const e = ownWrites(ctx.gh).upsert(w);
  if (e.inflight) return e.inflight;
  const run = emitOnce(ctx, e).finally(() => {
    e.inflight = undefined;
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

/** A write that may have landed is only ever looked for again (a failed read finds nothing). */
async function recheck(ctx: EmitContext, e: OwnWrite): Promise<EmitOutcome> {
  const { ref } = e.write.key;
  const rows = await ctx.gh.listIssueComments(ctx.token, ref.owner, ref.repo, ref.pr).catch(() => null);
  const hit = rows ? listedMatch(rows, e.write, ctx.botLogin) : undefined;
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
