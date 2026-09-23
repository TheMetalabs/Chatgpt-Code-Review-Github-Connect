/**
 * Review-loop runtime: the post-review step that makes the loop real (design §5 steps 4–8).
 *
 * Each call is ONE loop step for one posted review: either ESCALATE (stuck / budget spent) or
 * run one fix round and report it in-thread. The loop is PR STATE, derived from durable GitHub
 * history (review-loop-session.ts): a session starts at the first human start after the last
 * terminal signal and survives restarts and re-issued starts. The loop REPEATS because every
 * new head in an active session gets a review — an applied round posts the fixed continuation
 * marker itself (review-loop.ts continueComment); a human push gets one from
 * continueLoopOnPush. A human stop directive ends the session (stopLoop acknowledges it with the
 * fixed STOPPED marker).
 *
 * TERMINATION CONTRACT (design §3/§5/§8): every loop step past the gates ends in a FIXED,
 * deterministic outcome — never a silent pause or free text:
 *   - CONVERGED: a clean review (total=0) — the gate below, nothing to fix;
 *   - ESCALATE (reason code): stuck, budget spent, or a fix round that cannot land
 *     (fix-failed / fix-declined / loop-error);
 *   - apply: the fixed "applied" report + continuation marker (the next review follows);
 *   - suggest: the fixed "suggestion" report — the designed hand-off (a human applies it and
 *     pushes; the push continues the session).
 *   - STOPPED: the operator's stop (acknowledged once by stopLoop; in-flight steps go quiet).
 * The fix-round budget (ASHLAR_LOOP_ROUND_CAP, default 5) is enforced at the next review: review
 * round N+1 verifies the N-th fix (clean → CONVERGED, else round-cap). The ONLY quiet exits are
 * supersession (a newer head drives the loop — its review is requested once, idempotently), an
 * operator stop, a newer loop request (a new session, or apply downgraded to suggest), and an
 * existing handoff on this head. One relevance check guards every checkpoint of a round, and a
 * round that went moot is never retried. Apply also requires the session starter's write
 * permission (design §2).
 * Everything is gated OFF by default:
 *   - env ASHLAR_FIX_AGENT=1 AND settings.fixAgent.provider != null (design §6b), AND
 *   - the PR has an ACTIVE loop session (durable: a human start after the last terminal), AND
 *   - github origin, same-repo (not a fork — the installation token cannot push to a fork),
 *     with findings on HEAD.
 *
 * Static imports are pure/DI-only modules; the production GitHub + provider transport are
 * loaded by DYNAMIC import inside the gate, so the harbor test fixture (which links a strict
 * github.server stub) is untouched and the fix path never runs in tests unless injected.
 */
import { buildFixPrompt, runFixRound, type FixRoundResult, type FixValidate, type RequestFix } from "./fix-agent.ts";
import type { GitDataApi } from "./fix-commit.ts";
import { isSafeFixPath, type FixFile } from "./fix-apply.ts";
import { watchFixRequest } from "./fix-request-watch.ts";
import { localLivenessMs } from "./local-leg-activity.ts";
import {
  CURRENT_ROUND_MISSING,
  ESCALATE_IN_FLIGHT,
  escalateNow,
  maybeEscalate,
  readLoopSession,
  reconstructRounds,
  type LoopPrInfo,
  type ReviewLoopGithub,
} from "./review-loop-engine.server.ts";
import {
  canonicalContinuation,
  continueComment,
  fixingComment,
  isoMs,
  isSelfLogin,
  MAX_CONTINUE_ROUND,
  resolveBotLogin,
  sanitizeUntrusted,
  stoppedComment,
  type EscalateReason,
  type ReviewLoopMode,
  type RoundSummary,
} from "./review-loop.ts";
import type { LoopSession } from "./review-loop-session.ts";
import type { BotSettings, Finding, Job, SamplePr } from "./types.ts";

export interface PullHead extends LoopPrInfo {
  ref: string;
  sha: string;
  fork: boolean;
  /** POSITIVE provenance: the head repository IS this repository (apply may write only then). */
  sameRepo?: boolean;
  /** PR size for the diff-too-large gate (additions + deletions); absent → gate skipped. */
  additions?: number;
  deletions?: number;
}

export interface LoopRuntimeGithub extends ReviewLoopGithub {
  fetchPullHeadRef(token: string, owner: string, repo: string, pr: number): Promise<PullHead>;
  gitDataApi(token: string, owner: string, repo: string): GitDataApi;
  /** Repository permission of a user (admin | write | read | none). Throws on lookup failure. */
  fetchUserPermission(token: string, owner: string, repo: string, login: string): Promise<string>;
}

export interface LoopRuntimeDeps {
  gh: LoopRuntimeGithub;
  requestFix: RequestFix;
  validate: FixValidate;
  /** Generation-deadline override (tests); production reads ASHLAR_FIX_TIMEOUT_MS. */
  fixTimeoutMs?: number;
  /** The provider reports queued/generating activity (streaming local LLM): the deadline then
   * excludes queue time. Absent/false → timed from send. */
  fixReportsActivity?: boolean;
  /** Watcher overrides (tests). */
  fixWatch?: { queueMaxMs?: number; livenessMs?: number; checkEveryMs?: number; tickMs?: number };
  /** Delay before the single loop-history re-read (injected so tests do not wait). */
  sleep?: (ms: number) => Promise<void>;
}

export type LoopStepResult =
  | { ran: false; reason: string }
  | { ran: true; step: "escalated"; reason: string; detail?: string }
  | { ran: true; step: "fix"; outcome: string; commitSha?: string; error?: string; continued?: boolean; attempts?: number };

