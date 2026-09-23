/**
 * Review-loop runtime: the post-review step that makes the loop real (design §5 steps 4–8).
 *
 * Each call is ONE loop step for one posted review: either ESCALATE (stuck / budget spent) or
 * run one fix round and report it in-thread. The loop REPEATS because an applied round posts
 * the fixed continuation marker (review-loop.ts continueComment); its webhook starts the next
 * review on the new head, whose post-review step runs again.
 *
 * TERMINATION CONTRACT (design §3/§5/§8): every loop step past the gates ends in a FIXED,
 * deterministic outcome — never a silent pause or free text:
 *   - CONVERGED: a clean review (total=0) — the gate below, nothing to fix;
 *   - ESCALATE (reason code): stuck, budget spent, or a fix round that cannot land
 *     (fix-failed / fix-declined / loop-error);
 *   - apply: the fixed "applied" report + continuation marker (the next review follows);
 *   - suggest: the fixed "suggestion" report — the designed hand-off (a human applies it and
 *     re-runs the loop; suggest never pushes, so there is no next head to review).
 * The fix-round budget (ASHLAR_LOOP_ROUND_CAP, default 5) is enforced at the next review: review
 * round N+1 verifies the N-th fix (clean → CONVERGED, else round-cap). The ONLY quiet exits are
 * supersession (a newer head drives the loop) and an existing handoff on this head.
 * Everything is gated OFF by default:
 *   - env ASHLAR_FIX_AGENT=1 AND settings.fixAgent.provider != null (design §6b), AND
 *   - the review was triggered by `/review-loop` (job.thread.loop is a start directive), AND
 *   - github origin, same-repo (not a fork — the installation token cannot push to a fork),
 *     with findings on HEAD.
 *
 * Static imports are pure/DI-only modules; the production GitHub + provider transport are
 * loaded by DYNAMIC import inside the gate, so the harbor test fixture (which links a strict
 * github.server stub) is untouched and the fix path never runs in tests unless injected.
 */
import { buildFixPrompt, runFixRound, type FixRoundResult, type FixValidate, type RequestFix } from "./fix-agent.ts";
import type { GitDataApi } from "./fix-commit.ts";
import type { FixFile } from "./fix-apply.ts";
import { watchFixRequest } from "./fix-request-watch.ts";
import { localLivenessMs } from "./local-leg-activity.ts";
import {
  CURRENT_ROUND_MISSING,
  ESCALATE_IN_FLIGHT,
  escalateNow,
  maybeEscalate,
  reconstructRounds,
  type ReviewLoopGithub,
} from "./review-loop-engine.server.ts";
import {
  continueComment,
  fixingComment,
  isSelfLogin,
  MAX_CONTINUE_ROUND,
  resolveBotLogin,
  sanitizeUntrusted,
  type EscalateReason,
  type RoundSummary,
} from "./review-loop.ts";
import type { BotSettings, Finding, Job, SamplePr } from "./types.ts";

