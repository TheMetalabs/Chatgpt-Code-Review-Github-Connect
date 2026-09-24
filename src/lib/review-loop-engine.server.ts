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
 * store — here it is in-process + the marker scan); full commit-ancestry verification across a
 * force-push (here it is a proportionate latest-head-must-match-requested-head guard, not a
 * compare-API ancestry walk).
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
import { retryWrite } from "./write-retry.ts";
import { controlInSession, inSession } from "./review-loop-control.ts";

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

/** True if a bot-authored escalate handoff for this head already exists IN THIS SESSION
 * (idempotency). A handoff from an earlier, finished session must not silence a new one: a
 * human who re-runs the loop on the same head after an ESCALATE gets a fresh handoff. */
async function alreadyEscalated(
  gh: ReviewLoopGithub,
  token: string,
  owner: string,
  repo: string,
  pr: number,
  head: string,
  botLogin: string,
  sinceIso?: string,
  sinceSeq?: number,
): Promise<boolean> {
  const issues = await gh.listIssueComments(token, owner, repo, pr);
  for (const c of issues) {
    if (!controlInSession(c, { iso: sinceIso, seq: sinceSeq })) continue;
    const parsed = parseEscalateMarker(c.body, { authoredByBot: isBot(c.userLogin, botLogin) });
    if (parsed && parsed.head === head) return true; // full-SHA equality
  }
  return false;
}

// Control comments THIS process posted (handoffs, continuations, start / stop records), kept per
// GitHub client — production memoizes one client; each test's fake is its own — and consulted
// TOGETHER with the listed history: a just-posted comment may not be listed yet (read-after-write
// lag), and an unreadable history must not duplicate one either. Bounded and pruned by age.
// Cross-process dedup stays a documented NON-GOAL (single harbor instance).
const postedByClient = new WeakMap<object, Map<string, number>>();
const POSTED_TTL_MS = 24 * 60 * 60_000;
const POSTED_MAX = 500;

export function rememberPosted(client: object, key: string, now: number = Date.now()): void {
  const posted = postedByClient.get(client) ?? new Map<string, number>();
  postedByClient.set(client, posted);
  posted.delete(key); // re-insert: keeps the map in age order for pruning
  posted.set(key, now);
  for (const [k, at] of posted) {
    if (posted.size <= POSTED_MAX && now - at <= POSTED_TTL_MS) break;
    posted.delete(k);
  }
}

// Control writes whose outcome is UNKNOWN (they may have landed) and that no list has shown yet —
// a ledger SEPARATE from the confirmed-posted cache above, so "maybe posted" is never read as
// "posted". No expiry and no size-based eviction (a stale list after a day, or after many other
// ambiguous writes, must still not trigger a second POST): an entry leaves only when the matching
// row is actually seen in a list scan. The ledger is therefore bounded by the number of unresolved
// unknown-outcome control writes, each a small string key — rare in practice. An entry may carry a synthetic LoopEvent the session fold must honor meanwhile
// (an ambiguous handoff ends the session in this process).
const maybePostedByClient = new WeakMap<object, Map<string, { event?: LoopEvent }>>();

export function rememberAmbiguous(client: object, key: string, event?: LoopEvent): void {
  const ledger = maybePostedByClient.get(client) ?? new Map<string, { event?: LoopEvent }>();
  maybePostedByClient.set(client, ledger);
  const prev = ledger.get(key);
  ledger.set(key, { event: event ?? prev?.event });
}

export function ambiguousWrite(client: object, key: string): boolean {
  return maybePostedByClient.get(client)?.has(key) ?? false;
}

export function clearAmbiguous(client: object, key: string): void {
  maybePostedByClient.get(client)?.delete(key);
}

/** The synthetic events of this client's unresolved ambiguous writes whose key starts with `prefix`. */
export function ambiguousEvents(client: object, prefix: string): LoopEvent[] {
  const out: LoopEvent[] = [];
  for (const [k, v] of maybePostedByClient.get(client) ?? []) if (v.event && k.startsWith(prefix)) out.push(v.event);
  return out;
}

/**
 * The `seen` probe of an idempotent control write: confirmed-posted cache, then the list `scan`
 * (a hit clears the ambiguity ledger), then the ledger. It is true for posted OR ambiguous — so a
 * write that may have landed is never POSTed again — while `ledgerOnly()` tells the caller the hit
 * came from the ledger alone, to report "outcome unknown" instead of "exists". A failed scan counts
 * as "not seen".
 */
export function dedupProbe(client: object, key: string, scan: () => Promise<boolean>): { seen: () => Promise<boolean>; ledgerOnly: () => boolean } {
  let viaLedger = false;
  return {
    seen: async () => {
      viaLedger = false;
      if (postedRecently(client, key)) return true;
      if (await scan().catch(() => false)) {
        clearAmbiguous(client, key);
        return true;
      }
      viaLedger = ambiguousWrite(client, key);
      return viaLedger;
    },
    ledgerOnly: () => viaLedger,
  };
}

