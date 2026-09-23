/**
 * Fix-agent orchestration (design §6): review findings → provider fix → PR commit.
 *
 * Pure + dependency-injected: `requestFix` (the provider transport — chat bridge or local)
 * and `GitDataApi` (the push) are injected, so this unit-tests without the server graph and
 * the transport/wiring is chosen by the caller (harbor) per `fixAgent` settings. The fix is
 * a full-file schema parsed deterministically (fix-apply); `suggest` mode returns the change
 * set for a proposal, `apply` mode commits it atomically (fix-commit).
 */
import { parseFixResponse, type FixFile } from "./fix-apply.ts";
import { commitFiles, type GitDataApi } from "./fix-commit.ts";

export type FixMode = "suggest" | "apply";

/** Provider transport: given the fix prompt, return the raw model reply. Injected. */
export type RequestFix = (prompt: string) => Promise<string>;

export interface FixRoundResult {
  ok: boolean;
  /** Parsed change set (present when the reply parsed), even in suggest mode. */
  files?: FixFile[];
  summary?: string;
  /** Set in apply mode on a successful push. */
  commitSha?: string;
  /** How the round ended, for logs / the loop driver. */
  outcome: "applied" | "suggested" | "parse-failed" | "commit-failed" | "scope-violation";
  error?: string;
}

/** Build the §6 fix prompt: content-based triage + whole-file re-audit + the full-file
 * output schema. Kept LLM-free and deterministic; the model fills it. */
export interface FixPromptFile {
  path: string;
  content: string; // head-pinned CURRENT content (the authoritative base for a full-file rewrite)
}

export function buildFixPrompt(input: {
  findings: string; // the posted review findings (verbatim)
  files: FixPromptFile[]; // in-scope files with their current content — the ONLY editable paths
  reviewer?: string;
}): string {
  const paths = input.files.map((f) => f.path);
  const fence = "```";
  const fileBlocks = input.files
    .map((f) => `### FILE: ${f.path}\n${fence}\n${f.content}\n${fence}`)
    .join("\n\n");
  return [
    "You are the fix agent for an automated code-review loop. Resolve the review below and",
    "return ONLY a JSON object with the full new content of every file you change.",
    "",
    "Rules (do not skip):",
    "1. Classify each finding by CONTENT, ignoring its P-tag: Fix / Push-back (rebut with",
    "   evidence) / Decline (reason) / Defer (issue# + code marker). Do NOT 'fix' a false",
    "   positive — you would plant a real bug to satisfy a fake one.",
    "2. Re-audit the WHOLE flagged file plus siblings; fix every instance of the finding's",
    "   defect class in one pass, with a call-site census of every entry point a guard protects.",
    "3. Nth same-class finding → remove the bad state (root cause), do not add another guard.",
    "4. Return the COMPLETE new content of each changed file by EDITING the CURRENT CONTENT",
    "   shown below — never a diff, never elisions like '// ... rest unchanged', never",
    "   reconstruct from memory. Only the paths shown below may be changed; any other path is",
    "   rejected. Unsafe/absolute/`..` paths are rejected.",
    "",
    `Editable files in scope: ${paths.join(", ") || "(none)"}`,
    "",
    "Output schema (return exactly this shape, no prose outside the JSON):",
    '{ "summary": "<what you changed and why>", "files": [ { "path": "<one of the paths above>", "content": "<full new file>" } ] }',
    "",
    "--- Current file contents (head-pinned; edit these) ---",
    fileBlocks || "(no files provided)",
    "",
    `--- Review findings${input.reviewer ? ` (${input.reviewer})` : ""} ---`,
    input.findings,
  ].join("\n");
}

/**
 * Run one fix round: request a fix from the provider, parse it deterministically, and in
 * `apply` mode commit it atomically. Fails closed — a parse failure or commit failure never
 * moves the branch, so the caller can fall back (another provider → coding agent → ESCALATE).
 */
export async function runFixRound(
  deps: { requestFix: RequestFix; api: GitDataApi },
  opts: {
    prompt: string;
    mode: FixMode;
    branch: string;
    baseCommitSha: string;
    message: string;
    /** The ONLY paths the fix may touch (the in-scope files). Out-of-scope paths are rejected
     * before any blob is created — a fix must not edit e.g. .github/workflows/*. */
    allowedPaths: string[];
  },
): Promise<FixRoundResult> {
  const raw = await deps.requestFix(opts.prompt);
  const parsed = parseFixResponse(raw);
  if (!parsed.ok) return { ok: false, outcome: "parse-failed", error: parsed.error };

  const allowed = new Set(opts.allowedPaths);
  const outOfScope = parsed.fix.files.filter((f) => !allowed.has(f.path)).map((f) => f.path);
  if (outOfScope.length > 0) {
    return { ok: false, outcome: "scope-violation", error: `out-of-scope paths: ${outOfScope.join(", ")}`, files: parsed.fix.files, summary: parsed.fix.summary };
  }

  if (opts.mode === "suggest") {
    return { ok: true, outcome: "suggested", files: parsed.fix.files, summary: parsed.fix.summary };
  }

  const commit = await commitFiles(deps.api, {
    branch: opts.branch,
    baseCommitSha: opts.baseCommitSha,
    message: opts.message,
    files: parsed.fix.files,
  });
  if (!commit.ok) {
    return { ok: false, outcome: "commit-failed", error: commit.error, files: parsed.fix.files, summary: parsed.fix.summary };
  }
  return { ok: true, outcome: "applied", commitSha: commit.commitSha, files: parsed.fix.files, summary: parsed.fix.summary };
}