const SUPERSEDED = "superseded (head moved)";
const ALREADY_ESCALATED = "already escalated on this head";
const STEP_IN_FLIGHT = "another loop step is in flight for this head";
const NO_SESSION = "no active loop session";
const STOPPED_QUIET = "loop stopped by operator";
const NEWER_REQUEST = "superseded by a newer loop request (a new session, or apply downgraded to suggest)";
const OWN_PUSH = "own push (the fix round continues the loop)";
/** NOT silent (logged): a concurrent handoff for this head outlived one backoff. */
const HANDOFF_IN_FLIGHT = "a handoff for this head is still being posted by another loop step; this step did not run";

/** Benign non-run reasons: the default off-path and the designed quiet exits (a newer head
 * drives the loop / a handoff or the operator already ended it). Anything else is logged. */
export const SILENT_REASONS: readonly string[] = [
  "disabled",
  "not a github job",
  "no findings (converged)",
  SUPERSEDED,
  ALREADY_ESCALATED,
  STEP_IN_FLIGHT,
  NO_SESSION,
  STOPPED_QUIET,
  NEWER_REQUEST,
  OWN_PUSH,
];

/** Write-capable repository permissions (legacy field; `maintain` reports as `write`). */
const WRITE_PERMISSIONS = new Set(["admin", "write"]);

/** Fix-round budget (design: at most 5 review→fix rounds, then a human decides). */
const DEFAULT_ROUND_CAP = 5;
/** Attempts per fix round for retryable outcomes (the reply was unusable, not the finding). */
const DEFAULT_FIX_ATTEMPTS = 2;
const RETRYABLE = new Set<FixRoundResult["outcome"]>(["request-failed", "parse-failed", "scope-violation", "validation-failed"]);
/** Re-reads for a history that does not show this review yet (a lagging list API), with backoff,
 * before the history counts as unverifiable (a loop-error handoff). */
const HISTORY_RETRY_DELAYS_MS = [3_000, 6_000, 12_000];
const ESCALATE_BACKOFF_MS = 1500;
const realSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// One loop step per PR head at a time (in-process): a second posted review of the same head
// (re-request, redelivery) must not run a parallel fix round. Different heads never block each
// other — the older one is superseded at its head checks. Cross-process coordination is a
// NON-GOAL (single harbor instance; see the engine header).
const inFlightSteps = new Set<string>();

function envOf(): NodeJS.ProcessEnv | undefined {
  return typeof process !== "undefined" ? process.env : undefined;
}

/** Off unless the operator explicitly enabled the env flag AND configured a fix provider. */
export function loopEnabled(settings: BotSettings, env: NodeJS.ProcessEnv | undefined = envOf()): boolean {
  if (env?.ASHLAR_FIX_AGENT !== "1") return false;
  return settings.fixAgent?.provider != null;
}

/** The App's own login (for self-recognition): ASHLAR_BOT_LOGIN when it has the "<slug>[bot]"
 * shape GitHub reserves for Apps, else the default. Shared by the webhook parser's self-trigger
 * guard and the engine's round attribution, so the two can never disagree. */
export function ashlarBotLogin(env: NodeJS.ProcessEnv | undefined = envOf()): string {
  return resolveBotLogin(env?.ASHLAR_BOT_LOGIN);
}

/** ASHLAR_LOOP_ROUND_CAP, bounded inside the continuation marker's contract: review N+1 is
 * requested after the N-th fix, so the largest requested round is cap + 1 ≤ MAX_CONTINUE_ROUND. */
function roundCap(env: NodeJS.ProcessEnv | undefined = envOf()): number {
  const n = Number(env?.ASHLAR_LOOP_ROUND_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_CONTINUE_ROUND - 1) : DEFAULT_ROUND_CAP;
}

/** Generation deadline per fix request, counted from the provider's FIRST output (queue time
 * excluded — the local LLM serializes reviews and fixes): ASHLAR_FIX_TIMEOUT_MS, clamped to
 * [1 min, 6 h], default 60 min. Past it the provider call is aborted: request-failed → retry → a
 * fixed fix-failed handoff, never a silent wait. */