/** Prefix of every handoff key of one PR (see handoffKey). */
export function handoffPrefix(o: { owner: string; repo: string; pr: number }): string {
  return `handoff:${o.owner}/${o.repo}#${o.pr}@`;
}

/** ONE handoff per head per session — the key both handoff paths (stuck classification and
 * terminal failures) record and consult. */
function handoffKey(o: { owner: string; repo: string; pr: number; head: string; sinceIso?: string; sinceSeq?: number }): string {
  return `handoff:${o.owner}/${o.repo}#${o.pr}@${o.head}#${o.sinceSeq ?? o.sinceIso ?? ""}`;
}

export function postedRecently(client: object, key: string, now: number = Date.now()): boolean {
  const at = postedByClient.get(client)?.get(key);
  return at !== undefined && now - at <= POSTED_TTL_MS;
}

/** A handoff POST whose outcome is unknown (it may have landed) and that the scans have not seen
 * yet. It is recorded in the ambiguity ledger (never re-sent, never followed by another handoff
 * for the head) with a synthetic handoff event that ends the session in this process. */
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
  opts: {
    owner: string;
    repo: string;
    pr: number;
    head: string;
    roundCap: number;
    diffLines?: number;
    sinceIso?: string;
    sinceSeq?: number;
    requireCurrentRound?: boolean;
    sleep?: (ms: number) => Promise<void>;
  },
  botLogin: string,
): Promise<EscalateResult> {
  // Fail closed on an incomplete/failed history read: never classify or (dup-)post from
  // partial data — the list helpers throw rather than return a truncated list.
  let rounds: RoundSummary[];
  let escalatedBefore: boolean;
  let ambiguousBefore = false;
  const hk = handoffKey(opts);
  try {
    rounds = await reconstructRounds(gh, token, opts.owner, opts.repo, opts.pr, { botLogin, sinceIso: opts.sinceIso });
    // Only classify when the most recent reconstructed round IS the current head. Otherwise the
    // history is stale or the branch was force-pushed onto a divergent lineage, and those rounds
    // do not belong to this head — never attribute their trend to it.
    if (rounds.length === 0 || rounds[rounds.length - 1].head !== opts.head) {
      if (opts.requireCurrentRound) return { escalated: false, rounds, error: CURRENT_ROUND_MISSING };
      if (rounds.length > 0) return { escalated: false, rounds };
    }
    const reasonPeek = classifyStuck(rounds, { roundCap: opts.roundCap, diffLines: opts.diffLines });
    if (!reasonPeek) return { escalated: false, rounds };
    const listed = await alreadyEscalated(gh, token, opts.owner, opts.repo, opts.pr, opts.head, botLogin, opts.sinceIso, opts.sinceSeq);
    if (listed) clearAmbiguous(gh, hk);
    escalatedBefore = listed || postedRecently(gh, hk);
    ambiguousBefore = !escalatedBefore && ambiguousWrite(gh, hk);
  } catch (e) {
    return { escalated: false, rounds: [], error: (e as Error)?.message ?? String(e) };
  }
  const reason = classifyStuck(rounds, { roundCap: opts.roundCap, diffLines: opts.diffLines });
  if (!reason) return { escalated: false, rounds };
  if (escalatedBefore) {
    return { escalated: false, reason, rounds }; // one handoff per head
  }
  // An earlier handoff for this head may have landed: never a second one, and never "exists".
  if (ambiguousBefore) return { escalated: false, ambiguous: true, reason, rounds };
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
  const probe = dedupProbe(gh, hk, () => alreadyEscalated(gh, token, opts.owner, opts.repo, opts.pr, opts.head, botLogin, opts.sinceIso, opts.sinceSeq));
  const out = await postHandoff(gh, token, opts, body, probe.seen);
  if (out === "exists" && !probe.ledgerOnly()) return { escalated: false, reason, rounds };
  if (out !== "posted") {
    rememberAmbiguous(gh, hk, handoffEvent());
    return { escalated: false, ambiguous: true, reason, rounds };
  }
  rememberPosted(gh, hk);
  return { escalated: true, reason, rounds };
}

/** The synthetic handoff an ambiguous one stands for in this process: it ends the session (a
 * redelivered review of the head never runs another fix) until the real marker is listed. */
function handoffEvent(): LoopEvent {
  return { at: new Date().toISOString(), kind: "escalate" };
}

/** Delays before each terminal-handoff POST attempt. A handoff has no other poster, so one
 * transient failure must not leave the session active with no signal (a silent stall). */
