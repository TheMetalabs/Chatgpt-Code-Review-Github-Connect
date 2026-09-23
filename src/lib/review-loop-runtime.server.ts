/**
 * Review-loop runtime: the post-review step that makes the loop real (design §5 steps 4–8).
 *
 * After a loop-triggered review is posted, either ESCALATE (stuck) or run one fix round and
 * report it in-thread. Everything is gated OFF by default:
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
  | { ran: true; step: "fix"; outcome: string; commitSha?: string; error?: string };

const DEFAULT_ROUND_CAP = 8;

function envOf(): NodeJS.ProcessEnv | undefined {
  return typeof process !== "undefined" ? process.env : undefined;
}

/** Off unless the operator explicitly enabled the env flag AND configured a fix provider. */
export function loopEnabled(settings: BotSettings, env: NodeJS.ProcessEnv | undefined = envOf()): boolean {
  if (env?.ASHLAR_FIX_AGENT !== "1") return false;
  return settings.fixAgent?.provider != null;
}

function roundCap(env: NodeJS.ProcessEnv | undefined = envOf()): number {
  const n = Number(env?.ASHLAR_LOOP_ROUND_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_ROUND_CAP;
}

/** Loop session start = the CURRENT explicit /review-loop start for this PR: the most recent
 * start job at/before this job (in-memory). An older, finished session's start must not widen
 * the window, or its rounds would make a fresh session look stuck on its first review. */
export function loopSinceIso(job: Job, allJobs: readonly Job[]): string | undefined {
  const starts = allJobs
    .filter(
      (j) =>
        j.owner === job.owner && j.repo === job.repo && j.pr === job.pr && j.thread?.loop?.kind === "start" &&
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

/** Built-in deterministic pre-push gate for apply mode: non-empty, and JSON files must parse.
 * A typecheck-in-worktree validator is the stronger follow-up; this is the floor. */
export const builtinValidate: FixValidate = async (files: FixFile[]) => {
  for (const f of files) {
    if (!f.content.trim()) return { ok: false, error: `${f.path}: empty content` };
    if (f.path.endsWith(".json")) {
      try {
        JSON.parse(f.content);
      } catch (e) {
        return { ok: false, error: `${f.path}: invalid JSON (${(e as Error).message})` };
      }
    }
  }
  return { ok: true };
};

function renderFixReport(res: Awaited<ReturnType<typeof runFixRound>>, mode: string): string {
  const files = (res.files ?? []).map((f) => `- \`${f.path}\``).join("\n");
  switch (res.outcome) {
    case "applied":
      return `### Ashlar fix agent — applied\n\nCommitted \`${res.commitSha}\` (mode: ${mode}).\n\n${res.summary ?? ""}\n\nChanged:\n${files}`;
    case "suggested":
      return `### Ashlar fix agent — suggestion (mode: ${mode})\n\n${res.summary ?? ""}\n\nProposed changes (not pushed):\n${files}\n\nApply via \`/review-loop apply\` to auto-commit.`;
    case "no-change":
      return `### Ashlar fix agent — no change\n\n${res.summary ?? "All findings were pushed back / declined / deferred."}`;
    default:
      return `### Ashlar fix agent — ${res.outcome}\n\n${res.error ?? ""}`;
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
    if (!loopEnabled(settings, env)) return { ran: false, reason: "disabled" };
    if (job.thread?.loop?.kind !== "start") return { ran: false, reason: "not a /review-loop review" };
    if (job.origin !== "github") return { ran: false, reason: "not a github job" };
    if (job.isFork) return { ran: false, reason: "fork PR (cannot push)" };
    const findings = job.findings ?? [];
    if (findings.length === 0) return { ran: false, reason: "no findings (converged)" };
    if (!sample) return { ran: false, reason: "no snapshot" };

    const d = deps ?? (await productionDeps(settings));
    const { owner, repo, pr, headSha } = job;

    // 1) Stuck? Hand off with the fixed ESCALATE signal and stop (no fix attempt).
    const esc = await maybeEscalate(d.gh, token, {
      owner,
      repo,
      pr,
      head: headSha,
      roundCap: roundCap(env),
      sinceIso: loopSinceIso(job, allJobs),
    });
    if (esc.escalated) return { ran: true, step: "escalated", reason: esc.reason ?? "stuck" };

    // 2) Otherwise run ONE fix round on the head-pinned snapshot.
    const head = await d.gh.fetchPullHeadRef(token, owner, repo, pr);
    if (head.fork) return { ran: false, reason: "fork PR (cannot push)" };
    // The live branch must still point at the reviewed SHA: a commit parented on a stale SHA
    // would fast-forward over a contributor's backward force-push. Fail closed.
    if (head.sha !== headSha) return { ran: false, reason: `head moved (${headSha.slice(0, 7)} → ${head.sha.slice(0, 7)})` };
    // Editable set = the PR's CHANGED files only. sample.files also carries policy/reference
    // context fetched for the review; those stay read-only and never enter allowedPaths.
    const changed = new Set(sample.changedPaths ?? []);
    const files = (sample.files ?? []).filter((f) => changed.has(f.path)).map((f) => ({ path: f.path, content: f.content }));
    if (files.length === 0) return { ran: false, reason: "no editable changed files in snapshot" };
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
    await d.gh.createIssueComment(token, { owner, repo, pr, body: renderFixReport(res, mode) });
    return { ran: true, step: "fix", outcome: res.outcome, commitSha: res.commitSha, error: res.error };
  } catch (e) {
    return { ran: false, reason: `loop step failed: ${(e as Error)?.message ?? String(e)}` };
  }
}