const DEFAULT_FIX_TIMEOUT_MS = 60 * 60_000;
function fixTimeoutMs(env: NodeJS.ProcessEnv | undefined = envOf()): number {
  const n = Number(env?.ASHLAR_FIX_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(6 * 60 * 60_000, Math.max(60_000, Math.floor(n))) : DEFAULT_FIX_TIMEOUT_MS;
}

/** Backstop for the provider QUEUE (a request still queued past it is abandoned):
 * ASHLAR_FIX_QUEUE_MAX_MS, clamped to [10 min, 24 h], default 6 h. */
const DEFAULT_FIX_QUEUE_MAX_MS = 6 * 60 * 60_000;
function fixQueueMaxMs(env: NodeJS.ProcessEnv | undefined = envOf()): number {
  const n = Number(env?.ASHLAR_FIX_QUEUE_MAX_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(24 * 60 * 60_000, Math.max(10 * 60_000, Math.floor(n))) : DEFAULT_FIX_QUEUE_MAX_MS;
}

/** How often a queued fix request re-checks that it is still wanted (head / session). */
const FIX_RELEVANCE_CHECK_MS = 2 * 60_000;
const FIX_WATCH_TICK_MS = 5_000;

/** One server-side trace line per loop-step event, so a step is observable end to end. */
function trace(jobId: string, event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 200)}`)
    .join(" ");
  console.info(`[review-loop] ${jobId} ${event}${kv ? ` ${kv}` : ""}`);
}

function fixAttempts(env: NodeJS.ProcessEnv | undefined = envOf()): number {
  const n = Number(env?.ASHLAR_FIX_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 ? Math.min(5, Math.floor(n)) : DEFAULT_FIX_ATTEMPTS;
}

/** Feedback appended to the prompt for a retry: the deterministic rejection, one line. */
function retryFeedback(res: FixRoundResult): string {
  const why = String(res.error ?? res.outcome).replace(/\s+/g, " ").trim().slice(0, 500);
  return `PREVIOUS ATTEMPT REJECTED (${res.outcome}): ${why}\nReturn a corrected JSON object that satisfies every rule above.`;
}

function diffLinesOf(head: PullHead): number | undefined {
  return Number.isFinite(head.additions) && Number.isFinite(head.deletions)
    ? Number(head.additions) + Number(head.deletions)
    : undefined;
}

/** Effective mode: the SESSION's mode (the latest human start), with the operator's global
 * setting as a permission CEILING — auto-push happens only when the session says `apply` AND
 * the setting allows `apply`. `suggest` anywhere means no push. */
export function effectiveLoopMode(sessionMode: ReviewLoopMode | undefined, settings: BotSettings): ReviewLoopMode {
  return sessionMode === "apply" && settings.fixAgent.mode === "apply" ? "apply" : "suggest";
}

/** Deterministic, model-free rendering of the posted findings for the fix prompt. */
export function renderFindings(findings: readonly Finding[]): string {
  return findings
    .map(
      (f) =>
        `[${f.severity}] ${f.file}:${f.line} — ${f.title}\n  scenario: ${f.failureScenario}\n  root cause: ${f.rootCause}\n  fix: ${f.recommendedFix}`,
    )
    .join("\n\n");
}

const SYNTAX_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i).toLowerCase();
}

type TsModule = typeof import("typescript");
let tsModule: Promise<TsModule | null> | undefined;
/** typescript is a devDependency present in the dev deployment; if it is not loadable, apply is
 * refused for syntax-validated types rather than pushing unchecked source. */
function loadTypescript(): Promise<TsModule | null> {
  tsModule ??= import("typescript").then((m) => (m.default ?? m) as TsModule).catch(() => null);
  return tsModule;
}

/** Built-in deterministic pre-push gate for apply mode. Every candidate file type must have an
 * adequate validator: JSON must parse; TS/JS must have zero syntax diagnostics (TypeScript
 * parser); any other type has no deterministic validator here and REFUSES apply (suggest still
 * works). Non-empty content alone is never sufficient for an auto-push. */
export const builtinValidate: FixValidate = async (files: FixFile[]) => {
  for (const f of files) {
    if (!f.content.trim()) return { ok: false, error: `${f.path}: empty content` };
    const ext = extOf(f.path);
    if (ext === ".json") {
      try {
        JSON.parse(f.content);
      } catch (e) {
        return { ok: false, error: `${f.path}: invalid JSON (${(e as Error).message})` };
      }
      continue;
    }
    if (SYNTAX_EXTS.has(ext)) {
      const ts = await loadTypescript();
      if (!ts) return { ok: false, error: `${f.path}: no syntax validator available (typescript not loadable) — apply refused, use suggest` };
      const kind =
        ext === ".tsx"
          ? ts.ScriptKind.TSX
          : ext === ".jsx"
            ? ts.ScriptKind.JSX
            : ext === ".ts" || ext === ".mts" || ext === ".cts"
              ? ts.ScriptKind.TS
              : ts.ScriptKind.JS;
      const sf = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, true, kind);
      const diags = (sf as unknown as { parseDiagnostics?: readonly { messageText: string | import("typescript").DiagnosticMessageChain }[] }).parseDiagnostics ?? [];
      if (diags.length > 0) {
        return { ok: false, error: `${f.path}: syntax error — ${ts.flattenDiagnosticMessageText(diags[0].messageText, "\n")}` };
      }
      continue;
    }
    return { ok: false, error: `${f.path}: no deterministic validator for '${ext || "(no extension)"}' — apply refused, use suggest` };
  }
  return { ok: true };
};

/**
 * Untrusted text (the fix agent's summary, paths it returned, error messages) embedded in a
 * BOT-authored comment. The bot's comments are trusted by the loop's own detectors, so model text
 * must never be able to forge a control marker there: markers are neutralized, @-mentions are
 * defanged (a report must never ping a user) and length is bounded.
 */
export function sanitizeModelText(text: string | undefined, opts: { oneLine?: boolean; max?: number } = {}): string {
  return sanitizeUntrusted(text, opts);
}

/** Why a round became moot mid-flight: the head moved, the session ended, or a newer request
 * (a new session, or apply downgraded to suggest) took over. */
type Moot = "head" | "stopped" | "newer";
const MOOT_TEXT: Record<Moot, string> = {
  head: "the PR head moved",
  stopped: "the loop was stopped",
  newer: "a newer loop request took over",
};

/** How an applied round's report ends: continued, stopped by the operator, or why it could not. */
type ContinuationStatus = { ok: true } | { ok: false; stopped: true } | { ok: false; error: string };

function renderFixReport(res: FixRoundResult, mode: string, attempts: number, continuation?: ContinuationStatus): string {
  const files = (res.files ?? []).map((f) => `- \`${sanitizeModelText(f.path, { oneLine: true, max: 300 })}\``).join("\n");
  const tries = attempts > 1 ? `, attempt ${attempts}` : "";
  const summary = sanitizeModelText(res.summary);
  switch (res.outcome) {
    case "applied": {
      const tail = !continuation || continuation.ok
        ? "Loop continues: the next review is requested on the new head."
        : "stopped" in continuation
          ? "Loop stopped by the operator: no further review is requested."
          : `The next review could not be requested (${sanitizeModelText(continuation.error, { oneLine: true, max: 300 })}); see the loop handoff.`;
      return `### Ashlar fix agent — applied\n\nCommitted \`${res.commitSha ?? "(unknown)"}\` (mode: ${mode}${tries}).\n\n${summary}\n\nChanged:\n${files}\n\n${tail}`;
    }
    case "suggested":
      return `### Ashlar fix agent — suggestion (mode: ${mode}${tries})\n\n${summary}\n\nProposed changes (not pushed):\n${files}\n\nApply them and push — the loop continues on your push (use apply mode to auto-commit).`;
    case "no-change":
      return `### Ashlar fix agent — no change\n\n${summary || "All findings were pushed back / declined / deferred."}`;
    default:
      return `### Ashlar fix agent — ${res.outcome}\n\n${sanitizeModelText(res.error, { oneLine: true, max: 500 })}`;
  }
}

