/**
 * Retrying one idempotent GitHub write (a control comment) under the write contract (#79 step 1).
 *
 * A failed write is either "rejected" (GitHub created nothing: a retry is safe) or "unknown" (it
 * may have landed: a 5xx after the row was created, a lost response). After an unknown outcome the
 * write is NEVER sent again — only `seen` is re-checked on the remaining schedule, so a list that
 * lags or fails can never turn one control signal into two. If the row never shows up the result
 * says so (`ambiguous`), instead of pretending the write failed cleanly. An attempt may also
 * WITHDRAW the write (`post` resolves `{ withdrawn }`: it sent nothing and the write is no longer
 * owed): no further attempt is made, and the result carries why (`withdrawn`).
 *
 * Pure: the outcome is read duck-typed (`outcome === "unknown"`, as github-transport's
 * GithubWriteError carries it), so loop modules need no transport import.
 */
export type WriteRetryResult<W = never> = { posted: true } | { exists: true } | { withdrawn: W } | { error: unknown; ambiguous: boolean };

export const writeOutcomeUnknown = (e: unknown): boolean => (e as { outcome?: unknown } | null)?.outcome === "unknown";

export async function retryWrite<W = never>(opts: {
  /** Delay before each attempt (the first is usually 0). */
  delays: readonly number[];
  sleep: (ms: number) => Promise<void>;
  /** Is the row already there? A failed read counts as "not seen". */
  seen: () => Promise<boolean>;
  /** Scan before the first attempt too (false when the caller just scanned). */
  scanFirst?: boolean;
  /** One attempt: sends the write (resolves), fails (throws), or withdraws it (`{ withdrawn }`). */
  post: () => Promise<void | { withdrawn: W }>;
}): Promise<WriteRetryResult<W>> {
  let error: unknown = new Error("the write was not attempted");
  let ambiguous = false;
  for (const [i, wait] of opts.delays.entries()) {
    if (wait) await opts.sleep(wait);
    if ((i > 0 || opts.scanFirst !== false) && (await opts.seen().catch(() => false))) return { exists: true };
    if (ambiguous) continue; // it may have landed: only look for it
    try {
      const sent = await opts.post();
      return sent ? { withdrawn: sent.withdrawn } : { posted: true };
    } catch (e) {
      error = e;
      ambiguous = writeOutcomeUnknown(e);
    }
  }
  return { error, ambiguous };
}
