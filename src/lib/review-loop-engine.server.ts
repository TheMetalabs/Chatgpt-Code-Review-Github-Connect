/**
 * Review-loop ESCALATE engine (design §8), in ashlar so it reuses the single-source
 * escalate composer (review-loop.ts §3) — no cross-repo drift. Reconstructs a PR's
 * per-round finding trend from ashlar's own reviews, classifies why the loop is stuck,
 * and emits the FIXED handoff. The external driver (grokbot cc_digest) only DETECTS it.
 *
 * Dependency-injected GitHub access (ReviewLoopGithub) so it unit-tests with fakes and
 * never forces the harbor test fixture to stub new methods.
 *
 * INVARIANTS: reviews/comments are attributed by EXACT bot login and FULL commit SHA, scoped to
 * the current loop session (sinceIso) and the current head; history reads fail closed (throw →
 * maybeEscalate aborts, never dup-posts); an in-process per-head guard serializes concurrent calls.
 * NON-GOALS (owned by the orchestrator): durable cross-PROCESS escalation dedup (needs a shared
 * store — here it is the in-process control-write journal + the marker scan); full
 * commit-ancestry verification across a force-push (here it is a proportionate
 * latest-head-must-match-requested-head guard, not a compare-API ancestry walk).
 */
import {
  canonicalContinuation,
  classifyStuck,
  DEFAULT_ASHLAR_BOT_LOGIN,
  escalateFromRounds,
  isoMs,
  isSelfLogin,
  isStoppedComment,
  stuckPattern,
  parseEscalateMarker,
  parseFindingsTotal,
  parseReviewLoopDirective,
  parseStartMarker,
  parseStopRecord,
  type EscalateReason,
  type RoundSummary,
} from "./review-loop.ts";
import { deriveLoopSession, type LoopEvent, type LoopSession } from "./review-loop-session.ts";
import {
  assertNever,
  controlInSession,
  datable,
  emitControl,
  inSession,
  ownWrites,
  type ControlWrite,
  type EmitOutcome,
} from "./review-loop-control.ts";

// Single source of the App identity lives in review-loop.ts (shared with the webhook parser's
// self-trigger guard); re-exported here for existing engine callers.
export { DEFAULT_ASHLAR_BOT_LOGIN };
// The session-scoping rule of a control comment lives with the control writes; re-exported for
// existing engine callers.
export { controlInSession };

export interface ReviewLoopGithub {
  listPullReviews(
    token: string,
    owner: string,
    repo: string,
    pr: number,
  ): Promise<Array<{ userLogin: string; body: string; commitId: string; submittedAt: string }>>;
  listReviewComments(
    token: string,
    owner: string,
    repo: string,
    pr: number,
  ): Promise<Array<{ userLogin: string; path: string; commitId: string; createdAt: string; body?: string; updatedAt?: string }>>;
  listIssueComments(
    token: string,
    owner: string,
    repo: string,
    pr: number,
  ): Promise<Array<{ id?: number; userLogin: string; body: string; createdAt?: string; updatedAt?: string }>>;
  // The created row as GitHub reported it (fakes may return only `id`); a failure throws
  // github-transport's GithubWriteError (`status`, `outcome`).
  createIssueComment(
    token: string,
    opts: { owner: string; repo: string; pr: number; body: string },
  ): Promise<{ id?: number; userLogin?: string; createdAt?: string }>;
}

// The real github.server binding lives at the harbor call site (harbor already imports
// github.server); keeping this module DI-only lets it unit-test without the server graph.

function isBot(login: string, botLogin: string): boolean {
  return isSelfLogin(login, botLogin);
}

/**
 * One ROUND = one reviewed head. Multiple ashlar reviews on the same head (an explicit
 * request plus a push-triggered synchronize review) collapse into one round so re-reviews
 * of the same commit do not inflate the count; the latest review for a head wins its
 * finding total, files are the union of that head's inline comments.
 */
