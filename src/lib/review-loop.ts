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
  return source.authoredByBot && ZERO_FINDINGS_RE.test(body || "");
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

export function isEscalateComment(body: string | null | undefined, source: CommentSource): boolean {
  return source.authoredByBot && ESCALATE_MARKER_RE.test(body || "");
}

export function isStoppedComment(body: string | null | undefined, source: CommentSource): boolean {
  return source.authoredByBot && (body || "").includes(STOPPED_MARKER);
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
// capture is the WHOLE next token `[\p{L}\p{N}_-]+`, so a suffixed option (`apply-later`,
// `applyé`) is captured in full and fails the exact `apply`/`stop` comparison instead of
// being truncated. `u` makes \p{…} legal and ASCII \w-only classes Unicode-correct; `g`
// so a leading invalid occurrence ("don't /review-loop yet") cannot mask a later valid one.
const LOOP_RE = /(?:^|\s)(?:\/review-loop|@ashlar(?:-bot)?\s+review-loop)(?![\p{L}\p{N}_-])(?:[ \t]+([\p{L}\p{N}_-]+))?/giu;

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
