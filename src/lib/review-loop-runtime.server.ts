/**
 * Review-loop runtime: the post-review step that makes the loop real (design §5 steps 4–8).
 *
 * Each call is ONE loop step for one posted review: either ESCALATE (stuck) or run one fix
 * round and report it in-thread. The loop REPEATS because an applied round posts the fixed
 * continuation marker (review-loop.ts continueComment); its webhook starts the next review on
 * the new head, whose post-review step runs again — until CONVERGED (a clean review), an
 * ESCALATE handoff, or the round cap. Everything is gated OFF by default:
 *   - env ASHLAR_FIX_AGENT=1 AND settings.fixAgent.provider != null (design §6b), AND
 *   - the review was triggered by `/review-loop` (job.thread.loop is a start directive), AND
 *   - github origin, same-repo (not a fork — the installation token cannot push to a fork),
 *     with findings on HEAD.
 *
 * Static imports are pure/DI-only modules; the production GitHub + provider transport are
 * loaded by DYNAMIC import inside the gate, so the harbor test fixture (which links a strict
 * github.server stub) is untouched and the fix path never runs in tests unless injected.
 */
import { buildFixPrompt, runFixRound, type FixValidate, type RequestFix } from "./fix-agent.ts";
import type { GitDataApi } from "./fix-commit.ts";
import type { FixFile } from "./fix-apply.ts";
import { maybeEscalate, type ReviewLoopGithub } from "./review-loop-engine.server.ts";
import { continueComment, isSelfLogin, MAX_CONTINUE_ROUND, neutralizeMarkers, resolveBotLogin } from "./review-loop.ts";
import type { BotSettings, Finding, Job, SamplePr } from "./types.ts";

export interface LoopRuntimeGithub extends ReviewLoopGithub {
  fetchPullHeadRef(token: string, owner: string, repo: string, pr: number): Promise<{ ref: string; sha: string; fork: boolean }>;
  gitDataApi(token: string, owner: string, repo: string): GitDataApi;
}

export interface LoopRuntimeDeps {
  gh: LoopRuntimeGithub;
  requestFix: RequestFix;
  validate: FixValidate;
}

export type LoopStepResult =
  | { ran: false; reason: string }
  | { ran: true; step: "escalated"; reason: string }
  | { ran: true; step: "fix"; outcome: string; commitSha?: string; error?: string; continued?: boolean };

/** Benign non-run reasons: the default off-path. Anything else is a halt the user should see. */
export const SILENT_REASONS: readonly string[] = ["disabled", "not a /review-loop review", "not a github job", "no findings (converged)"];

const DEFAULT_ROUND_CAP = 8;

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

/** ASHLAR_LOOP_ROUND_CAP, bounded so every continuation round the loop can request stays
 * inside the continuation marker's contract (MAX_CONTINUE_ROUND). */
function roundCap(env: NodeJS.ProcessEnv | undefined = envOf()): number {
  const n = Number(env?.ASHLAR_LOOP_ROUND_CAP);
  // Continuation is emitted while rounds < cap, so the largest requested round equals the cap —
  // which the marker contract accepts up to MAX_CONTINUE_ROUND inclusive.
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_CONTINUE_ROUND) : DEFAULT_ROUND_CAP;
}

/** Loop session start = the CURRENT explicit /review-loop start for this PR: the most recent
 * start job at/before this job (in-memory) that the App itself did NOT post. The App's own
 * continuation triggers belong to the same session and never reset the window; an older,
 * finished session's start must not widen it either. Identity is the EXACT resolved App login
 * (the same one the webhook parser and round attribution use) — a human whose login happens to
 * equal the mention handle, or another App, still starts a session. */
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
 * BOT-authored comment. Bot comments are trusted by the loop's own detectors, so model text must
 * never be able to forge a control marker there: markers are neutralized, @-mentions are defanged
 * (a report must never ping a user) and length is bounded.
 */