/** Production dependencies, loaded lazily so the static graph stays pure. */
async function productionDeps(settings: BotSettings): Promise<LoopRuntimeDeps> {
  // The GitHub client is the loop's only channel: if it cannot load, nothing can be posted (the
  // ONE unobservable failure — logged server-side by harbor). Provider transports load LAZILY
  // inside requestFix, so their failure is an ordinary request-failed → retry → fix-failed.
  const github = await import("./github.server.ts");
  const gh: LoopRuntimeGithub = {
    listPullReviews: github.listPullReviews,
    listReviewComments: github.listReviewComments,
    listIssueComments: github.listIssueComments,
    createIssueComment: github.createIssueComment,
    fetchPullHeadRef: github.fetchPullHeadRef,
    gitDataApi: github.gitDataApi,
    fetchUserPermission: github.fetchUserPermission,
  };
  // First provider: local (a plain request/response). chatgpt/grok ride the bridge's
  // awaiting_chat lifecycle and are wired separately.
  const requestFix: RequestFix = async (prompt, ctl) => {
    if (settings.fixAgent.provider !== "local") {
      throw new Error(`fix provider ${settings.fixAgent.provider} not wired yet (local only)`);
    }
    const local = await import("./local-chat-request.server.ts");
    const llm = await import("./local-llm.server.ts");
    return local.requestLocalChat(
      settings.localLlmBaseUrl,
      settings.localLlmApiKey,
      {
        model: settings.localLlmModel,
        messages: [
          { role: "system", content: "You are the Ashlar fix agent. Return ONLY the JSON object described in the prompt." },
          { role: "user", content: prompt },
        ],
        // The review path's tuned sampling + budget: without it a reasoning model decodes greedily,
        // loops, and ends at the token cap (finish_reason=length) before emitting the JSON.
        ...llm.samplingRequestFields(llm.localGenerationParams(settings)),
      },
      ctl?.signal,
      { onActivity: (a) => ctl?.onActivity?.(a.kind === "output" ? "generating" : "queued") },
    );
  };
  // Streaming (the default) reports queued vs generating, so the fix deadline can exclude queue time.
  // The transport's own streaming default (what requestLocalChat will actually do): a streamed
  // reply reports queued vs generating; a buffered one reports "generating" from its headers.
  // Transport unloadable → no activity (timed from send); requestFix then fails on its own import.
  const streaming =
    settings.fixAgent.provider === "local" &&
    (await import("./local-chat-request.server.ts").then((m) => m.localStreamingDefault(), () => false));
  return { gh, requestFix, validate: builtinValidate, fixReportsActivity: streaming };
}

type PrRef = { owner: string; repo: string; pr: number };

/** The PR's current loop session from durable GitHub history (fresh read). */
function sessionOf(gh: LoopRuntimeGithub, token: string, ref: PrRef, head: PullHead, botLogin: string): Promise<LoopSession> {
  return readLoopSession(gh, token, ref.owner, ref.repo, ref.pr, { botLogin, pr: head });
}

type ContinueOutcome = { posted: boolean; exists?: boolean; error?: string };

// ONE continuation per (PR, head, session). The push handler, a step whose head moved and an
// applied round can each ask for the live head's review: concurrent callers share one post
// (single flight), and a later caller finds the durable one and posts nothing.
const continuing = new Map<string, Promise<ContinueOutcome>>();

/** Request the next review of `head` with the fixed continuation marker — once per session. An
 * unreadable history fails toward posting: a duplicate request is only superseded by harbor,
 * while a missing one would stall the loop. Never throws. */