export async function reconstructRounds(
  gh: ReviewLoopGithub,
  token: string,
  owner: string,
  repo: string,
  pr: number,
  opts: { botLogin?: string; sinceIso?: string } = {},
): Promise<RoundSummary[]> {
  const botLogin = opts.botLogin ?? DEFAULT_ASHLAR_BOT_LOGIN;
  const [reviews, comments] = await Promise.all([
    gh.listPullReviews(token, owner, repo, pr),
    gh.listReviewComments(token, owner, repo, pr),
  ]);

  // Full commit SHA is identity everywhere (a 7-char prefix can collide); short() is display-only.
  // G6: a comment counts only if it is in-session (created at/after sinceIso), so a pre-loop
  // comment on a head cannot leak into the current loop's file history.
  const sinceMs = isoMs(opts.sinceIso);
  const filesByHead = new Map<string, Set<string>>();
  for (const c of comments) {
    if (!isBot(c.userLogin, botLogin) || !c.commitId || !c.path) continue;
    if (!inSession(c.createdAt, sinceMs)) continue;
    const head = c.commitId;
    (filesByHead.get(head) ?? filesByHead.set(head, new Set()).get(head)!).add(c.path);
  }

  const byHead = new Map<string, number>();
  const order: string[] = [];
  const at = (iso: string | undefined) => isoMs(iso) || 0; // unparseable (no anchor only): oldest
  const ashlarReviews = reviews
    .filter((r) => isBot(r.userLogin, botLogin) && inSession(r.submittedAt, sinceMs))
    .sort((a, b) => at(a.submittedAt) - at(b.submittedAt));
  for (const rv of ashlarReviews) {
    const total = parseFindingsTotal(rv.body);
    if (total === null) continue; // ops / non-summary review row
    const head = rv.commitId;
    if (!head) continue;
    if (!byHead.has(head)) order.push(head);
    byHead.set(head, total);
  }

  return order.map((head, i) => ({
    index: i + 1,
    findings: byHead.get(head) ?? 0,
    files: [...(filesByHead.get(head) ?? [])],
    head,
  }));
}

type HandoffTarget = { owner: string; repo: string; pr: number; head: string; sinceIso?: string; sinceSeq?: number };

/** THE handoff of a head in a session: one, whichever path (stuck classification or a terminal
 * failure) posts it. */
function handoffWrite(o: HandoffTarget, body: string): ControlWrite {
  return {
    key: { kind: "handoff", ref: { owner: o.owner, repo: o.repo, pr: o.pr }, head: o.head, sessionIso: o.sinceIso },
    body,
    since: { iso: o.sinceIso, seq: o.sinceSeq },
  };
}

/** True if a bot-authored escalate handoff for this head is LISTED in this session (idempotency;
 * the listed row also confirms this process's own write). A handoff from an earlier, finished
 * session must not silence a new one: a human who re-runs the loop on the same head after an
 * ESCALATE gets a fresh handoff. Throws on a failed read. */
async function alreadyEscalated(gh: ReviewLoopGithub, token: string, o: HandoffTarget, botLogin: string): Promise<boolean> {
  const rows = await gh.listIssueComments(token, o.owner, o.repo, o.pr);
  return ownWrites(gh).seen(handoffWrite(o, ""), rows, botLogin);
}

/** A handoff POST whose outcome is unknown (it may have landed) and that no list shows yet. It is
 * never re-sent nor followed by another handoff for the head, and its journal entry ends the
 * session in this process (placed at the POST attempt). */
export const HANDOFF_OUTCOME_UNKNOWN = "the handoff's outcome is unknown (it may have landed; not re-sent)";

export interface EscalateResult {
  escalated: boolean;
  /** The handoff may have landed (unknown write outcome): treat the head as handed off. */
  ambiguous?: boolean;
  reason?: EscalateReason;
  rounds: RoundSummary[];
  /** Set when history was incomplete/failed and escalation was skipped fail-closed. */
  error?: string;
}

/** The reviewed head is not the latest reconstructed round: the history does not (yet) show
 * this review — a lagging read, or reviews not attributable to the bot login. The budget can
 * only be enforced from an attributable history, so a strict caller must not fix blind. */
export const CURRENT_ROUND_MISSING = "the current review is not the latest round in the loop history";

/**
 * Reconstruct the loop, classify, and — if stuck and not already escalated on this head —
 * emit the fixed ESCALATE handoff. Safe to call after every loop review: a non-stuck loop
 * (converged or still making progress) returns without posting.
 */
// In-process serialization so two concurrent maybeEscalate calls for the same PR/head cannot
// both pass the check-then-post idempotency window and double-emit. (Cross-process dedup still
// relies on the alreadyEscalated marker scan; note that in a multi-instance deploy.)
const inFlightEscalate = new Set<string>();

/** Another loop step for this PR/head holds the escalation guard; the caller backs off quietly. */
export const ESCALATE_IN_FLIGHT = "escalate already in flight for this head";

