/**
 * Review-loop primitives: fixed, deterministic terminal signals and trigger parsing.
 *
 * WHY every terminal signal here is a FIXED literal emitted by this deterministic
 * code (never composed by an LLM): the loop driver / poller detects handoff by
 * substring match, exactly like `"didn't find any major issues"` detects clean.
 * If the phrasing were model-generated it would drift and detection would break.
 * See docs/review-loop-design.md §3.
 */

// ── Terminal signals (§3) ────────────────────────────────────────────────────
// Machine markers carry structured data as attributes; human sentences are
// immutable literals. Both are emitted by the driver, matched as substrings.

export const REVIEW_LOOP_ESCALATE_HUMAN = "Ashlar review-loop halted — human review required";
export const REVIEW_LOOP_STOPPED_HUMAN = "Ashlar review-loop stopped by operator";
/** The sentence of a stop record posted while a NEWER session runs (stopRecordComment): not a
 * terminal signal, so it never contains REVIEW_LOOP_STOPPED_HUMAN or the STOPPED marker. */
export const REVIEW_LOOP_STOP_RECORD_HUMAN = "Ashlar review-loop records an earlier stop; a loop session started after it is active and this record does not stop it";

export const STOPPED_MARKER = "<!-- ashlar-loop-stopped -->";

/** The findings marker is the TRAILING line of every ashlar review body (review-format.ts ends
 * each body with it, and capReviewBody preserves it when truncating). Only a marker at the very
 * end counts: one quoted earlier in a body — even one an emitter forgot to neutralize — is prose,
 * never a count, exactly like the control markers that must OPEN their comment. */
const FINDINGS_TRAILER_RE = /<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/;

/** The review's finding total from its trailing marker; null when there is none (an ops or
 * non-summary review) or it carries no total. total=0 is the machine side of CONVERGED (§3). */
export function parseFindingsTotal(body: string | null | undefined): number | null {
  const m = FINDINGS_TRAILER_RE.exec(body || "");
  if (!m) return null;
  const t = /(?:^|\s)total=(\d{1,6})(?=\s|$)/.exec(m[1]);
  return t ? Number(t[1]) : null;
}

/** Epoch ms of an ISO-8601 timestamp; NaN when absent or unparseable. Session boundaries are
 * compared as instants, never as strings: GitHub timestamps are second-precision ("…00Z") while
 * Date#toISOString carries milliseconds ("…00.500Z"), and lexically "…00Z" sorts after "…00.500Z". */
export function isoMs(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : NaN;
}

/**
 * Terminal-signal detectors trust ONLY bot-authored comments. WHY: the markers are
 * fixed, user-writable HTML comments (design §3); a driver that scanned arbitrary
 * comments could be spoofed into converging / stopping / escalating a loop by anyone
 * who posts the literal. Callers must prove the comment was authored by the bot.
 *
 * Provenance beyond authorship: terminal markers are emitted ONLY by the deterministic
 * driver in its own control/review comments, never composed by a reviewer model. A bot
 * review body that merely QUOTES a marker in model-derived text is already defanged by
 * neutralizeMarkers() (review-format.ts), which escapes every `<!--`/`-->`. A per-comment
 * nonce is deliberately NOT used: design §3 requires terminal signals to be FIXED literals
 * detected by substring (like "didn\'t find any major issues"); a nonce would break that
 * contract. Callers therefore scan only the driver\'s own control comments.
 */
export interface CommentSource {
  authoredByBot: boolean;
}

export function isZeroFindings(body: string | null | undefined, source: CommentSource): boolean {
  return source.authoredByBot && parseFindingsTotal(body) === 0;
}

// ── ESCALATE reason → directive (§8) ─────────────────────────────────────────

export type EscalateReason =
  | "whack-a-mole"
  | "guard-accretion"
  | "oscillation"
  | "wrong-scope"
  | "re-flag-deferred"
  | "diff-too-large"
  | "round-cap"
  // Fix-round terminal failures (the loop cannot progress without a human): every way a
  // requested loop can stop maps to exactly one fixed reason — never to free text.
  | "fix-failed"
  | "fix-declined"
  | "loop-error";

const REASONS: readonly EscalateReason[] = [
  "whack-a-mole",
  "guard-accretion",
  "oscillation",
  "wrong-scope",
  "re-flag-deferred",
  "diff-too-large",
  "round-cap",
  "fix-failed",
  "fix-declined",
  "loop-error",
];

export function isEscalateReason(x: string): x is EscalateReason {
  return (REASONS as readonly string[]).includes(x);
}