function ensureContinuation(
  gh: LoopRuntimeGithub,
  token: string,
  ref: PrRef,
  c: { head: string; mode: ReviewLoopMode; sinceIso?: string; botLogin: string; round?: number },
): Promise<ContinueOutcome> {
  if (!FULL_SHA_RE.test(c.head)) return Promise.resolve({ posted: false, error: "the head is not a full commit SHA" });
  const key = `${ref.owner}/${ref.repo}#${ref.pr}@${c.head}#${c.sinceIso ?? ""}`;
  const running = continuing.get(key);
  if (running) return running;
  const run = (async (): Promise<ContinueOutcome> => {
    const sinceMs = isoMs(c.sinceIso);
    const exists = await gh.listIssueComments(token, ref.owner, ref.repo, ref.pr).then(
      (rows) =>
        rows.some((r) => {
          if (!isSelfLogin(r.userLogin, c.botLogin)) return false;
          const k = canonicalContinuation(r.body, { authoredByBot: true });
          return k?.pr === ref.pr && k.head === c.head && (Number.isNaN(sinceMs) || isoMs(r.createdAt) >= sinceMs);
        }),
      () => false,
    );
    if (exists) return { posted: false, exists: true };
    try {
      const round =
        c.round ??
        (await reconstructRounds(gh, token, ref.owner, ref.repo, ref.pr, { botLogin: c.botLogin, sinceIso: c.sinceIso }).catch(() => [])).length + 1;
      const body = continueComment({ mode: c.mode, round: Math.min(Math.max(1, round), MAX_CONTINUE_ROUND), pr: ref.pr, head: c.head });
      await gh.createIssueComment(token, { owner: ref.owner, repo: ref.repo, pr: ref.pr, body });
      return { posted: true };
    } catch (e) {
      return { posted: false, error: (e as Error)?.message ?? String(e) };
    }
  })().finally(() => continuing.delete(key));
  continuing.set(key, run);
  return run;
}

/**
 * One post-review loop step. Fire-and-forget from harbor; never throws (a loop failure must
 * never un-post the review). Returns a structured result for logs/tests.
 *
 * The loop is PR state, not job state: any posted review on a PR whose durable session is
 * ACTIVE (review-loop-session.ts) is a loop round — the explicit start, the driver's
 * continuation, a push-triggered continuation, or a plain re-review requested mid-session.
 */