export interface PullHead {
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

// One loop step per PR head at a time (in-process): a second posted review of the same head
// (re-request, redelivery) must not run a parallel fix round. Different heads never block each
// other — the older one is superseded at its head checks. Cross-process coordination is a
// NON-GOAL (single harbor instance; see the engine header).
const inFlightSteps = new Set<string>();

const SUPERSEDED = "superseded (head moved)";
const ALREADY_ESCALATED = "already escalated on this head";
const STEP_IN_FLIGHT = "another loop step is in flight for this head";

/** Benign non-run reasons: the default off-path and the designed quiet exits (a newer head
 * drives the loop / a handoff already ended it). Anything else is logged server-side. */
export const SILENT_REASONS: readonly string[] = [
  "disabled",
  "not a /review-loop review",
  "not a github job",
  "no findings (converged)",
  SUPERSEDED,
  ALREADY_ESCALATED,
  STEP_IN_FLIGHT,
];


/** Fix-round budget (design: at most 5 review→fix rounds, then a human decides). */
const DEFAULT_ROUND_CAP = 5;
/** Attempts per fix round for retryable outcomes (the reply was unusable, not the finding). */
const DEFAULT_FIX_ATTEMPTS = 2;
const RETRYABLE = new Set<FixRoundResult["outcome"]>(["request-failed", "parse-failed", "scope-violation", "validation-failed"]);
const HISTORY_RETRY_MS = 3000;
const ESCALATE_BACKOFF_MS = 1500;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

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

/** Loop session start = the CURRENT explicit /review-loop start for this PR: the most recent
 * start job at/before this job (in-memory) that the App itself did NOT post. The App's own
 * continuation triggers belong to the same session and never reset the window; an older,
 * finished session's start must not widen it either. Identity is the EXACT resolved App login
 * (the same one the webhook parser and round attribution use). */
export function loopSinceIso(job: Job, allJobs: readonly Job[], botLogin: string = ashlarBotLogin()): string | undefined {
  const starts = allJobs
    .filter(
      (j) =>
        j.owner === job.owner && j.repo === job.repo && j.pr === job.pr && j.thread?.loop?.kind === "start" &&
        !isSelfLogin(j.sender, botLogin) &&
        Number.isFinite(j.createdAt) && j.createdAt <= job.createdAt,
    )
    .map((j) => j.createdAt);
  if (starts.length === 0) return undefined;
  return new Date(Math.max(...starts)).toISOString();
}

/** Effective mode: the /review-loop command's mode, with the operator's global setting as a
 * permission CEILING — auto-push happens only when the command says `apply` AND the setting
 * allows `apply`. `suggest` anywhere means no push. */
export function effectiveFixMode(job: Job, settings: BotSettings): "suggest" | "apply" {
  const commanded = job.thread?.loop?.kind === "start" ? job.thread.loop.mode : "suggest";
  return commanded === "apply" && settings.fixAgent.mode === "apply" ? "apply" : "suggest";
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

const SYNTAX_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

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
        ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX : ext === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS;
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

/** How an applied round's report ends: the continuation was requested, or why it was not. */
type ContinuationStatus = { ok: true } | { ok: false; error: string };

function renderFixReport(res: FixRoundResult, mode: string, attempts: number, continuation?: ContinuationStatus): string {
  const files = (res.files ?? []).map((f) => `- \`${sanitizeModelText(f.path, { oneLine: true, max: 300 })}\``).join("\n");
  const tries = attempts > 1 ? `, attempt ${attempts}` : "";
  const summary = sanitizeModelText(res.summary);
  switch (res.outcome) {
    case "applied": {
      const tail = !continuation || continuation.ok
        ? "Loop continues: the next review is requested on the new head."
        : `The next review could not be requested (${sanitizeModelText(continuation.error, { oneLine: true, max: 300 })}); see the loop handoff.`;
      return `### Ashlar fix agent — applied\n\nCommitted \`${res.commitSha ?? "(unknown)"}\` (mode: ${mode}${tries}).\n\n${summary}\n\nChanged:\n${files}\n\n${tail}`;
    }
    case "suggested":
      return `### Ashlar fix agent — suggestion (mode: ${mode}${tries})\n\n${summary}\n\nProposed changes (not pushed):\n${files}\n\nApply them and push, then re-run the loop — or use apply mode to auto-commit.`;
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
  const streaming = envOf()?.ASHLAR_LOCAL_LLM_STREAM !== "false";
  return { gh, requestFix, validate: builtinValidate, fixReportsActivity: settings.fixAgent.provider === "local" && streaming };
}

/**
 * One post-review loop step. Fire-and-forget from harbor; never throws (a loop failure must
 * never un-post the review). Returns a structured result for logs/tests.
 */
export async function runPostReviewLoop(
  token: string,
  job: Job,
  sample: SamplePr | undefined,
  settings: BotSettings,
  allJobs: readonly Job[],
  deps?: LoopRuntimeDeps,
  env: NodeJS.ProcessEnv | undefined = envOf(),
): Promise<LoopStepResult> {
  // Silent gates: the default off-path (no user asked for a loop here, or nothing to do). A
  // zero-finding loop review is CONVERGED — its clean review (total=0) is the terminal signal.
  if (!loopEnabled(settings, env)) return { ran: false, reason: "disabled" };
  if (job.thread?.loop?.kind !== "start") return { ran: false, reason: "not a /review-loop review" };
  if (job.origin !== "github") return { ran: false, reason: "not a github job" };
  const findings = job.findings ?? [];

  const { owner, repo, pr, headSha } = job;
  const botLogin = ashlarBotLogin(env);
  const cap = roundCap(env);
  let d: LoopRuntimeDeps | undefined = deps;
  let rounds: RoundSummary[] = [];
  let diffLines: number | undefined;
  // Past the gates the user asked for a loop: every stop that is not a supersession is ONE
  // fixed ESCALATE (reason code + deterministic detail), never free text. `head` is the commit
  // the handoff is about: the reviewed head — or, once this round pushed, the NEW head.
  let sinceIso: string | undefined;
  const escalate = async (reason: EscalateReason, detail: string, head: string = headSha): Promise<LoopStepResult> => {
    if (!d) return { ran: false, reason: `ESCALATE ${reason} not posted (no GitHub client): ${detail}` };
    const post = () => escalateNow(d!.gh, token, { owner, repo, pr, head, reason, detail, rounds, roundCap: cap, diffLines, botLogin, sinceIso });
    let r = await post();
    if (r.error === ESCALATE_IN_FLIGHT) {
      // A terminal handoff has no other poster: wait for the concurrent one once, then retry (its
      // marker, if any, makes this a no-op). Still blocked → a LOGGED non-silent reason.
      await (d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))))(ESCALATE_BACKOFF_MS);
      r = await post();
      if (r.error === ESCALATE_IN_FLIGHT) return { ran: false, reason: `ESCALATE ${reason} not posted: another handoff for this head is in flight (detail: ${detail})` };
    }
    if (r.error) return { ran: false, reason: `ESCALATE ${reason} failed to post: ${r.error} (detail: ${detail})` };
    if (!r.escalated) return { ran: false, reason: ALREADY_ESCALATED };
    trace(job.id, "handoff", { reason, head: head.slice(0, 7) });
    return { ran: true, step: "escalated", reason, detail };
  };