/** Immutable literals — the directive handed to the fix agent per reason. */
export const ESCALATE_DIRECTIVE: Record<EscalateReason, string> = {
  "whack-a-mole":
    "Re-audit the whole flagged file plus its siblings and fix every instance of the finding's defect class in one commit, with a call-site census of every entry point the guard protects — the missed root cause is a sibling, not just the reported line.",
  "guard-accretion":
    "Stop adding another guard for the same race/class. Remove the bad state so the condition becomes unreachable (state root cause).",
  "oscillation":
    "Finding count is not decreasing and fixes spawn new findings. Stop patching individually — decide between fixing the root cause and changing the design.",
  "wrong-scope":
    "The fix is correct but repeatedly scoped wrong. Find the true root cause (e.g. the actual source of the O(N^2)) and fix it there.",
  "re-flag-deferred":
    "The bot is re-litigating a deferred / pushed-back finding. Judge it as a false positive or a design call: make the deferral load-bearing (issue# + code marker), or decide direction.",
  "diff-too-large":
    "Diff is too large / multi-domain to converge. Do not resume the loop — split into a dependency-ordered stack (design change).",
  "round-cap":
    "Fix-round budget exhausted and the verification review still has findings. Classify by finding-count trend and repeated files, then decide direction.",
  "fix-failed":
    "The fix agent could not produce an applicable fix within its retries (see Detail). Fix these findings manually, or resolve the cause and re-run the loop.",
  "fix-declined":
    "The fix agent changed nothing: it pushed back on, declined or deferred every finding (see Detail). Adjudicate each one — accept the push-back and resolve the thread, or fix it manually.",
  "loop-error":
    "The loop could not run a fix round on this PR (see Detail), e.g. apply on a fork, no editable changed files, a missing snapshot or unreadable loop history. Resolve the cause, then re-run the loop.",
};

// ── ESCALATE payload composer (§8) ───────────────────────────────────────────

export interface EscalateState {
  reason: EscalateReason;
  round: number;
  roundCap: number;
  pr: number;
  head: string;
  repo: string; // owner/repo, for the re-derive-from-API commands
  findingTrend?: number[]; // R1..RN counts, oldest first
  repeatedFiles?: string[]; // files re-flagged across 2–3 rounds
  reviewedCommitInHead?: boolean;
  unaddressed?: number;
  dirty?: boolean;
  ciState?: string;
  diffLines?: number;
  ledger?: { declines?: number; defers?: number; pushbacks?: number };
  /** Deterministic failure detail (outcome + error). Untrusted (error text may quote model
   * output): neutralized, flattened to one line and truncated before it is rendered. */
  detail?: string;
}

const DETAIL_MAX = 500;

function renderDetail(detail: string): string {
  return sanitizeUntrusted(detail, { oneLine: true, max: DETAIL_MAX });
}

/** Escape HTML-comment delimiters so interpolated untrusted text (model output, file paths, CI
 * text, error messages) cannot forge a control marker inside ANY bot-authored comment (design
 * §3). Every emitter that embeds untrusted text in a bot comment must pass it through this. */
