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

/** Escape HTML-comment delimiters so interpolated untrusted text (model output, file paths, CI
 * text, error messages) cannot forge a control marker inside ANY bot-authored comment (design
 * §3). Every emitter that embeds untrusted text in a bot comment must pass it through this. */
export function neutralizeMarkers(s: string): string {
  return String(s ?? "").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
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
    `- Repeated flagged files: ${s.repeatedFiles && s.repeatedFiles.length ? neutralizeMarkers(s.repeatedFiles.join(", ")) : "(none)"}`,
    `- ${fmtBool("Reviewed-commit ⊂ HEAD", s.reviewedCommitInHead)}; unaddressed=${s.unaddressed ?? "unknown"}; ${fmtBool("DIRTY", s.dirty)}; CI=${neutralizeMarkers(s.ciState ?? "unknown")}`,
    `- Diff size: ${s.diffLines ?? "unknown"} lines; decision ledger: ${ledger}`,
    "",
    `Stop reason: ${s.reason}`,
    `Directive: ${ESCALATE_DIRECTIVE[s.reason]}`,
    "",
    "Re-derive from the API before acting (narrative may be stale after compaction):",
    "```",
    `gh pr view ${s.pr} --repo ${neutralizeMarkers(s.repo)} --json reviews,comments,headRefOid,mergeable`,
    `audit-unaddressed.py ${s.pr} --head ${s.head}`,
    "```",
  ];
  return lines.join("\n");
}

/** STOPPED handoff — operator-requested stop. Fixed marker + immutable sentence. */
export function stoppedComment(): string {
  return `${STOPPED_MARKER}\n\n${REVIEW_LOOP_STOPPED_HUMAN}`;
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
 * - Converged: last round has 0 findings → null.
 * - Still improving: the recent window is STRICTLY decreasing → null, even at the cap or with
 *   a recurring file (that is healthy progress, not stuck).
 * - Otherwise, in precedence order: diff-too-large (structural, never converges) >
 *   whack-a-mole (>=3 rounds, a file recurs in the window, trend not strictly improving) >
 *   oscillation (>=3 rounds, window not trending down, all non-zero) > round-cap (cap hit,
 *   trend not strictly improving).
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

  const window = rounds.slice(-WHACK_WINDOW);
  // A loop whose recent findings are STRICTLY decreasing is still converging — never escalate
  // it (a recurring file or hitting the cap while improving is healthy progress, not stuck).
  const strictlyImproving =
    window.length >= 2 && window.every((r, i) => i === 0 || r.findings < window[i - 1].findings);

  // whack-a-mole: enough history (>=3 rounds), a file recurs across the window, and the trend
  // is NOT still improving (stalled or rebounding on the same file).
  if (rounds.length >= 3 && !strictlyImproving) {
    const counts = new Map<string, number>();
    for (const r of window) for (const f of r.files) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (const v of counts.values()) if (v >= WHACK_MIN_REPEAT) return "whack-a-mole";
  }

  // oscillation: >=3 rounds, the window is NOT strictly improving (plateau or rebound), all
  // non-zero. Uses the same strict-improvement test as the guard above (not just endpoints), so
  // [5,4,4] and [5,1,4] are caught, while [5,4,3] stays improving → null.
  if (rounds.length >= 3 && !strictlyImproving && window.every((r) => r.findings > 0)) {
    return "oscillation";
  }

  // round-cap: reached the cap AND not still improving (a converging loop keeps running).
  if (rounds.length >= opts.roundCap && !strictlyImproving) return "round-cap";
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
  ctx: { pr: number; head: string; repo: string; roundCap: number; diffLines?: number },
): string {
  return escalateComment({
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
