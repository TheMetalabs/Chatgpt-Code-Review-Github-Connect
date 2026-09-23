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
  classifyStuck,
  DEFAULT_ASHLAR_BOT_LOGIN,
  escalateFromRounds,
  isSelfLogin,
  isStoppedComment,
  stuckPattern,
  parseEscalateMarker,
  parseReviewLoopDirective,
  type EscalateReason,
  type RoundSummary,
} from "./review-loop.ts";
import { deriveLoopSession, type LoopEvent, type LoopSession } from "./review-loop-session.ts";

// Single source of the App identity lives in review-loop.ts (shared with the webhook parser's
// self-trigger guard); re-exported here for existing engine callers.
export { DEFAULT_ASHLAR_BOT_LOGIN };

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
  ): Promise<Array<{ userLogin: string; path: string; commitId: string; createdAt: string; body?: string }>>;
  listIssueComments(
    token: string,
    owner: string,
    repo: string,
    pr: number,
  ): Promise<Array<{ userLogin: string; body: string; createdAt?: string }>>;
  createIssueComment(
    token: string,
    opts: { owner: string; repo: string; pr: number; body: string },
  ): Promise<{ id?: number }>;
}

// The real github.server binding lives at the harbor call site (harbor already imports
// github.server); keeping this module DI-only lets it unit-test without the server graph.

const FINDINGS_RE = /<!--\s*ashlar-findings\s+(.+?)\s*-->/;

function isBot(login: string, botLogin: string): boolean {
  return isSelfLogin(login, botLogin);
}


function parseFindingsTotal(body: string): number | null {
  const m = FINDINGS_RE.exec(body || "");
  if (!m) return null;
  for (const pair of m[1].split(/\s+/)) {
    if (pair.startsWith("total=")) {
      const n = Number(pair.slice("total=".length));
      return Number.isNaN(n) ? null : n;
    }
  }
  return null;
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
  const filesByHead = new Map<string, Set<string>>();
  for (const c of comments) {
    if (!isBot(c.userLogin, botLogin) || !c.commitId || !c.path) continue;
    if (opts.sinceIso && (c.createdAt || "") < opts.sinceIso) continue;
    const head = c.commitId;
    (filesByHead.get(head) ?? filesByHead.set(head, new Set()).get(head)!).add(c.path);
  }

  const byHead = new Map<string, number>();
  const order: string[] = [];
  const ashlarReviews = reviews
    .filter((r) => isBot(r.userLogin, botLogin) && (!opts.sinceIso || (r.submittedAt || "") >= opts.sinceIso))
    .sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""));
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
): Promise<boolean> {
  const issues = await gh.listIssueComments(token, owner, repo, pr);
  for (const c of issues) {
    if (sinceIso && c.createdAt && c.createdAt < sinceIso) continue;
    const parsed = parseEscalateMarker(c.body, { authoredByBot: isBot(c.userLogin, botLogin) });
    if (parsed && parsed.head === head) return true; // full-SHA equality
  }
  return false;
}

// Handoffs THIS process posted (key includes the session anchor), consulted ONLY when the GitHub
// history cannot be read: a sequential redelivery for the same head and session is then a no-op.
// Bounded and pruned by age. Cross-process dedup stays a documented NON-GOAL (single instance).
const postedHandoffs = new Map<string, number>();
const POSTED_HANDOFF_TTL_MS = 24 * 60 * 60_000;
const POSTED_HANDOFF_MAX = 500;

function rememberHandoff(key: string, now: number): void {
  postedHandoffs.set(key, now);
  if (postedHandoffs.size <= POSTED_HANDOFF_MAX) return;
  for (const [k, at] of postedHandoffs) {
    if (now - at > POSTED_HANDOFF_TTL_MS || postedHandoffs.size > POSTED_HANDOFF_MAX) postedHandoffs.delete(k);
    else break;
  }
}