export async function runPostReviewLoop(
  token: string,
  job: Job,
  sample: SamplePr | undefined,
  settings: BotSettings,
  deps?: LoopRuntimeDeps,
  env: NodeJS.ProcessEnv | undefined = envOf(),
): Promise<LoopStepResult> {
  // Silent gates: the default off-path (no fix agent) or nothing to do. A zero-finding review
  // is CONVERGED — its clean review (total=0) is the terminal signal and ends the session.
  if (!loopEnabled(settings, env)) return { ran: false, reason: "disabled" };
  if (job.origin !== "github") return { ran: false, reason: "not a github job" };
  const findings = job.findings ?? [];
  if (findings.length === 0) return { ran: false, reason: "no findings (converged)" };

  const { owner, repo, pr, headSha } = job;
  const ref: PrRef = { owner, repo, pr };
  const botLogin = ashlarBotLogin(env);
  const cap = roundCap(env);
  let d: LoopRuntimeDeps | undefined = deps;
  let rounds: RoundSummary[] = [];
  let diffLines: number | undefined;
  let requested = false; // true once the durable session says a loop is active
  let sinceIso: string | undefined; // the session anchor (scopes rounds + handoff idempotency)
  const sleep = (ms: number) => (d?.sleep ?? realSleep)(ms);
  // Past the session gate the user asked for a loop: every stop that is not a supersession /
  // operator stop is ONE fixed ESCALATE (reason code + deterministic detail), never free text.
  // `head` is the commit the handoff is about: the reviewed head — or, once this round pushed,
  // the NEW head.
  const escalate = async (reason: EscalateReason, detail: string, head: string = headSha): Promise<LoopStepResult> => {
    if (!d) return { ran: false, reason: `ESCALATE ${reason} not posted (no GitHub client): ${detail}` };
    const post = () => escalateNow(d!.gh, token, { owner, repo, pr, head, reason, detail, rounds, roundCap: cap, diffLines, botLogin, sinceIso });
    try {
      let r = await post();
      if (r.error === ESCALATE_IN_FLIGHT) {
        // A terminal handoff has no other poster: wait for the concurrent one once, then retry (its
        // marker, if any, makes this a no-op). Still blocked → a LOGGED non-silent reason.
        await sleep(ESCALATE_BACKOFF_MS);
        r = await post();
        if (r.error === ESCALATE_IN_FLIGHT) return { ran: false, reason: `ESCALATE ${reason} not posted: another handoff for this head is in flight (detail: ${detail})` };
      }
      if (r.error) return { ran: false, reason: `ESCALATE ${reason} failed to post: ${r.error} (detail: ${detail})` };
      if (!r.escalated) return { ran: false, reason: ALREADY_ESCALATED };
      trace(job.id, "handoff", { reason, head: head.slice(0, 7) });
      return { ran: true, step: "escalated", reason, detail };
    } catch (e) {
      // escalateNow reports failures as {error}; even so a rejection never escapes (never throws).
      return { ran: false, reason: `ESCALATE ${reason} failed to post: ${(e as Error)?.message ?? String(e)} (detail: ${detail})` };
    }
  };

  const stepKey = `${owner}/${repo}#${pr}@${headSha}`;
  if (inFlightSteps.has(stepKey)) return { ran: false, reason: STEP_IN_FLIGHT };
  inFlightSteps.add(stepKey);
  try {
    d = deps ?? (await productionDeps(settings));
    const gh = d.gh;
    // A moved head supersedes this review: the LIVE head's review drives the loop. The push handler
    // (or the round that pushed) normally requested it already; asking again is idempotent, so a
    // missed push event can never stall an active loop.
    const continueOn = async (live: PullHead): Promise<void> => {
      if (live.sha === headSha) return;
      const now = await sessionOf(gh, token, ref, live, botLogin).catch(() => null);
      if (!now?.active) return;
      const r = await ensureContinuation(gh, token, ref, { head: live.sha, mode: now.mode ?? "suggest", sinceIso: now.startIso, botLogin });
      trace(job.id, "superseded", { live: live.sha.slice(0, 7), continuation: r.posted ? "posted" : r.exists ? "exists" : `failed: ${r.error}` });
    };
    const head = await gh.fetchPullHeadRef(token, owner, repo, pr);
    // Also the fork-push guard: a commit parented on a stale SHA would fast-forward over a
    // contributor's backward force-push.
    if (head.sha !== headSha) {
      await continueOn(head);
      return { ran: false, reason: SUPERSEDED };
    }
    const session = await sessionOf(gh, token, ref, head, botLogin);
    if (!session.active) return { ran: false, reason: NO_SESSION };
    requested = true;
    sinceIso = session.startIso;
    trace(job.id, "step", { pr, head: headSha.slice(0, 7), findings: findings.length });
    diffLines = diffLinesOf(head);
    if (!sample) return await escalate("loop-error", "no head-pinned snapshot for this review");

    // 1) Stuck or budget spent? Rounds are counted from the durable session anchor, so a
    //    re-issued start never resets the budget. The history must SHOW this review as the
    //    latest round (re-read with backoff for a lagging API).
    const escOpts = {
      owner,
      repo,
      pr,
      head: headSha,
      roundCap: cap,
      diffLines,
      botLogin,
      requireCurrentRound: true,
      sinceIso: session.startIso,
    };
    let esc = await maybeEscalate(gh, token, escOpts);
    for (const wait of HISTORY_RETRY_DELAYS_MS) {
      if (esc.error !== CURRENT_ROUND_MISSING) break;
      await sleep(wait);
      esc = await maybeEscalate(gh, token, escOpts);
    }
    // A concurrent handoff for this head: wait once for it to land (its marker then ends the
    // session — the pre-fix checkpoint below sees that). Still in flight → a LOGGED reason.
    if (esc.error === ESCALATE_IN_FLIGHT) {
      await sleep(ESCALATE_BACKOFF_MS);
      esc = await maybeEscalate(gh, token, escOpts);
      if (esc.error === ESCALATE_IN_FLIGHT) return { ran: false, reason: HANDOFF_IN_FLIGHT };
    }
    rounds = esc.rounds;
    if (esc.escalated) return { ran: true, step: "escalated", reason: esc.reason ?? "stuck" };
    // Stuck, but a handoff for this head already exists: never fix past an ESCALATE.
    if (esc.reason) return { ran: false, reason: ALREADY_ESCALATED };
    if (esc.error) return await escalate("loop-error", `could not verify the loop history: ${esc.error}`);

    // 2) One fix round on the head-pinned snapshot.
    const mode = effectiveLoopMode(session.mode, settings);
    if (mode === "apply") {
      // Apply writes the head branch through THIS repository's API: only a POSITIVELY verified
      // same-repository head may be written (a fork, or unknown provenance such as a deleted head
      // repository, is refused — never coerced into "safe").
      if (head.sameRepo !== true) {
        return await escalate(
          "loop-error",
          head.fork
            ? "apply on a fork PR: the installation token cannot push to a fork (use suggest mode)"
            : "apply needs a verified same-repository head; the PR's head repository is unknown or different (use suggest mode)",
        );
      }
      // Design §2: the loop WRITES code, so apply requires the session's starter (the latest
      // human start) to hold write access. Fail closed on a lookup failure.
      const starter = session.starter ?? "";
      let permission: string;
      try {
        permission = await gh.fetchUserPermission(token, owner, repo, starter);
      } catch (e) {
        return await escalate("loop-error", `could not verify write permission for ${starter || "(unknown)"}: ${(e as Error)?.message ?? String(e)}`);
      }
      if (!WRITE_PERMISSIONS.has(permission)) {
        return await escalate("loop-error", `apply requires write access; ${starter || "(unknown)"} has '${permission}' (re-run in suggest mode or by a maintainer)`);
      }
    }
    // Editable set = the PR's CHANGED files only. sample.files also carries policy/reference
    // context fetched for the review; those stay read-only and never enter allowedPaths.
    // A path the fix could never write (control characters, traversal) is not editable either.
    const changed = new Set(sample.changedPaths ?? []);
    const files = (sample.files ?? [])
      .filter((f) => changed.has(f.path) && isSafeFixPath(f.path))
      .map((f) => ({ path: f.path, content: f.content }));
    if (files.length === 0) return await escalate("loop-error", "no editable changed files in the snapshot");
    const basePrompt = buildFixPrompt({
      findings: renderFindings(findings),
      files,
      reviewer: settings.fixAgent.provider ?? undefined,
    });
    // ONE relevance predicate for every checkpoint of the round — before it starts, while queued,
    // at generation start, before a retry, before the commit and before a report: the PR head,
    // the session and (for apply) the session's mode must still be the ones this step started
    // from. Fresh reads, never cached: the world moves while a slow fix request runs.
    const relevance = async (): Promise<Moot | null> => {
      if ((await gh.fetchPullHeadRef(token, owner, repo, pr)).sha !== headSha) return "head";
      const now = await sessionOf(gh, token, ref, head, botLogin);
      if (!now.active) return "stopped";
      if (now.startIso !== session.startIso) return "newer";
      if (mode === "apply" && effectiveLoopMode(now.mode, settings) !== "apply") return "newer";
      return null;
    };
    let moot: Moot | undefined; // once a checkpoint finds the round moot it is never retried
    const checkpoint = async (): Promise<Moot | null> => {
      const why = await relevance();
      if (why) moot ??= why;
      return why;
    };
    // A moot round ends quietly: a moved head continues on the live head (idempotent); a stop or
    // a newer request already decides what comes next.
    const quietExit = async (why: Moot): Promise<LoopStepResult> => {
      if (why === "stopped") return { ran: false, reason: STOPPED_QUIET };
      if (why === "newer") return { ran: false, reason: NEWER_REQUEST };
      const live = await gh.fetchPullHeadRef(token, owner, repo, pr).catch(() => null);
      if (live) await continueOn(live);
      return { ran: false, reason: SUPERSEDED };
    };
    const before = await checkpoint();
    if (before) return await quietExit(before);
    // Re-verify relevance immediately before the commit path.
    const validate: FixValidate = async (candidate) => {
      const v = await d!.validate(candidate);
      if (!v.ok) return v;
      const why = await checkpoint();
      return why ? { ok: false, error: `${MOOT_TEXT[why]} during the fix` } : { ok: true };
    };
    const maxAttempts = fixAttempts(env);
    const deps2 = d;
    // The provider call runs under the watcher: the deadline excludes queue time, and a queued (or
    // just-started) request whose head moved or whose session ended is cancelled instead of
    // generated in full.
    const requestFix: RequestFix = (p) =>
      watchFixRequest((prompt, ctl) => deps2.requestFix(prompt, ctl), p, {
        generationMs: deps2.fixTimeoutMs ?? fixTimeoutMs(env),
        queueMaxMs: deps2.fixWatch?.queueMaxMs ?? fixQueueMaxMs(env),
        livenessMs: deps2.fixWatch?.livenessMs ?? localLivenessMs(env),
        checkEveryMs: deps2.fixWatch?.checkEveryMs ?? FIX_RELEVANCE_CHECK_MS,
        tickMs: deps2.fixWatch?.tickMs ?? FIX_WATCH_TICK_MS,
        reportsActivity: deps2.fixReportsActivity ?? false,
        stillWanted: async () => {
          const why = await checkpoint();
          return why ? MOOT_TEXT[why] : null;
        },
      });
    // Progress signal: the fix can wait long in a busy provider queue — a driver must be able to
    // tell "in progress" from "dead". Best effort: it never blocks or fails the round.
    await gh.createIssueComment(token, { owner, repo, pr, body: fixingComment({ round: rounds.length, pr, head: headSha }) }).catch(() => {});
    let prompt = basePrompt;
    let attempts = 0;
    let res: FixRoundResult;
    for (;;) {
      attempts += 1;
      const t0 = Date.now();
      trace(job.id, "fix-request", { attempt: attempts, promptChars: prompt.length, provider: settings.fixAgent.provider ?? "none" });
      res = await runFixRound(
        { requestFix, api: gh.gitDataApi(token, owner, repo), validate },
        {
          prompt,
          mode,
          branch: head.ref,
          baseCommitSha: headSha,
          message: `fix: apply ashlar review (PR #${pr}, ${headSha.slice(0, 7)})`,
          allowedPaths: files.map((f) => f.path),
        },
      );
      trace(job.id, "fix-result", { attempt: attempts, outcome: res.outcome, ms: Date.now() - t0, error: res.error });
      // A cancelled request or a refused commit (the round went moot) is never retried.
      if (moot && res.outcome !== "applied") return await quietExit(moot);
      if (!RETRYABLE.has(res.outcome) || attempts >= maxAttempts) break;
      const why = await checkpoint();
      if (why) return await quietExit(why);
      prompt = `${basePrompt}\n\n${retryFeedback(res)}`;
    }

    // 3) POST-COMMIT PHASE — the branch already moved, so from here every handoff names the NEW
    //    head. Order: the continuation (the control signal) FIRST, then the report, whose last
    //    line states what actually happened; a failure to continue is a loop-error handoff. An
    //    operator stop that landed meanwhile means no continuation at all.
    const afterCommit = async (done: FixRoundResult, tries: number): Promise<LoopStepResult> => {
      const newHead = done.commitSha && FULL_SHA_RE.test(done.commitSha) ? done.commitSha : undefined;
      // Our own commit moved the head, so only the SESSION decides here (an unreadable one does
      // not block: the next review re-checks it).
      const now = await sessionOf(gh, token, ref, newHead ? { ...head, sha: newHead } : head, botLogin).catch(() => null);
      let status: ContinuationStatus;
      if (now && (!now.active || now.startIso !== session.startIso)) {
        status = { ok: false, stopped: true };
      } else if (!newHead) {
        status = { ok: false, error: "the commit sha was not returned" };
      } else {
        // ALWAYS continue: the next review is CONVERGED, the next fix round, or — past the
        // budget — the round-cap handoff.
        const c = await ensureContinuation(gh, token, ref, { head: newHead, mode, sinceIso: session.startIso, botLogin, round: rounds.length + 1 });
        status = c.posted || c.exists ? { ok: true } : { ok: false, error: c.error ?? "the continuation was not posted" };
      }
      await gh.createIssueComment(token, { owner, repo, pr, body: renderFixReport(done, mode, tries, status) }).catch(() => {
        /* the report is informational; the continuation / handoff carries the signal */
      });
      if (status.ok) trace(job.id, "continued", { commit: newHead?.slice(0, 7), round: rounds.length + 1 });
      if (status.ok || "stopped" in status) {
        return { ran: true, step: "fix", outcome: done.outcome, commitSha: newHead ?? done.commitSha, continued: status.ok, attempts: tries };
      }
      const live = newHead ?? (await gh.fetchPullHeadRef(token, owner, repo, pr).then((h) => h.sha).catch(() => headSha));
      return await escalate("loop-error", `the fix was committed but the next review could not be requested: ${status.error}`, live);
    };

    if (res.outcome === "applied") return await afterCommit(res, attempts);
    // Nothing was pushed: a moot round (moved head, stop, newer request) makes ANY result moot —
    // a suggestion for a stale head included — so nothing is posted.
    const after = await checkpoint();
    if (after) return await quietExit(after);
    if (res.outcome === "suggested") {
      await gh.createIssueComment(token, { owner, repo, pr, body: renderFixReport(res, mode, attempts) });
      return { ran: true, step: "fix", outcome: res.outcome, continued: false, attempts };
    }
    if (res.outcome === "no-change") {
      // The agent's full rationale stays visible (sanitized); the handoff carries the signal.
      await gh.createIssueComment(token, { owner, repo, pr, body: renderFixReport(res, mode, attempts) });
      return await escalate("fix-declined", `no-change: ${res.summary ?? "every finding was pushed back / declined / deferred"}`);
    }
    return await escalate("fix-failed", `${res.outcome} after ${attempts} attempt(s): ${res.error ?? "no error detail"}`);
  } catch (e) {
    const reason = `loop step failed: ${(e as Error)?.message ?? String(e)}`;
    // Hand off only when a loop was requested; before the session is known a failure is a
    // server-side error (no PR noise on a PR that never asked for a loop).
    return requested ? await escalate("loop-error", reason) : { ran: false, reason };
  } finally {
    inFlightSteps.delete(stepKey);
  }
}