export async function maybeEscalate(
  gh: ReviewLoopGithub,
  token: string,
  opts: {
    owner: string;
    repo: string;
    pr: number;
    head: string;
    roundCap: number;
    diffLines?: number;
    botLogin?: string;
    sinceIso?: string;
    /** The session's start-record comment id (exact handoff scoping; see controlInSession). */
    sinceSeq?: number;
    /** Fail closed (error CURRENT_ROUND_MISSING) unless the reviewed head IS the latest round —
     * including a history with ZERO attributable rounds, which then can never "pass" the budget.
     * The loop runtime always sets it; a lenient caller only classifies a history it can see and
     * gets no budget guarantee for an unattributable one (classifyStuck([]) is null). */
    requireCurrentRound?: boolean;
    /** Waits between handoff POST retries (injectable for tests). */
    sleep?: (ms: number) => Promise<void>;
    /** The clock a handoff attempt is stamped with (injectable for tests). */
    now?: () => number;
  },
): Promise<EscalateResult> {
  const botLogin = opts.botLogin ?? DEFAULT_ASHLAR_BOT_LOGIN;
  const key = `${opts.owner}/${opts.repo}#${opts.pr}@${opts.head}`;
  if (inFlightEscalate.has(key)) return { escalated: false, rounds: [], error: ESCALATE_IN_FLIGHT };
  inFlightEscalate.add(key);
  try {
    return await maybeEscalateInner(gh, token, opts, botLogin);
  } finally {
    inFlightEscalate.delete(key);
  }
}