  const stepKey = `${owner}/${repo}#${pr}@${headSha}`;
  if (inFlightSteps.has(stepKey)) return { ran: false, reason: STEP_IN_FLIGHT };
  inFlightSteps.add(stepKey);
  try {
    d = deps ?? (await productionDeps(settings));
    const gh = d.gh;
    sinceIso = loopSinceIso(job, allJobs, botLogin);
    trace(job.id, "step", { pr, head: headSha.slice(0, 7), findings: findings.length });
    const head = await gh.fetchPullHeadRef(token, owner, repo, pr);
    // The reviewed head is STALE (a push landed after the review started): neither a clean
    // verdict nor a fix applies to the live head. Request the live head's review so the loop
    // goes on there — a stale review never ends or stalls the loop. Also the fork-push guard: a
    // commit parented on a stale SHA would fast-forward over a contributor's backward force-push.
    if (head.sha !== headSha) {
      trace(job.id, "superseded", { live: head.sha.slice(0, 7) });
      if (FULL_SHA_RE.test(head.sha)) {
        const hist = await reconstructRounds(gh, token, owner, repo, pr, { botLogin, sinceIso }).catch(() => [] as RoundSummary[]);
        const mode = effectiveFixMode(job, settings);
        await gh
          .createIssueComment(token, { owner, repo, pr, body: continueComment({ mode, round: Math.min(hist.length + 1, MAX_CONTINUE_ROUND), pr, head: head.sha }) })
          .catch(() => {});
      }
      return { ran: false, reason: SUPERSEDED };
    }
    // CONVERGED on the LIVE head: its clean review (total=0) is the terminal signal.
    if (findings.length === 0) {
      trace(job.id, "converged");
      return { ran: false, reason: "no findings (converged)" };
    }
    diffLines = diffLinesOf(head);
    if (!sample) return await escalate("loop-error", "no head-pinned snapshot for this review");

    // 1) Stuck or budget spent? The history must SHOW this review as the latest round: the
    //    budget is only enforceable from an attributable history (one re-read for a lagging API).
    const escOpts = {
      owner,
      repo,
      pr,
      head: headSha,
      roundCap: cap,
      diffLines,
      botLogin,
      requireCurrentRound: true,
      sinceIso,
    };
    let esc = await maybeEscalate(gh, token, escOpts);
    if (esc.error === CURRENT_ROUND_MISSING) {
      await (d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(HISTORY_RETRY_MS);
      esc = await maybeEscalate(gh, token, escOpts);
    }
    rounds = esc.rounds;
    if (esc.escalated) return { ran: true, step: "escalated", reason: esc.reason ?? "stuck" };
    if (esc.error === ESCALATE_IN_FLIGHT) return { ran: false, reason: STEP_IN_FLIGHT };
    // Stuck, but a handoff for this head already exists: never fix past an ESCALATE.
    if (esc.reason) return { ran: false, reason: ALREADY_ESCALATED };
    if (esc.error) return await escalate("loop-error", `could not verify the loop history: ${esc.error}`);

    // 2) One fix round on the head-pinned snapshot.
    const mode = effectiveFixMode(job, settings);
    // Apply writes the head branch through THIS repository's API: only a POSITIVELY verified
    // same-repository head may be written (a fork, or unknown provenance such as a deleted head
    // repository, is refused — never coerced into "safe").
    if (mode === "apply" && head.sameRepo !== true) {
      return await escalate(
        "loop-error",
        head.fork
          ? "apply on a fork PR: the installation token cannot push to a fork (use suggest mode)"
          : "apply needs a verified same-repository head; the PR's head repository is unknown or different (use suggest mode)",
      );
    }
    // Editable set = the PR's CHANGED files only. sample.files also carries policy/reference
    // context fetched for the review; those stay read-only and never enter allowedPaths.
    const changed = new Set(sample.changedPaths ?? []);
    const files = (sample.files ?? []).filter((f) => changed.has(f.path)).map((f) => ({ path: f.path, content: f.content }));
    if (files.length === 0) return await escalate("loop-error", "no editable changed files in the snapshot");
    const basePrompt = buildFixPrompt({
      findings: renderFindings(findings),
      files,
      reviewer: settings.fixAgent.provider ?? undefined,
    });
    const superseded = async (): Promise<boolean> => (await gh.fetchPullHeadRef(token, owner, repo, pr)).sha !== headSha;
    // Re-verify the live head immediately before the commit path (the fix request can be slow).
    const validate: FixValidate = async (candidate) => {
      const v = await d!.validate(candidate);
      if (!v.ok) return v;
      return (await superseded()) ? { ok: false, error: "head moved during fix" } : { ok: true };
    };
    const maxAttempts = fixAttempts(env);
    const deps2 = d;
    // The provider call runs under the watcher: the deadline excludes queue time, a queued (or
    // just-started) request whose head moved is cancelled instead of generated in full.
    const requestFix: RequestFix = (p) =>
      watchFixRequest((prompt, ctl) => deps2.requestFix(prompt, ctl), p, {
        generationMs: deps2.fixTimeoutMs ?? fixTimeoutMs(env),
        queueMaxMs: deps2.fixWatch?.queueMaxMs ?? fixQueueMaxMs(env),
        livenessMs: deps2.fixWatch?.livenessMs ?? localLivenessMs(env),
        checkEveryMs: deps2.fixWatch?.checkEveryMs ?? FIX_RELEVANCE_CHECK_MS,
        tickMs: deps2.fixWatch?.tickMs ?? FIX_WATCH_TICK_MS,
        reportsActivity: deps2.fixReportsActivity ?? false,
        stillWanted: async () => ((await superseded()) ? "the PR head moved" : null),
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
      if (!RETRYABLE.has(res.outcome) || attempts >= maxAttempts) break;
      if (await superseded()) return { ran: false, reason: SUPERSEDED };
      prompt = `${basePrompt}\n\n${retryFeedback(res)}`;
    }

    // 3) POST-COMMIT PHASE — the branch already moved, so from here every handoff names the NEW
    //    head. Order: the continuation (the control signal) FIRST, then the report, whose last
    //    line states what actually happened; a failure to continue is a loop-error handoff.
    const afterCommit = async (done: FixRoundResult, tries: number): Promise<LoopStepResult> => {
      const newHead = done.commitSha && FULL_SHA_RE.test(done.commitSha) ? done.commitSha : undefined;
      let status: ContinuationStatus;
      if (!newHead) {
        status = { ok: false, error: "the commit sha was not returned" };
      } else {
        try {
          // ALWAYS continue: the next review is CONVERGED, the next fix round, or — past the
          // budget — the round-cap handoff.
          await gh.createIssueComment(token, { owner, repo, pr, body: continueComment({ mode, round: rounds.length + 1, pr, head: newHead }) });
          status = { ok: true };
        } catch (e) {
          status = { ok: false, error: (e as Error)?.message ?? String(e) };
        }
      }
      await gh.createIssueComment(token, { owner, repo, pr, body: renderFixReport(done, mode, tries, status) }).catch(() => {
        /* the report is informational; the continuation / handoff carries the signal */
      });
      if (status.ok) {
        trace(job.id, "continued", { commit: newHead?.slice(0, 7), round: rounds.length + 1 });
        return { ran: true, step: "fix", outcome: done.outcome, commitSha: newHead, continued: true, attempts: tries };
      }
      const live = newHead ?? (await gh.fetchPullHeadRef(token, owner, repo, pr).then((h) => h.sha).catch(() => headSha));
      return await escalate("loop-error", `the fix was committed but the next review could not be requested: ${status.error}`, live);
    };

    if (res.outcome === "applied") return await afterCommit(res, attempts);
    // Nothing was pushed: a moved head makes ANY result moot — a suggestion for a stale head
    // included — so the newer head's review drives the loop (quiet).
    if (await superseded()) return { ran: false, reason: SUPERSEDED };
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
    return await escalate("loop-error", `loop step failed: ${(e as Error)?.message ?? String(e)}`);
  } finally {
    inFlightSteps.delete(stepKey);
  }
}