export function neutralizeMarkers(s: string): string {
  return String(s ?? "").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

/**
 * THE sanitizer for untrusted text inside ANY bot-authored comment (model output, file paths,
 * error / CI text): control markers neutralized, @-mentions defanged (a bot comment must never
 * ping a user or team from untrusted text), optionally flattened to one line and bounded. One
 * function for every emitter, so no field can be sanitized "partially".
 */
export function sanitizeUntrusted(text: string | null | undefined, opts: { oneLine?: boolean; max?: number } = {}): string {
  let t = neutralizeMarkers(String(text ?? "")).replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
  if (opts.oneLine) t = t.replace(/\s+/g, " ").trim();
  const max = opts.max ?? 4000;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** WHY a marker: structured fields live as attributes so detection never parses prose. */
export function escalateMarker(s: Pick<EscalateState, "reason" | "round" | "pr" | "head">): string {
  return `<!-- ashlar-loop-escalate reason=${s.reason} round=${s.round} pr=${s.pr} head=${s.head} -->`;
}

function fmtTrend(trend: number[] | undefined): string {
  if (!trend || trend.length === 0) return "(unknown)";
  const arrow = trend.length < 2 ? "" : trend[trend.length - 1] > trend[0] ? " (increasing)" : trend[trend.length - 1] < trend[0] ? " (decreasing)" : " (flat)";
  return trend.map((n, i) => `R${i + 1}=${n}`).join(" ") + arrow;
}

function fmtBool(label: string, v: boolean | undefined): string {
  if (v === undefined) return `${label}=unknown`;
  return `${label}=${v ? "yes" : "no"}`;
}

/**
 * The full ESCALATE handoff comment. Fixed marker + immutable human sentence +
 * a state snapshot + the reason's directive + re-derive-from-API commands.
 * Everything here is deterministic; the receiving agent must NOT trust this
 * narrative and MUST re-derive round/findings/gates from the API (§8 caveat).
 */
export function escalateComment(s: EscalateState): string {
  const ledger = s.ledger
    ? `decline=${s.ledger.declines ?? 0} defer=${s.ledger.defers ?? 0} pushback=${s.ledger.pushbacks ?? 0}`
    : "(none)";
  const lines = [
    escalateMarker(s),
    "",
    `${REVIEW_LOOP_ESCALATE_HUMAN} (review round ${s.round}; fix-round budget ${s.roundCap})`,
    "",
    "State (re-verify below — do not trust this narrative):",
    `- Finding trend: ${fmtTrend(s.findingTrend)}`,
    `- Repeated flagged files: ${s.repeatedFiles && s.repeatedFiles.length ? sanitizeUntrusted(s.repeatedFiles.join(", "), { oneLine: true, max: 600 }) : "(none)"}`,
    `- ${fmtBool("Reviewed-commit ⊂ HEAD", s.reviewedCommitInHead)}; unaddressed=${s.unaddressed ?? "unknown"}; ${fmtBool("DIRTY", s.dirty)}; CI=${sanitizeUntrusted(s.ciState ?? "unknown", { oneLine: true, max: 200 })}`,
    `- Diff size: ${s.diffLines ?? "unknown"} lines; decision ledger: ${ledger}`,
    "",
    `Stop reason: ${s.reason}`,
    ...(s.detail ? [`Detail: ${renderDetail(s.detail)}`] : []),
    `Directive: ${ESCALATE_DIRECTIVE[s.reason]}`,
    "",
    "Re-derive from the API before acting (narrative may be stale after compaction):",
    "```",
    `gh pr view ${s.pr} --repo ${sanitizeUntrusted(s.repo, { oneLine: true, max: 200 })} --json reviews,comments,headRefOid,mergeable`,
    `audit-unaddressed.py ${s.pr} --head ${s.head}`,
    "```",
  ];
  return lines.join("\n");
}

/** STOPPED handoff — operator-requested stop. Fixed marker + immutable sentence. */
/** The STOPPED acknowledgement. It keeps the fixed STOPPED marker as its FIRST line (external
 * detectors match that literal) and, on a second line, records the stop itself — who stopped the
 * loop and WHEN (the stop's own event time, not this comment's) — so the stop is durable and
 * placed correctly even when it arrived as an edit that the session fold cannot replay. */
export function stoppedComment(stop?: LoopStop): string {
  if (!stop) return `${STOPPED_MARKER}\n\n${REVIEW_LOOP_STOPPED_HUMAN}`;
  return `${STOPPED_MARKER}\n${stopRecordLine(stop)}\n\n${REVIEW_LOOP_STOPPED_HUMAN} (stop by ${stop.by}).`;
}

/** The record of a stop that ended only a session BEFORE the active one — posted while a newer
 * session runs (a record that was refused until then, or a stop racing a start in flight). The
 * record line alone opens it: the fold places it exactly as the STOPPED acknowledgement's record
 * (parseStopRecord), but it carries no STOPPED marker, which every watcher reads as "the loop
 * stopped" while the newer session keeps running. */
export function stopRecordComment(stop: LoopStop): string {
  return `${stopRecordLine(stop)}\n\n${REVIEW_LOOP_STOP_RECORD_HUMAN} (stop by ${stop.by} at ${stop.at}).`;
}

function stopRecordLine(stop: LoopStop): string {
  if (!LOGIN_RE.test(stop.by) || !ISO_UTC_RE.test(stop.at) || Number.isNaN(Date.parse(stop.at))) {
    throw new Error(`invalid loop stop (by=${stop.by} at=${stop.at})`);
  }
  return `<!-- ashlar-loop-stop at=${stop.at} by=${stop.by} -->`;
}

export interface LoopStop {
  by: string; // the human who stopped the loop
  at: string; // the stop's own event time (ISO-8601 UTC)
}

// The record line, opening the comment — alone, or right after the STOPPED marker.
const STOP_RECORD_RE =
  /^\s*(?:<!--\s*ashlar-loop-stopped\s*-->[ \t]*\r?\n[ \t]*)?<!--\s*ashlar-loop-stop\s+at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\s+by=([A-Za-z0-9-]{1,39})\s*-->/;

/** The stop recorded in a STOPPED acknowledgement, or in a bare stop record (stopRecordComment), the
 * caller has proven the App authored (anchored: the record line opens the comment, or is the very
 * next line after the STOPPED marker that does). Null otherwise — including a bare legacy
 * acknowledgement without a record. */
export function parseStopRecord(body: string | null | undefined, source: CommentSource): LoopStop | null {
  if (!source.authoredByBot) return null;
  const m = STOP_RECORD_RE.exec(body || "");
  if (!m || !LOGIN_RE.test(m[2]) || Number.isNaN(Date.parse(m[1]))) return null;
  return { at: m[1], by: m[2] };
}

// ── Self identity + loop continuation (§2 invariant: the bot never commands itself) ──
// WHY: the bot's own comments (inline findings, fix reports, ops updates, replies) routinely
// QUOTE trigger phrases such as `/review-loop apply`. Parsed as commands they made the bot
// re-trigger itself (duplicate reviews; in apply mode, parallel fix rounds on one PR).
// INVARIANT: a comment authored by this App is never a command. The ONE exception is the
// continuation comment the loop driver posts on purpose after an applied round, recognized
// only by the fixed machine marker below (never by prose), only when the App authored it.

/** The exact GitHub App bot login ("<app-slug>[bot]"). Substring matching is unsafe: an
 * account like "ashlar-fan" could forge findings, suppress an escalation or pose as the bot. */
export const DEFAULT_ASHLAR_BOT_LOGIN = "ashlar-bot-review-loop[bot]";

/** A configured login is honored only in the "<slug>[bot]" shape GitHub reserves for Apps, so
 * a misconfiguration can never make a HUMAN account's comments read as the bot's own (which
 * would both silence that human's commands and let them forge bot-only signals). */
export function resolveBotLogin(configured: string | null | undefined): string {
  const v = String(configured ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(v) ? v : DEFAULT_ASHLAR_BOT_LOGIN;
}

/** Exact (case-insensitive) login equality — GitHub logins are case-insensitive. */
export function isSelfLogin(login: string | null | undefined, botLogin: string = DEFAULT_ASHLAR_BOT_LOGIN): boolean {
  return !!login && login.toLowerCase() === botLogin.toLowerCase();
}

export const REVIEW_LOOP_CONTINUE_HUMAN = "Ashlar review-loop continues — requesting the next review";
export const REVIEW_LOOP_FIXING_HUMAN = "Ashlar review-loop — fix round in progress";
export const REVIEW_LOOP_START_HUMAN = "Ashlar review-loop start recorded";

// ── Recorded loop start (the durable start event) ───────────────────────────────
// WHY: human comment bodies and the PR body are MUTABLE — rebuilding a session from their
// current text at their creation time lets a later edit plant a backdated start. The start is
// therefore recorded once, by the App, when harbor accepts a FRESH start directive for a review
// it admits: the marker carries the requester and the directive's own event time (a comment's
// creation or edit time, a PR body's update time), and only this record starts a session.

export interface LoopStart {
  mode: ReviewLoopMode;
  by: string; // the human who issued the directive (the apply write-permission subject)
  at: string; // the directive's event time (ISO-8601 UTC)
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const START_MARKER_RE =
  /^\s*<!--\s*ashlar-loop-start\s+mode=(apply|suggest)\s+by=([A-Za-z0-9-]{1,39})\s+at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\s*-->/;

/** The App's start record. Throws on a malformed field: a record the parser would reject must
 * never be posted (the loop would silently not start). */
export function startComment(s: LoopStart): string {
  if ((s.mode !== "apply" && s.mode !== "suggest") || !LOGIN_RE.test(s.by) || !ISO_UTC_RE.test(s.at) || Number.isNaN(Date.parse(s.at))) {
    throw new Error(`invalid loop start (mode=${s.mode} by=${s.by} at=${s.at})`);
  }
  return `<!-- ashlar-loop-start mode=${s.mode} by=${s.by} at=${s.at} -->\n\n${REVIEW_LOOP_START_HUMAN} — mode ${s.mode}, requested by ${s.by}.`;
}

/** Parse the start record from a comment the caller has proven the App authored (anchored: the
 * record OPENS the comment). Null for any other author, or a missing / malformed record. */
export function parseStartMarker(body: string | null | undefined, source: CommentSource): LoopStart | null {
  if (!source.authoredByBot) return null;
  const m = START_MARKER_RE.exec(body || "");
  if (!m || !LOGIN_RE.test(m[2]) || Number.isNaN(Date.parse(m[3]))) return null;
  return { mode: m[1] as ReviewLoopMode, by: m[2], at: m[3] };
}

/** Progress signal (informational, NEVER a trigger or a terminal event): posted right before the
 * fix request so a driver can tell "the fix is queued/generating" from "the loop died" — the fix
 * can wait long behind a busy provider. It ends in the fix report + continuation, or a handoff. */
export function fixingComment(c: { round: number; pr: number; head: string }): string {
  return `<!-- ashlar-loop-fixing round=${c.round} pr=${c.pr} head=${c.head} -->\n\n${REVIEW_LOOP_FIXING_HUMAN} (round ${c.round} on \`${c.head.slice(0, 7)}\`).`;
}

const FIXING_MARKER_RE = /^\s*<!--\s*ashlar-loop-fixing\s+round=(\d{1,4})\s+pr=(\d{1,9})\s+head=([^\s>]+)\s*-->/;
// The round's own report (review-loop-runtime renderFixReport): a suggestion round ends with only
// this report — the session then waits for the human's push; it was not cut.
const FIX_REPORT_RE = /^\s*### Ashlar fix agent — /;

/** What the App's loop comments say about the session's progress (a bare stop RECORD of an older
 * session's stop says nothing about this one: the session fold decides whether it ended). */
export type LoopCommentKind = "start" | "fixing" | "report" | "continue" | "escalate" | "stopped";

/** The kind of a loop comment the caller has proven the App authored; null for any other comment. */
export function loopCommentKind(body: string | null | undefined): LoopCommentKind | null {
  const bot = { authoredByBot: true };
  if (FIXING_MARKER_RE.test(body || "")) return "fixing";
  if (FIX_REPORT_RE.test(body || "")) return "report";
  if (parseStartMarker(body, bot)) return "start";
  if (parseContinueMarker(body, bot)) return "continue";
  if (isEscalateComment(body, bot)) return "escalate";
  return isStoppedComment(body, bot) ? "stopped" : null;
}

/**
 * The App's NEWEST loop comment on a PR (by creation time, then comment id). "fixing" newest means a
 * fix round started and nothing followed it: the round is running — or a restart cut it and nothing
 * will (review-loop-runtime sweepCutFixRounds; scripts/loop-fixing.mjs lists these before a deploy).
 */
export function newestLoopComment<T extends { id?: number; userLogin: string; body: string; createdAt?: string }>(
  rows: readonly T[],
  botLogin: string = DEFAULT_ASHLAR_BOT_LOGIN,
): { kind: LoopCommentKind; row: T; round?: number; head?: string } | null {
  let best: { kind: LoopCommentKind; row: T } | null = null;
  const later = (a: T, b: T) => (isoMs(a.createdAt) || 0) - (isoMs(b.createdAt) || 0) || (a.id ?? 0) - (b.id ?? 0);
  for (const row of rows) {
    const kind = isSelfLogin(row.userLogin, botLogin) ? loopCommentKind(row.body) : null;
    if (kind && (!best || later(row, best.row) >= 0)) best = { kind, row };
  }
  const m = best?.kind === "fixing" ? FIXING_MARKER_RE.exec(best.row.body) : null;
  return best && m ? { ...best, round: Number(m[1]), head: m[3] } : best;
}

export interface LoopContinuation {
  mode: ReviewLoopMode;
  round: number; // the review round being requested (1-based, within the session)
  pr: number;
  head: string; // full 40-hex commit SHA the next review is for
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** ONE contract for the continuation's numeric fields, shared by the composer and the parser
 * (the parser's digit limits mirror these): anything the composer emits, the parser accepts. */
export const MAX_CONTINUE_ROUND = 9999;
export const MAX_CONTINUE_PR = 999_999_999;

/** Machine marker: structured fields as attributes, so recognition never parses prose. */
export function continueMarker(c: LoopContinuation): string {
  return `<!-- ashlar-loop-continue mode=${c.mode} round=${c.round} pr=${c.pr} head=${c.head} -->`;
}

/** The driver's continuation comment. Throws on a malformed field: a marker the parser would
 * reject must never be posted (the loop would stall silently waiting for a review). */
export function continueComment(c: LoopContinuation): string {
  if ((c.mode !== "apply" && c.mode !== "suggest") || !Number.isInteger(c.round) || c.round < 1 ||
    c.round > MAX_CONTINUE_ROUND || !Number.isInteger(c.pr) || c.pr < 1 || c.pr > MAX_CONTINUE_PR ||
    !FULL_SHA_RE.test(c.head)) {
    throw new Error(`invalid loop continuation (mode=${c.mode} round=${c.round} pr=${c.pr} head=${c.head})`);
  }
  return `${continueMarker(c)}\n\n${REVIEW_LOOP_CONTINUE_HUMAN} (round ${c.round} on \`${c.head.slice(0, 7)}\`).`;
}

// Anchored: the marker must OPEN the comment (where the driver emits it) — a marker quoted
// later in a bot comment, e.g. model text inside a fix report, is prose, never a signal.
const CONTINUE_MARKER_RE =
  /^\s*<!--\s*ashlar-loop-continue\s+mode=(apply|suggest)\s+round=(\d{1,4})\s+pr=(\d{1,9})\s+head=([0-9a-f]{40})\s*-->/;

/** Parse the continuation marker from a comment the caller has proven the App authored.
 * Returns null for any other author, or a missing / malformed marker. */
export function parseContinueMarker(body: string | null | undefined, source: CommentSource): LoopContinuation | null {
  if (!source.authoredByBot) return null;
  const m = CONTINUE_MARKER_RE.exec(body || "");
  if (!m) return null;
  const round = Number(m[2]);
  const pr = Number(m[3]);
  if (round < 1 || round > MAX_CONTINUE_ROUND || pr < 1 || pr > MAX_CONTINUE_PR) return null;
  return { mode: m[1] as ReviewLoopMode, round, pr, head: m[4] };
}

/**
 * The ONLY bot-authored comment that may act as a trigger: byte-for-byte the driver's canonical
 * continuation (continueComment of its own parsed fields; trailing whitespace tolerated). Any
 * other text around or after the marker — a fix report quoting model output, say — disqualifies
 * it, so an embedded marker can never promote a report into a loop start.
 */
export function canonicalContinuation(body: string | null | undefined, source: CommentSource): LoopContinuation | null {
  const parsed = parseContinueMarker(body, source);
  if (!parsed) return null;
  let canonical: string;
  try {
    canonical = continueComment(parsed);
  } catch {
    return null;
  }
  return String(body ?? "").replace(/\s+$/, "") === canonical ? parsed : null;
}

// ── Control-marker detectors ─────────────────────────────────────────────────
// ashlar's own trust decisions (idempotency, the durable session, the continuation) accept a
// control marker ONLY where the driver emits it: OPENING a dedicated control comment. A marker
// that appears later in a bot comment is prose — e.g. model text quoted in a fix report — and is
// never a signal, even if an emitter forgot to neutralize it (defense in depth; every emitter
// also neutralizes untrusted text). External substring detectors stay compatible: the driver's
// real markers are always at the start.

const ESCALATE_MARKER_RE = /^\s*<!--\s*ashlar-loop-escalate\s+([^>]*?)-->/;
const STOPPED_MARKER_RE = /^\s*<!--\s*ashlar-loop-stopped\s*-->/;

export function isEscalateComment(body: string | null | undefined, source: CommentSource): boolean {
  return source.authoredByBot && ESCALATE_MARKER_RE.test(body || "");
}

export function isStoppedComment(body: string | null | undefined, source: CommentSource): boolean {
  return source.authoredByBot && STOPPED_MARKER_RE.test(body || "");
}

export interface ParsedEscalate {
  reason: EscalateReason;
  round: number;
  pr: number;
  head: string;
}

/**
 * Parse the machine marker's attributes from a bot-authored comment. Returns null
 * when the source is untrusted, the marker is absent/malformed, or `reason` is not a
 * known EscalateReason (an unknown reason would index ESCALATE_DIRECTIVE as undefined).
 */
export function parseEscalateMarker(body: string | null | undefined, source: CommentSource): ParsedEscalate | null {
  if (!source.authoredByBot) return null;
  const m = ESCALATE_MARKER_RE.exec(body || "");
  if (!m) return null;
  const attrs = m[1];
  const get = (k: string): string | undefined => {
    const mm = new RegExp(`\\b${k}=([^\\s]+)`).exec(attrs);
    return mm ? mm[1] : undefined;
  };
  const reason = get("reason");
  const round = Number(get("round"));
  const pr = Number(get("pr"));
  const head = get("head");
  if (!reason || !isEscalateReason(reason) || !head || Number.isNaN(round) || Number.isNaN(pr)) return null;
  return { reason, round, pr, head };
}

// ── Trigger parsing (§2) ─────────────────────────────────────────────────────
// WHY separate from the plain `/review` parser: `/review-loop` contains the
// substring `/review`, so the ingress MUST test for a loop directive BEFORE the
// plain-review match, or word-boundary the review match. Callers: check this first.

export type ReviewLoopMode = "suggest" | "apply";

export type ReviewLoopDirective =
  | { kind: "start"; mode: ReviewLoopMode }
  | { kind: "stop" };

// The token is bounded by a Unicode-aware negative lookahead (rejects glued suffixes
// like `/review-loopx`, `/review-loop-stop`, and non-ASCII `/review-loop한글`). The option
// capture is the WHOLE next token `[\p{L}\p{N}\p{M}_-]+` (letters, numbers, combining marks,
// `applyé`) is captured in full and fails the exact `apply`/`stop` comparison instead of
// being truncated. `u` makes \p{…} legal and ASCII \w-only classes Unicode-correct; `g`
// so a leading invalid occurrence ("don't /review-loop yet") cannot mask a later valid one.
const LOOP_RE = /(?:^|\s)(?:\/review-loop|@ashlar(?:-bot)?\s+review-loop)(?![\p{L}\p{N}\p{M}_-])(?:[ \t]+([\p{L}\p{N}\p{M}_-]+))?/giu;

/**
 * Recognize `/review-loop`, `/review-loop apply`, `/review-loop stop`, and the
 * `@ashlar-bot review-loop …` variants. Scans every occurrence and returns the first
 * syntactically valid directive; an occurrence followed by an unrecognized word (or a
 * glued suffix) is skipped, not accepted as a bare start. Returns null when the body
 * carries no valid directive, leaving plain `/review` to the existing parser. Default
 * mode is `suggest` (auto-commit only on explicit `apply`) per §2.
 */
export function parseReviewLoopDirective(body: string | null | undefined): ReviewLoopDirective | null {
  if (!body) return null;
  LOOP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOOP_RE.exec(body)) !== null) {
    const opt = (m[1] || "").toLowerCase();
    if (opt === "") return { kind: "start", mode: "suggest" };
    if (opt === "apply") return { kind: "start", mode: "apply" };
    if (opt === "stop") return { kind: "stop" };
    // An unrecognized word follows this occurrence: ambiguous intent — keep scanning
    // for a later valid directive rather than accepting or rejecting outright.
  }
  return null;
}

/**
 * Remove every `/review-loop…` / `@ashlar-bot review-loop…` directive span from a body,
 * so a caller can test whether an INDEPENDENT bot mention remains (design: a mention that
 * is part of the loop directive itself, e.g. `@ashlar-bot review-loop stop`, is not a
 * separate review request). Replaces each match with a space to preserve token spacing.
 */
export function stripLoopDirectives(body: string | null | undefined): string {
  if (!body) return "";
  LOOP_RE.lastIndex = 0;
  return body.replace(LOOP_RE, " ");
}

/**
 * The loop directive to attach for a webhook, or undefined. On `created`/`opened` it is
 * the parsed directive; on `edited` it is fresh only when newly added OR changed vs the
 * previous body — an unchanged directive left in place during an unrelated prose edit must
 * not re-trigger the loop or supersede running work. When the previous body is unavailable
 * (the edit did not touch the body) the directive is treated as retained (undefined).
 */
export function freshLoopDirective(
  action: string | undefined,
  currentBody: string | null | undefined,
  previousBody: string | null | undefined,
): ReviewLoopDirective | undefined {
  const cur = parseReviewLoopDirective(currentBody);
  if (cur == null) return undefined;
  // New content: a directive in a newly created comment / opened PR is fresh.
  if (action === "created" || action === "opened") return cur;
  // Edit: fresh only when newly added or changed vs the previous body.
  if (action === "edited") {
    if (typeof previousBody !== "string" && previousBody !== null) return undefined;
    const prev = parseReviewLoopDirective(previousBody ?? "");
    return sameDirective(prev, cur) ? undefined : cur;
  }
  // synchronize / reopened / ready_for_review / anything else: a directive RETAINED in an
  // unchanged body is not a fresh request — mirrors the mention path, so a one-shot
  // /review-loop does not degrade into auto-review on every push.
  return undefined;
}

/** True when two parsed directives are the same command (kind + start mode). */
export function sameDirective(a: ReviewLoopDirective | null, b: ReviewLoopDirective | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "start" && b.kind === "start") return a.mode === b.mode;
  return true;
}

// ── Stuck classification (§8) — pure; drives the ESCALATE emission in-repo ────
// WHY here: reuses escalateComment above so the fixed literals + directives have ONE
// source (design §3 no-drift). ashlar reconstructs rounds from the API and emits; the
// external driver only DETECTS the marker. See review-loop-engine.server.ts.

export interface RoundSummary {
  index: number; // 1-based round number
  findings: number; // total findings that round
  files: string[]; // files flagged that round
  head: string; // reviewed commit (short sha)
}

const DIFF_TOO_LARGE_LINES = 5000;
const WHACK_WINDOW = 3; // inspect the last N rounds for a recurring file
const WHACK_MIN_REPEAT = 2; // a file flagged in >= this many of the window => whack-a-mole

/**
 * Classify why a loop is stuck, or null when it is converged / still making progress.
 *
 * CONTRACT (single source of the stuck-definition — do not patch case-by-case):
 * - A ROUND is one reviewed head; review round k may be followed by fix round k.
 * - `roundCap` is the FIX-ROUND BUDGET (design: at most N review→fix rounds, default 5). Review
 *   round N+1 is the verification review of the N-th fix: clean → CONVERGED, else round-cap.
 * - Converged: last round has 0 findings → null.
 * - diff-too-large (structural, never converges) first.
 * - Budget: rounds > roundCap → round-cap, AUTHORITATIVE and REGARDLESS of trend (a hard bound —
 *   the loop ends in one fixed terminal reason; the trend pattern goes into the detail).
 * - Within the budget, patterns need >=3 rounds and a window that is NOT strictly decreasing (a
 *   strictly decreasing window is healthy progress, even with a recurring file): whack-a-mole
 *   (a file recurs in the window) > oscillation (all non-zero). See stuckPattern.
 * The semantic reasons (guard-accretion, wrong-scope, re-flag-deferred) need diff/semantic
 * context the finding trend cannot supply and are left to the human.
 */
export function classifyStuck(
  rounds: RoundSummary[],
  opts: { roundCap: number; diffLines?: number },
): EscalateReason | null {
  if (rounds.length === 0) return null;
  if (rounds[rounds.length - 1].findings === 0) return null; // converged (CONVERGED, not stuck)
  if (opts.diffLines !== undefined && opts.diffLines > DIFF_TOO_LARGE_LINES) return "diff-too-large";

  // round-cap FIRST: the fix-round budget is a hard, authoritative bound — review N+1 with
  // findings ends as round-cap whatever the trend, so a driver keys "budget spent" on ONE reason.
  // (The trend pattern, if any, is still reported in the handoff's detail — stuckPattern.)
  if (rounds.length > opts.roundCap) return "round-cap";
  return stuckPattern(rounds);
}

/**
 * The stuck PATTERN of a non-converged history, independent of the budget (null when still
 * improving / too short). A loop whose recent findings are STRICTLY decreasing is still
 * converging — a recurring file there is healthy progress, not stuck.
 */
export function stuckPattern(rounds: RoundSummary[]): "whack-a-mole" | "oscillation" | null {
  if (rounds.length < 3) return null;
  const window = rounds.slice(-WHACK_WINDOW);
  const strictlyImproving = window.every((r, i) => i === 0 || r.findings < window[i - 1].findings);
  if (strictlyImproving) return null;
  // whack-a-mole: a file recurs across the window while the trend stalls or rebounds.
  const counts = new Map<string, number>();
  for (const r of window) for (const f of r.files) counts.set(f, (counts.get(f) ?? 0) + 1);
  for (const v of counts.values()) if (v >= WHACK_MIN_REPEAT) return "whack-a-mole";
  // oscillation: plateau or rebound with every round non-zero (same strict test, so [5,4,4] and
  // [5,1,4] are caught while [5,4,3] stays improving).
  if (window.every((r) => r.findings > 0)) return "oscillation";
  return null;
}

export function repeatedRoundFiles(rounds: RoundSummary[], window = WHACK_WINDOW): string[] {
  const counts = new Map<string, number>();
  for (const r of rounds.slice(-window)) for (const f of r.files) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts.entries()].filter(([, v]) => v >= WHACK_MIN_REPEAT).map(([f]) => f).sort();
}

/** Compose the ESCALATE handoff from a stuck loop's reconstructed round history (reuses
 * escalateComment — the single source of the fixed literals + directives). */
export function escalateFromRounds(
  reason: EscalateReason,
  rounds: RoundSummary[],
  ctx: { pr: number; head: string; repo: string; roundCap: number; diffLines?: number; detail?: string },
): string {
  return escalateComment({
    detail: ctx.detail,
    reason,
    round: rounds.length ? rounds[rounds.length - 1].index : 0,
    roundCap: ctx.roundCap,
    pr: ctx.pr,
    head: ctx.head,
    repo: ctx.repo,
    findingTrend: rounds.map((r) => r.findings),
    repeatedFiles: repeatedRoundFiles(rounds),
    diffLines: ctx.diffLines,
  });
}