async function maybeEscalateInner(
  gh: ReviewLoopGithub,
  token: string,
  opts: HandoffTarget & {
    roundCap: number;
    diffLines?: number;
    requireCurrentRound?: boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
  botLogin: string,
): Promise<EscalateResult> {
  // Fail closed on an incomplete/failed history read: never classify or (dup-)post from
  // partial data — the list helpers throw rather than return a truncated list.
  let rounds: RoundSummary[];
  let reason: EscalateReason | null;
  try {
    rounds = await reconstructRounds(gh, token, opts.owner, opts.repo, opts.pr, { botLogin, sinceIso: opts.sinceIso });
    // Only classify when the most recent reconstructed round IS the current head. Otherwise the
    // history is stale or the branch was force-pushed onto a divergent lineage, and those rounds
    // do not belong to this head — never attribute their trend to it.
    if (rounds.length === 0 || rounds[rounds.length - 1].head !== opts.head) {
      if (opts.requireCurrentRound) return { escalated: false, rounds, error: CURRENT_ROUND_MISSING };
      if (rounds.length > 0) return { escalated: false, rounds };
    }
    reason = classifyStuck(rounds, { roundCap: opts.roundCap, diffLines: opts.diffLines });
    if (!reason) return { escalated: false, rounds };
    if (await alreadyEscalated(gh, token, opts, botLogin)) return { escalated: false, reason, rounds }; // one handoff per head
  } catch (e) {
    return { escalated: false, rounds: [], error: (e as Error)?.message ?? String(e) };
  }
  // The budget is authoritative (round-cap), but the trend pattern still guides the human.
  const pattern = reason === "round-cap" ? stuckPattern(rounds) : null;
  const body = escalateFromRounds(reason, rounds, {
    pr: opts.pr,
    head: opts.head, // full SHA — the marker is the idempotency key
    repo: `${opts.owner}/${opts.repo}`,
    roundCap: opts.roundCap,
    diffLines: opts.diffLines,
    detail: pattern ? `fix-round budget spent; the finding trend also shows ${pattern}` : undefined,
  });
  const out = await emitHandoff(gh, token, opts, body, botLogin);
  switch (out.status) {
    case "posted":
      return { escalated: true, reason, rounds };
    case "exists": // an earlier emit's, or listed before this one sent anything
      return { escalated: false, reason, rounds };
    case "unknown": // it may have landed: never a second one, and never "exists"
      return { escalated: false, ambiguous: true, reason, rounds };
    case "rejected": // nothing landed: the loop step hands off loop-error for this head instead
      throw new Error(out.error);
    default:
      return assertNever(out);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * POST a terminal handoff through the control gate: a refused POST is retried with backoff (a
 * handoff has no other poster, so one transient failure must not leave the session active with no
 * signal), and one whose outcome is unknown is never sent again — its attempt time stands in for
 * it in every session read until the row is listed. The caller has just scanned the history.
 */
function emitHandoff(
  gh: ReviewLoopGithub,
  token: string,
  o: HandoffTarget & { sleep?: (ms: number) => Promise<void>; now?: () => number },
  body: string,
  botLogin: string,
): Promise<EmitOutcome> {
  const ctx = { gh, token, botLogin, sleep: o.sleep ?? defaultSleep, now: o.now ?? (() => Date.now()), scanFirst: false };
  return emitControl(ctx, handoffWrite(o, body));
}

/**
 * Emit the fixed ESCALATE handoff for a NON-stuck terminal failure (fix-failed / fix-declined /
 * loop-error) on this head. One handoff per head: shares the in-flight guard and the marker
 * idempotency with maybeEscalate. Unlike classification, a failed idempotency READ does not
 * suppress the post — the failure itself is the signal, and a duplicate handoff is harmless
 * next to a loop that stops silently.
 */
export async function escalateNow(
  gh: ReviewLoopGithub,
  token: string,
  opts: {
    owner: string;
    repo: string;
    pr: number;
    head: string;
    reason: EscalateReason;
    detail?: string;
    rounds: RoundSummary[];
    roundCap: number;
    diffLines?: number;
    botLogin?: string;
    /** Session anchor: only handoffs posted in this session count for idempotency. */
    sinceIso?: string;
    /** The session's start-record comment id (exact handoff scoping; see controlInSession). */
    sinceSeq?: number;
    /** Waits between handoff POST retries (injectable for tests). */
    sleep?: (ms: number) => Promise<void>;
    /** The clock a handoff attempt is stamped with (injectable for tests). */
    now?: () => number;
  },
): Promise<{ escalated: boolean; ambiguous?: boolean; error?: string }> {
  const botLogin = opts.botLogin ?? DEFAULT_ASHLAR_BOT_LOGIN;
  const key = `${opts.owner}/${opts.repo}#${opts.pr}@${opts.head}`;
  if (inFlightEscalate.has(key)) return { escalated: false, error: ESCALATE_IN_FLIGHT };
  inFlightEscalate.add(key);
  try {
    // An unreadable history does not suppress the post (the failure is the signal); the journal
    // still knows this process's own handoff for the head and session (a landed one until
    // LANDED_KEPT later landings retire it), so the emit below finds it and POSTs nothing.
    if (await alreadyEscalated(gh, token, opts, botLogin).catch(() => false)) return { escalated: false };
    const body = escalateFromRounds(opts.reason, opts.rounds, {
      pr: opts.pr,
      head: opts.head,
      repo: `${opts.owner}/${opts.repo}`,
      roundCap: opts.roundCap,
      diffLines: opts.diffLines,
      detail: opts.detail,
    });
    const out = await emitHandoff(gh, token, opts, body, botLogin);
    switch (out.status) {
      case "posted":
        return { escalated: true };
      case "exists":
        return { escalated: false };
      case "unknown": // it may have landed: never a second one, and never "exists"
        return { escalated: false, ambiguous: true, error: HANDOFF_OUTCOME_UNKNOWN };
      case "rejected":
        return { escalated: false, error: out.error };
      default:
        return assertNever(out);
    }
  } catch (e) {
    return { escalated: false, error: (e as Error)?.message ?? String(e) };
  } finally {
    inFlightEscalate.delete(key);
  }
}

// ── Durable loop session (review-loop-session.ts) ─────────────────────────────

/** The PR fields the session needs (from GET /pulls/{pr}): the live head (a clean review of any
 * other head cannot end the session unless the loop waits on it). */
export interface LoopPrInfo {
  sha?: string;
}

/** A comment edited after it was created: its CURRENT text says nothing about what it said at
 * creation, so it cannot place a directive in time (the webhook handles edits as they happen). */
function edited(c: { createdAt?: string; updatedAt?: string }): boolean {
  return isoMs(c.updatedAt) > isoMs(c.createdAt);
}

/** A human STOP directive in an unedited comment (a start is never read from human text). */
function pushStop(events: LoopEvent[], c: { body?: string; createdAt?: string; updatedAt?: string; userLogin: string }): void {
  if (!c.createdAt || edited(c)) return;
  if (parseReviewLoopDirective(c.body)?.kind === "stop") events.push({ at: c.createdAt, kind: "stop", actor: c.userLogin });
}

/**
 * The loop event of one of the App's own issue comments. Start and stop RECORDS carry their own
 * time in the marker, so a row without a usable createdAt still holds them; every other App event
 * is placed at the row's createdAt and needs a real instant. The journal retires a stand-in only
 * for a row this collects (review-loop-control collectable): keep the two in step.
 */
function appEvent(c: { id?: number; body: string; createdAt?: string }, pr: number): LoopEvent | undefined {
  const bot = { authoredByBot: true };
  const at = datable(c.createdAt) ? c.createdAt : undefined;
  const start = parseStartMarker(c.body, bot);
  if (start) return { at: start.at, kind: "start", mode: start.mode, actor: start.by, ...(c.id ? { seq: c.id } : {}) };
  if (parseEscalateMarker(c.body, bot)) return at ? { at, kind: "escalate" } : undefined;
  // A recorded stop is placed at the stop's own time (an edit or a PR-body stop the fold cannot
  // replay); a bare legacy acknowledgement is an event at its own creation.
  const stopRecord = parseStopRecord(c.body, bot);
  if (stopRecord) return { at: stopRecord.at, kind: "stop", actor: stopRecord.by };
  if (isStoppedComment(c.body, bot)) return at ? { at, kind: "stopped" } : undefined;
  const cont = canonicalContinuation(c.body, bot);
  return cont && cont.pr === pr && at ? { at, kind: "continue", head: cont.head } : undefined;
}

/**
 * Collect the PR's loop events from durable history. Authorship is enforced HERE:
 * - STARTS come only from the App's start record (review-loop.ts startComment), posted when harbor
 *   accepts a fresh start directive, at the directive's own event time. Mutable human text — a
 *   comment body, the PR body — is never replayed as a start: an edit cannot plant a backdated one.
 * - A human contributes STOP directives from UNEDITED issue and inline comments (at creation).
 *   An edited stop, and a stop added to the PR body, reach the loop through the webhook at their
 *   edit time; the App's STOPPED acknowledgement RECORDS them (review-loop.ts stoppedComment),
 *   placed at the stop's own time — never at the acknowledgement's.
 * - ONLY the App contributes escalate / stopped markers, its canonical continuation for THIS PR
 *   (the head the loop moved to), and converged (total=0) reviews with their commit.
 * - The App's own control writes that the list does not show yet come from its journal
 *   (review-loop-control.ts OwnWrites): a lagging list never hides what this process wrote.
 * Reads fail closed: a list error throws (the caller must not act on a partial history).
 */
export async function readLoopEvents(
  gh: ReviewLoopGithub,
  token: string,
  owner: string,
  repo: string,
  pr: number,
  opts: { botLogin?: string; pr?: LoopPrInfo } = {},
): Promise<LoopEvent[]> {
  const botLogin = opts.botLogin ?? DEFAULT_ASHLAR_BOT_LOGIN;
  const [issues, inline, reviews] = await Promise.all([
    gh.listIssueComments(token, owner, repo, pr),
    gh.listReviewComments(token, owner, repo, pr),
    gh.listPullReviews(token, owner, repo, pr),
  ]);
  const events: LoopEvent[] = [];
  for (const c of issues) {
    if (!isSelfLogin(c.userLogin, botLogin)) pushStop(events, c);
    else {
      const e = appEvent(c, pr);
      if (e) events.push(e);
    }
  }
  for (const c of inline) {
    if (!isSelfLogin(c.userLogin, botLogin)) pushStop(events, c);
  }
  for (const r of reviews) {
    if (isSelfLogin(r.userLogin, botLogin) && r.submittedAt && parseFindingsTotal(r.body) === 0) {
      events.push({ at: r.submittedAt, kind: "converged", head: r.commitId || undefined });
    }
  }
  // Read-your-writes: this process's control writes the list does not show yet stand in for their
  // rows (and a listed row confirms its write) — on every session read, before any gate acts.
  events.push(...ownWrites(gh).standIns({ owner, repo, pr }, issues, botLogin));
  return events;
}

/** The PR's current loop session (pure fold over readLoopEvents). */
export async function readLoopSession(
  gh: ReviewLoopGithub,
  token: string,
  owner: string,
  repo: string,
  pr: number,
  opts: { botLogin?: string; pr?: LoopPrInfo; extra?: LoopEvent[] } = {},
): Promise<LoopSession> {
  const events = await readLoopEvents(gh, token, owner, repo, pr, opts);
  return deriveLoopSession([...events, ...(opts.extra ?? [])], { liveHead: opts.pr?.sha });
}
