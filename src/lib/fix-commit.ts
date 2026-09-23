/**
 * Push a full-file change set as ONE atomic commit via the GitHub Git Data API
 * (design §6 mechanism A: no local checkout — the bot's installation token commits
 * blobs→tree→commit→ref). Orchestration is dependency-injected (GitDataApi) so it
 * unit-tests without the server graph; github.server binds the real implementation.
 *
 * WHY full-file blobs (not a patch): a blob is the complete new file, so the resulting
 * tree is exactly what the fix agent produced — no fragile diff-context apply.
 */
import type { FixFile } from "./fix-apply.ts";

export interface GitDataApi {
  /** The tree sha of an existing commit (the base for the new tree). */
  baseTreeSha(commitSha: string): Promise<string>;
  /** Create a blob from full file content; returns its sha. */
  createBlob(content: string): Promise<string>;
  /** Create a tree from base + file entries (path→blob sha); returns the tree sha. */
  createTree(baseTreeSha: string, entries: Array<{ path: string; sha: string }>): Promise<string>;
  /** Create a commit; returns its sha. */
  createCommit(message: string, treeSha: string, parentSha: string): Promise<string>;
  /** Fast-forward-or-move the branch ref to the commit. */
  updateBranchRef(branch: string, commitSha: string): Promise<void>;
}

export type CommitResult = { ok: true; commitSha: string } | { ok: false; error: string };

export async function commitFiles(
  api: GitDataApi,
  opts: { branch: string; baseCommitSha: string; message: string; files: FixFile[] },
): Promise<CommitResult> {
  if (opts.files.length === 0) return { ok: false, error: "no files to commit" };
  try {
    const baseTree = await api.baseTreeSha(opts.baseCommitSha);
    const entries: Array<{ path: string; sha: string }> = [];
    for (const f of opts.files) {
      entries.push({ path: f.path, sha: await api.createBlob(f.content) });
    }
    const tree = await api.createTree(baseTree, entries);
    const commit = await api.createCommit(opts.message, tree, opts.baseCommitSha);
    await api.updateBranchRef(opts.branch, commit);
    return { ok: true, commitSha: commit };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
