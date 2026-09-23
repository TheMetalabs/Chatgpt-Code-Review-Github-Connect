/**
 * Per-repository opt-out of the local-LLM review leg (operator env).
 *
 * WHY: the local LLM serves one request at a time and its queue is not FIFO, so a busy set of
 * repositories can hold another repository's reviews for hours — e.g. ashlar's own PRs, whose
 * review loop gates every other lane. The operator can route listed repositories to the chat
 * reviewers only, without touching the global reviewer settings every other repository uses.
 *
 * CONTRACT
 * - ASHLAR_LOCAL_REVIEW_SKIP_REPOS: "owner/repo" entries separated by commas or whitespace,
 *   case-insensitive; malformed entries are ignored. Unset or empty → no change anywhere.
 * - A listed repository is reviewed WITHOUT the local leg only while a chat reviewer is enabled:
 *   local is never dropped when it is the only reviewer (the job would go unreviewed).
 * - Read from the environment per job (never cached); a job keeps the providers fixed at its
 *   snapshot (Job.reviewProviders), so a change never alters a review already in flight.
 */
import { providersFromSettings, type ReviewProvider } from "./types.ts";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function envOf(): NodeJS.ProcessEnv | undefined {
  return typeof process !== "undefined" ? process.env : undefined;
}

export function localReviewSkipRepos(env: NodeJS.ProcessEnv | undefined = envOf()): Set<string> {
  const raw = env?.ASHLAR_LOCAL_REVIEW_SKIP_REPOS ?? "";
  return new Set(raw.split(/[\s,]+/).filter((s) => REPO_RE.test(s)).map((s) => s.toLowerCase()));
}

/** The reviewers for one repository: the global settings, minus the local leg when the operator
 * listed the repository and a chat reviewer remains. */
export function providersForRepo(
  settings: Parameters<typeof providersFromSettings>[0],
  owner: string,
  repo: string,
  env: NodeJS.ProcessEnv | undefined = envOf(),
): ReviewProvider[] {
  const providers = providersFromSettings(settings);
  if (!providers.includes("local") || !providers.some((p) => p !== "local")) return providers;
  return localReviewSkipRepos(env).has(`${owner}/${repo}`.toLowerCase()) ? providers.filter((p) => p !== "local") : providers;
}

