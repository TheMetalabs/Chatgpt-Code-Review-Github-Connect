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

export const STOPPED_MARKER = "<!-- ashlar-loop-stopped -->";

/** total=0 on the findings marker is the machine side of CONVERGED (§3). */
const ZERO_FINDINGS_RE = /<!--\s*ashlar-findings\s+total=0\b/;

export function isZeroFindings(body: string | null | undefined): boolean {
  return ZERO_FINDINGS_RE.test(body || "");
}

// ── ESCALATE reason → directive (§8) ─────────────────────────────────────────

export type EscalateReason =
  | "whack-a-mole"
  | "guard-accretion"
  | "oscillation"
  | "wrong-scope"
  | "re-flag-deferred"
  | "diff-too-large"
  | "round-cap";

const REASONS: readonly EscalateReason[] = [
  "whack-a-mole",
  "guard-accretion",
  "oscillation",
  "wrong-scope",
  "re-flag-deferred",
  "diff-too-large",
  "round-cap",
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
    "Round cap reached without a clear signal. Classify by finding-count trend and repeated files, then decide direction.",
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
    `${REVIEW_LOOP_ESCALATE_HUMAN} (round ${s.round}/${s.roundCap})`,
    "",
    "State (re-verify below — do not trust this narrative):",
    `- Finding trend: ${fmtTrend(s.findingTrend)}`,
    `- Repeated flagged files: ${s.repeatedFiles && s.repeatedFiles.length ? s.repeatedFiles.join(", ") : "(none)"}`,
    `- ${fmtBool("Reviewed-commit ⊂ HEAD", s.reviewedCommitInHead)}; unaddressed=${s.unaddressed ?? "unknown"}; ${fmtBool("DIRTY", s.dirty)}; CI=${s.ciState ?? "unknown"}`,
    `- Diff size: ${s.diffLines ?? "unknown"} lines; decision ledger: ${ledger}`,
    "",
    `Stop reason: ${s.reason}`,
    `Directive: ${ESCALATE_DIRECTIVE[s.reason]}`,
    "",
    "Re-derive from the API before acting (narrative may be stale after compaction):",
    "```",
    `gh pr view ${s.pr} --repo ${s.repo} --json reviews,comments,headRefOid,mergeable`,
    `audit-unaddressed.py ${s.pr} --head ${s.head}`,
    "```",
  ];
  return lines.join("\n");
}

/** STOPPED handoff — operator-requested stop. Fixed marker + immutable sentence. */
export function stoppedComment(): string {
  return `${STOPPED_MARKER}\n\n${REVIEW_LOOP_STOPPED_HUMAN}`;
}

// ── Substring detectors (the driver / poller mirror these) ───────────────────

const ESCALATE_MARKER_RE = /<!--\s*ashlar-loop-escalate\s+([^>]*?)-->/;

export function isEscalateComment(body: string | null | undefined): boolean {
  return ESCALATE_MARKER_RE.test(body || "");
}

export function isStoppedComment(body: string | null | undefined): boolean {
  return (body || "").includes(STOPPED_MARKER);
}

export interface ParsedEscalate {
  reason: string;
  round: number;
  pr: number;
  head: string;
}

/** Parse the machine marker's attributes. Returns null when absent/malformed. */
export function parseEscalateMarker(body: string | null | undefined): ParsedEscalate | null {
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
  if (!reason || !head || Number.isNaN(round) || Number.isNaN(pr)) return null;
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

const LOOP_RE = /(?:^|\s)(?:\/review-loop|@ashlar(?:-bot)?\s+review-loop)(?:\s+(apply|stop))?\b/i;

/**
 * Recognize `/review-loop`, `/review-loop apply`, `/review-loop stop`, and the
 * `@ashlar-bot review-loop …` variants. Returns null when the body is not a
 * loop directive (leaving plain `/review` to the existing parser). Default mode
 * is `suggest` (auto-commit only on explicit `apply`) per §2.
 */
export function parseReviewLoopDirective(body: string | null | undefined): ReviewLoopDirective | null {
  const m = LOOP_RE.exec(body || "");
  if (!m) return null;
  const opt = (m[1] || "").toLowerCase();
  if (opt === "stop") return { kind: "stop" };
  return { kind: "start", mode: opt === "apply" ? "apply" : "suggest" };
}