/**
 * A push to a PR whose loop session is ACTIVE continues the loop: the driver posts the fixed
 * continuation marker so the next review runs on the pushed head (design §5 — the loop runs
 * until CONVERGED / ESCALATE / STOPPED, not one round per command). The App's own push is
 * skipped: its fix round posts the continuation itself. `pushedAt` (the webhook's PR updated_at)
 * places the push in the session, so a stale clean review of the previous head cannot end it.
 * Never throws.
 */
export async function continueLoopOnPush(
  token: string,
  push: { owner: string; repo: string; pr: number; headSha: string; actor: string; pushedAt?: string },
  settings: BotSettings,
  deps?: LoopRuntimeDeps,
  env: NodeJS.ProcessEnv | undefined = envOf(),
): Promise<{ posted: boolean; reason: string }> {
  try {
    if (!loopEnabled(settings, env)) return { posted: false, reason: "disabled" };
    const botLogin = ashlarBotLogin(env);
    if (isSelfLogin(push.actor, botLogin)) return { posted: false, reason: OWN_PUSH };
    const d = deps ?? (await productionDeps(settings));
    const head = await d.gh.fetchPullHeadRef(token, push.owner, push.repo, push.pr);
    // A later push will continue with its own head; never request a review of a stale one.
    if (head.sha !== push.headSha) return { posted: false, reason: SUPERSEDED };
    // The push itself is a session event: a clean review of the OLD head that lands after it
    // (before the continuation below exists) is stale and must not end the session.
    const moved = push.pushedAt ? [{ at: push.pushedAt, kind: "push" as const, head: push.headSha }] : [];
    const session = await readLoopSession(d.gh, token, push.owner, push.repo, push.pr, { botLogin, pr: head, extra: moved });
    if (!session.active) return { posted: false, reason: NO_SESSION };
    const c = await ensureContinuation(d.gh, token, push, { head: push.headSha, mode: session.mode ?? "suggest", sinceIso: session.startIso, botLogin });
    if (c.error) return { posted: false, reason: `continue on push failed: ${c.error}` };
    return { posted: c.posted, reason: c.posted ? "continued" : "already continued" };
  } catch (e) {
    return { posted: false, reason: `continue on push failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

// In-process serialization so concurrent stop deliveries for one PR post STOPPED at most once
// (the durable ack — the STOPPED marker — makes later deliveries no-ops).
const inFlightStop = new Set<string>();

/**
 * A human stop directive ends the active session (the session fold already treats it as
 * terminal); this posts the fixed STOPPED acknowledgement once. `stopAt` injects the stop from
 * the webhook itself, so a list API that has not caught up yet still sees it. Never throws.
 */
export async function stopLoop(
  token: string,
  stop: { owner: string; repo: string; pr: number; actor: string; stopAt?: string },
  settings: BotSettings,
  deps?: LoopRuntimeDeps,
  env: NodeJS.ProcessEnv | undefined = envOf(),
): Promise<{ posted: boolean; reason: string }> {
  const key = `${stop.owner}/${stop.repo}#${stop.pr}`;
  if (inFlightStop.has(key)) return { posted: false, reason: "stop already in flight" };
  inFlightStop.add(key);
  try {
    if (!loopEnabled(settings, env)) return { posted: false, reason: "disabled" };
    const botLogin = ashlarBotLogin(env);
    if (isSelfLogin(stop.actor, botLogin)) return { posted: false, reason: "bot-authored stop ignored" };
    const d = deps ?? (await productionDeps(settings));
    const head = await d.gh.fetchPullHeadRef(token, stop.owner, stop.repo, stop.pr);
    const extra = stop.stopAt ? [{ at: stop.stopAt, kind: "stop" as const, actor: stop.actor }] : [];
    const session = await readLoopSession(d.gh, token, stop.owner, stop.repo, stop.pr, { botLogin, pr: head, extra });
    // Only a stop that actually ended an active session, and is not yet acknowledged.
    if (session.active || session.endedBy !== "stop") return { posted: false, reason: NO_SESSION };
    await d.gh.createIssueComment(token, { owner: stop.owner, repo: stop.repo, pr: stop.pr, body: stoppedComment() });
    return { posted: true, reason: "stopped" };
  } catch (e) {
    return { posted: false, reason: `stop failed: ${(e as Error)?.message ?? String(e)}` };
  } finally {
    inFlightStop.delete(key);
  }
}