export interface EscalateResult {
  escalated: boolean;
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
    /** Fail closed (error CURRENT_ROUND_MISSING) unless the reviewed head IS the latest round. */
    requireCurrentRound?: boolean;
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
  opts: { owner: string; repo: string; pr: number; head: string; roundCap: number; diffLines?: number; sinceIso?: string; requireCurrentRound?: boolean },
  botLogin: string,
): Promise<EscalateResult> {
  // Fail closed on an incomplete/failed history read: never classify or (dup-)post from
  // partial data — the list helpers throw rather than return a truncated list.
  let rounds: RoundSummary[];
  let escalatedBefore: boolean;
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
    escalatedBefore = await alreadyEscalated(gh, token, opts.owner, opts.repo, opts.pr, opts.head, botLogin, opts.sinceIso);
  } catch (e) {
    return { escalated: false, rounds: [], error: (e as Error)?.message ?? String(e) };
  }
  const reason = classifyStuck(rounds, { roundCap: opts.roundCap, diffLines: opts.diffLines });
  if (!reason) return { escalated: false, rounds };
  if (escalatedBefore) {
    return { escalated: false, reason, rounds }; // one handoff per head
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
  await gh.createIssueComment(token, { owner: opts.owner, repo: opts.repo, pr: opts.pr, body });
  return { escalated: true, reason, rounds };
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
  },
): Promise<{ escalated: boolean; error?: string }> {
  const botLogin = opts.botLogin ?? DEFAULT_ASHLAR_BOT_LOGIN;
  const key = `${opts.owner}/${opts.repo}#${opts.pr}@${opts.head}`;
  const sessionKey = `${key}#${opts.sinceIso ?? ""}`;
  if (inFlightEscalate.has(key)) return { escalated: false, error: ESCALATE_IN_FLIGHT };
  inFlightEscalate.add(key);
  try {
    let before = false;
    try {
      before = await alreadyEscalated(gh, token, opts.owner, opts.repo, opts.pr, opts.head, botLogin, opts.sinceIso);
    } catch {
      // Unreadable history: fall back to what THIS process posted for this head + session (a
      // sequential redelivery is then a no-op); otherwise post rather than end the loop without
      // its signal. The GitHub marker scan stays the source of truth whenever it is readable.
      before = postedHandoffs.has(sessionKey);
    }
    if (before) return { escalated: false };
    const body = escalateFromRounds(opts.reason, opts.rounds, {
      pr: opts.pr,
      head: opts.head,
      repo: `${opts.owner}/${opts.repo}`,
      roundCap: opts.roundCap,
      diffLines: opts.diffLines,
      detail: opts.detail,
    });
    await gh.createIssueComment(token, { owner: opts.owner, repo: opts.repo, pr: opts.pr, body });
    rememberHandoff(sessionKey, Date.now());
    return { escalated: true };
  } catch (e) {
    return { escalated: false, error: (e as Error)?.message ?? String(e) };
  } finally {
    inFlightEscalate.delete(key);
  }
}

// ── Durable loop session (review-loop-session.ts) ─────────────────────────────

/** The PR fields a start directive in the PR body needs (from GET /pulls/{pr}). */
export interface LoopPrInfo {
  body?: string | null;
  createdAt?: string;
  author?: string;
}

function pushDirective(events: LoopEvent[], body: string | null | undefined, at: string, actor: string): void {
  const d = parseReviewLoopDirective(body);
  if (d?.kind === "start") events.push({ at, kind: "start", mode: d.mode, actor });
  else if (d?.kind === "stop") events.push({ at, kind: "stop", actor });
}

/**
 * Collect the PR's loop events from durable history. Authorship is enforced HERE: a human (any
 * non-App author) contributes start/stop directives from issue comments, inline comments and the
 * PR body; ONLY the App contributes escalate / stopped markers and converged (total=0) reviews.
 * A comment's event time is its creation time — a directive added later by EDITING an old
 * comment is not a session start (the webhook path may still run a review for it).
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
      if (parseEscalateMarker(c.body, { authoredByBot: true })) events.push({ at: c.createdAt, kind: "escalate" });
      else if (isStoppedComment(c.body, { authoredByBot: true })) events.push({ at: c.createdAt, kind: "stopped" });
    } else {
      pushDirective(events, c.body, c.createdAt, c.userLogin);
    }
  }
  for (const c of inline) {
    if (c.createdAt && !isSelfLogin(c.userLogin, botLogin)) pushDirective(events, c.body, c.createdAt, c.userLogin);
  }
  const prInfo = opts.pr;
  if (prInfo?.createdAt && prInfo.author && !isSelfLogin(prInfo.author, botLogin)) {
    pushDirective(events, prInfo.body, prInfo.createdAt, prInfo.author);
  }
  for (const r of reviews) {
    if (isSelfLogin(r.userLogin, botLogin) && r.submittedAt && parseFindingsTotal(r.body) === 0) {
      events.push({ at: r.submittedAt, kind: "converged" });
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
  return deriveLoopSession([...events, ...(opts.extra ?? [])]);
}
