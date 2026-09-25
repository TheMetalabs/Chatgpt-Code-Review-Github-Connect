/**
 * Push a full-file change set as ONE atomic commit via the GitHub Git Data API
 * (design §6 mechanism A: no local checkout — the bot's installation token commits
 * blobs→tree→commit→ref). Orchestration is dependency-injected (GitDataApi) so it
 * unit-tests without the server graph; github.server binds the real implementation.
 *
 * WHY full-file blobs (not a patch): a blob is the complete new file, so the resulting
 * tree is exactly what the fix agent produced — no fragile diff-context apply.
 *
 * INVARIANTS (fail-closed): any step (base tree / blob / tree / commit) that throws aborts the
 * whole operation and the branch ref is NEVER moved — a partial failure leaves only orphan
 * blobs, which GitHub garbage-collects. The commit is atomic from the ref's point of view.
 * NON-GOALS: pushing to a fork's branch (the installation token can't); the caller gates forks.
 * RETRY: a transient failure retries the whole blob→tree→commit→ref sequence once (blobs and
 * trees are content-addressed; a second commit object is harmless until a ref points at it). A
 * ref update whose response was LOST is recognized, not repeated: if the live ref already points
 * at a commit this operation created, that is the success. A BranchMovedError (someone else moved
 * the branch) is never retried over.
 * BOUNDARY: GitHub's REST ref update has no compare-and-swap. updateBranchRef narrows the window
 * to one API round-trip (read ref → compare → write); the residual race is documented, and the
 * next review re-verifies head lineage. A true CAS would need a different write path.
 */
import type { FixFile } from "./fix-apply.ts";

/** The branch no longer points at the expected base: someone else moved it. Never retried over. */
export class BranchMovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchMovedError";
  }
}

const COMMIT_ATTEMPTS = 2;

export interface GitDataApi {
  /** The tree sha of an existing commit (the base for the new tree). */
  baseTreeSha(commitSha: string): Promise<string>;
  /** Create a blob from full file content; returns its sha. */
  createBlob(content: string): Promise<string>;
  /** Create a tree from base + file entries (path→blob sha); returns the tree sha. */
  createTree(baseTreeSha: string, entries: Array<{ path: string; sha: string }>): Promise<string>;
  /** Create a commit; returns its sha. */
  createCommit(message: string, treeSha: string, parentSha: string): Promise<string>;
  /** Move the branch ref to the commit ONLY if it still points at expectedOldSha (the reviewed
   * base). Implementations must check-then-write as tightly as the backend allows and throw on
   * a mismatch, so a backward force-push is never fast-forwarded over. */
  updateBranchRef(branch: string, commitSha: string, expectedOldSha: string): Promise<void>;
  /** The branch ref's current commit — lets a retry recognize a ref update that landed although its
   * response was lost. Optional: without it a lost response is reported as a failure. */
  readBranchRef?(branch: string): Promise<string>;
  /** path → git blob SHA of each path in a commit's tree (a path that is not a blob there is
   * absent). Optional: the GitHub fix source (fix-source-github.ts) needs it; without it that
   * fallback is unavailable. */
  blobShas?(commitSha: string, paths: readonly string[]): Promise<Map<string, string>>;
}

export type CommitResult = { ok: true; commitSha: string } | { ok: false; error: string };

export async function commitFiles(
  api: GitDataApi,
  opts: { branch: string; baseCommitSha: string; message: string; files: FixFile[] },
): Promise<CommitResult> {
  if (opts.files.length === 0) return { ok: false, error: "no files to commit" };
  const created: string[] = [];
  let lastError = "commit failed";
  for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
    try {
      const baseTree = await api.baseTreeSha(opts.baseCommitSha);
      const entries: Array<{ path: string; sha: string }> = [];
      for (const f of opts.files) {
        entries.push({ path: f.path, sha: await api.createBlob(f.content) });
      }
      const tree = await api.createTree(baseTree, entries);
      const commit = await api.createCommit(opts.message, tree, opts.baseCommitSha);
      created.push(commit);
      await api.updateBranchRef(opts.branch, commit, opts.baseCommitSha);
      return { ok: true, commitSha: commit };
    } catch (e) {
      lastError = (e as Error)?.message ?? String(e);
      // A lost response: the ref may already point at a commit THIS operation created.
      const live = api.readBranchRef ? await api.readBranchRef(opts.branch).catch(() => undefined) : undefined;
      if (live && created.includes(live)) return { ok: true, commitSha: live };
      if (e instanceof BranchMovedError) break; // a real move by someone else — never retry over it
    }
  }
  return { ok: false, error: lastError };
}