export function sanitizeModelText(text: string | undefined, opts: { oneLine?: boolean; max?: number } = {}): string {
  let t = neutralizeMarkers(String(text ?? "")).replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
  if (opts.oneLine) t = t.replace(/\s+/g, " ").trim();
  const max = opts.max ?? 4000;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function renderFixReport(res: Awaited<ReturnType<typeof runFixRound>>, mode: string, continued = false, continueError?: string): string {
  const files = (res.files ?? []).map((f) => `- \`${sanitizeModelText(f.path, { oneLine: true, max: 300 })}\``).join("\n");
  const summary = sanitizeModelText(res.summary);
  switch (res.outcome) {
    case "applied":
      return `### Ashlar fix agent — applied\n\nCommitted \`${res.commitSha}\` (mode: ${mode}).\n\n${summary}\n\nChanged:\n${files}\n\n${
        continued
          ? "Loop continues: next review requested on the new head."
          : continueError
            ? `The next review could not be requested (${sanitizeModelText(continueError, { oneLine: true, max: 300 })}).`
            : "Loop paused: round cap reached — review the trend before continuing."
      }`;
    case "suggested":
      return `### Ashlar fix agent — suggestion (mode: ${mode})\n\n${summary}\n\nProposed changes (not pushed):\n${files}\n\nApply via \`/review-loop apply\` to auto-commit.`;
    case "no-change":
      return `### Ashlar fix agent — no change\n\n${summary || "All findings were pushed back / declined / deferred."}`;
    default:
      return `### Ashlar fix agent — ${res.outcome}\n\n${sanitizeModelText(res.error, { oneLine: true, max: 500 })}`;
  }
}

/** Production dependencies, loaded lazily so the static graph stays pure. */
async function productionDeps(settings: BotSettings): Promise<LoopRuntimeDeps> {
  const github = await import("./github.server.ts");
  const local = await import("./local-chat-request.server.ts");
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
  const requestFix: RequestFix = async (prompt) => {
    if (settings.fixAgent.provider !== "local") {
      throw new Error(`fix provider ${settings.fixAgent.provider} not wired yet (local only)`);
    }
    return local.requestLocalChat(settings.localLlmBaseUrl, settings.localLlmApiKey, {
      model: settings.localLlmModel,
      messages: [
        { role: "system", content: "You are the Ashlar fix agent. Return ONLY the JSON object described in the prompt." },
        { role: "user", content: prompt },
      ],
      max_tokens: settings.localReviewMaxTokens,
    });
  };
  return { gh, requestFix, validate: builtinValidate };
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
  try {
    // Silent gates: the default off-path (no user asked for a loop here, or nothing to do).
    if (!loopEnabled(settings, env)) return { ran: false, reason: "disabled" };
    if (job.thread?.loop?.kind !== "start") return { ran: false, reason: "not a /review-loop review" };
    if (job.origin !== "github") return { ran: false, reason: "not a github job" };
    const findings = job.findings ?? [];
    if (findings.length === 0) return { ran: false, reason: "no findings (converged)" };

    // From here the user asked for a loop: every halt is reported in-thread, never swallowed.
    const d = deps ?? (await productionDeps(settings));
    const { owner, repo, pr, headSha } = job;
    const halt = async (reason: string): Promise<LoopStepResult> => {
      await d.gh.createIssueComment(token, { owner, repo, pr, body: `### Ashlar review-loop — halted before fix\n\n${sanitizeModelText(reason, { oneLine: true, max: 500 })}` }).catch(() => {});
      return { ran: false, reason };
    };
    if (job.isFork) return halt("fork PR: the installation token cannot push to a fork");
    if (!sample) return halt("no head-pinned snapshot for this review");

    // 1) Stuck? Hand off with the fixed ESCALATE signal and stop (no fix attempt).
    const cap = roundCap(env);
    const esc = await maybeEscalate(d.gh, token, {
      owner,
      repo,
      pr,
      head: headSha,
      roundCap: cap,
      botLogin: ashlarBotLogin(env),
      sinceIso: loopSinceIso(job, allJobs, ashlarBotLogin(env)),
    });
    if (esc.escalated) return { ran: true, step: "escalated", reason: esc.reason ?? "stuck" };
    if (esc.error) return halt(`could not reconstruct the loop history: ${esc.error}`);

    // 2) Otherwise run ONE fix round on the head-pinned snapshot.
    const head = await d.gh.fetchPullHeadRef(token, owner, repo, pr);
    if (head.fork) return halt("fork PR: the installation token cannot push to a fork");
    // The live branch must still point at the reviewed SHA: a commit parented on a stale SHA
    // would fast-forward over a contributor's backward force-push. Fail closed.
    if (head.sha !== headSha) return halt(`head moved (${headSha.slice(0, 7)} → ${head.sha.slice(0, 7)}); re-run /review-loop on the new head`);
    // Editable set = the PR's CHANGED files only. sample.files also carries policy/reference
    // context fetched for the review; those stay read-only and never enter allowedPaths.
    const changed = new Set(sample.changedPaths ?? []);
    const files = (sample.files ?? []).filter((f) => changed.has(f.path)).map((f) => ({ path: f.path, content: f.content }));
    if (files.length === 0) return halt("no editable changed files in the snapshot");
    const mode = effectiveFixMode(job, settings);
    const prompt = buildFixPrompt({
      findings: renderFindings(findings),
      files,
      reviewer: settings.fixAgent.provider ?? undefined,
    });
    // Re-verify the live head immediately before the commit path (the fix request can be slow).
    const validate: FixValidate = async (candidate) => {
      const v = await d.validate(candidate);
      if (!v.ok) return v;
      const live = await d.gh.fetchPullHeadRef(token, owner, repo, pr);
      return live.sha === headSha ? { ok: true } : { ok: false, error: `head moved during fix (${headSha.slice(0, 7)} → ${live.sha.slice(0, 7)})` };
    };
    const res = await runFixRound(
      { requestFix: d.requestFix, api: d.gh.gitDataApi(token, owner, repo), validate },
      {
        prompt,
        mode,
        branch: head.ref,
        baseCommitSha: headSha,
        message: `fix: apply ashlar review (PR #${pr}, ${headSha.slice(0, 7)})`,
        allowedPaths: files.map((f) => f.path),
      },
    );
    // 3) Continue the loop after an APPLIED round (the commit triggers no loop by itself — the
    // phase-1 parser deliberately ignores a retained directive on synchronize). The driver posts
    // the FIXED continuation marker (never an @-mention / directive in prose: the webhook parser
    // ignores every other self-authored comment); loopSinceIso keeps it in this session.
    // Bounded: stop at the round cap (a strictly-improving loop reaches 0 = converged).
    const wantContinue = res.outcome === "applied" && esc.rounds.length < cap;
    // The continuation (the control signal) is posted FIRST; the report then states what
    // actually happened — it never announces "Loop continues" before the trigger exists.
    let continued = false;
    let continueError: string | undefined;
    if (wantContinue) {
      try {
        const continuation = continueComment({ mode, round: esc.rounds.length + 1, pr, head: res.commitSha ?? "" });
        await d.gh.createIssueComment(token, { owner, repo, pr, body: continuation });
        continued = true;
      } catch (e) {
        continueError = (e as Error)?.message ?? String(e);
      }
    }
    try {
      await d.gh.createIssueComment(token, { owner, repo, pr, body: renderFixReport(res, mode, continued, continueError) });
    } catch (e) {
      // Once the continuation exists the report is informational: the next round already runs, so
      // a failed report must never be turned into a halt. Otherwise it is the only signal.
      if (!continued) throw e;
    }
    // The fix is committed and the report already states that the next review could not be
    // requested — no second, contradictory "halted before fix" comment; the reason is logged.
    if (continueError) {
      return { ran: false, reason: `the fix was committed (${res.commitSha ?? "unknown sha"}) but the next review could not be requested: ${continueError}` };
    }
    return { ran: true, step: "fix", outcome: res.outcome, commitSha: res.commitSha, error: res.error, continued };
  } catch (e) {
    const reason = `loop step failed: ${(e as Error)?.message ?? String(e)}`;
    // Report when the user asked for a loop (deps exist past the silent gates); never throw.
    if (deps || job.thread?.loop?.kind === "start") {
      try {
        const d = deps ?? (await productionDeps(settings));
        await d.gh.createIssueComment(token, { owner: job.owner, repo: job.repo, pr: job.pr, body: `### Ashlar review-loop — halted before fix\n\n${sanitizeModelText(reason, { oneLine: true, max: 500 })}` });
      } catch {
        /* reporting is best-effort */
      }
    }
    return { ran: false, reason };
  }
}