export const HANDOFF_RETRY_DELAYS_MS = [0, 2_000, 5_000];

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * POST a terminal handoff, retrying transient failures. Before every retry the handoff scan runs
 * again, so a POST that GitHub accepted but whose response was lost is not posted twice once it
 * is visible (the transport never re-sends a write itself). An unreadable scan still posts: a
 * duplicate handoff is harmless next to a loop that stops silently. Throws the last error.
 */
async function postHandoff(
  gh: ReviewLoopGithub,
  token: string,
  o: { owner: string; repo: string; pr: number; sleep?: (ms: number) => Promise<void> },
  body: string,
  seen: () => Promise<boolean>,
): Promise<"posted" | "exists" | "ambiguous"> {
  // retryWrite: a POST whose outcome is unknown (it may have landed) is never sent again; the
  // remaining schedule only re-checks the scan.
  const r = await retryWrite({
    delays: HANDOFF_RETRY_DELAYS_MS,
    sleep: o.sleep ?? defaultSleep,
    seen,
    scanFirst: false,
    post: () => gh.createIssueComment(token, { owner: o.owner, repo: o.repo, pr: o.pr, body }),
  });
  if ("posted" in r) return "posted";
  if ("exists" in r) return "exists";
  if (r.ambiguous) return "ambiguous"; // may have landed: the caller records it, never re-posts
  throw r.error;
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
  },
): Promise<{ escalated: boolean; ambiguous?: boolean; error?: string }> {
  const botLogin = opts.botLogin ?? DEFAULT_ASHLAR_BOT_LOGIN;
  const key = `${opts.owner}/${opts.repo}#${opts.pr}@${opts.head}`;
  const sessionKey = handoffKey(opts);
  if (inFlightEscalate.has(key)) return { escalated: false, error: ESCALATE_IN_FLIGHT };
  inFlightEscalate.add(key);
  try {
    let before = false;
    try {
      const listed = await alreadyEscalated(gh, token, opts.owner, opts.repo, opts.pr, opts.head, botLogin, opts.sinceIso, opts.sinceSeq);
      if (listed) clearAmbiguous(gh, sessionKey);
      before = listed || postedRecently(gh, sessionKey);
    } catch {
      // Unreadable history: fall back to what THIS process posted for this head + session (a
      // sequential redelivery is then a no-op); otherwise post rather than end the loop without
      // its signal.
      before = postedRecently(gh, sessionKey);
    }
    if (before) return { escalated: false };
    // An earlier handoff for this head may have landed: never a second one, and never "exists".
    if (ambiguousWrite(gh, sessionKey)) return { escalated: false, ambiguous: true, error: HANDOFF_OUTCOME_UNKNOWN };
    const body = escalateFromRounds(opts.reason, opts.rounds, {
      pr: opts.pr,
      head: opts.head,
      repo: `${opts.owner}/${opts.repo}`,
      roundCap: opts.roundCap,
      diffLines: opts.diffLines,
      detail: opts.detail,
    });
    const probe = dedupProbe(gh, sessionKey, () =>
      alreadyEscalated(gh, token, opts.owner, opts.repo, opts.pr, opts.head, botLogin, opts.sinceIso, opts.sinceSeq),
    );
    const out = await postHandoff(gh, token, opts, body, probe.seen);
    if (out === "exists" && !probe.ledgerOnly()) return { escalated: false };
    if (out !== "posted") {
      rememberAmbiguous(gh, sessionKey, handoffEvent());
      return { escalated: false, ambiguous: true, error: HANDOFF_OUTCOME_UNKNOWN };
    }
    rememberPosted(gh, sessionKey);
    return { escalated: true };
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
    if (!c.createdAt) continue;
    if (isSelfLogin(c.userLogin, botLogin)) {
      const bot = { authoredByBot: true };
      const start = parseStartMarker(c.body, bot);
      const stopRecord = parseStopRecord(c.body, bot);
      const cont = canonicalContinuation(c.body, bot);
      if (start) events.push({ at: start.at, kind: "start", mode: start.mode, actor: start.by, ...(c.id ? { seq: c.id } : {}) });
      else if (parseEscalateMarker(c.body, bot)) events.push({ at: c.createdAt, kind: "escalate" });
      // A recorded stop is placed at the stop's own time (an edit or a PR-body stop the fold
      // cannot replay); a bare legacy acknowledgement is an event at its own creation.
      else if (stopRecord) events.push({ at: stopRecord.at, kind: "stop", actor: stopRecord.by });
      else if (isStoppedComment(c.body, bot)) events.push({ at: c.createdAt, kind: "stopped" });
      else if (cont && cont.pr === pr) events.push({ at: c.createdAt, kind: "continue", head: cont.head });
    } else {
      pushStop(events, c);
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
