// One process-wide creation order shared by review jobs (harbor) and review-loop fix items
// (bridge-fix registry). createdAt is a millisecond display timestamp: two items created in the
// same millisecond tie on it, so the cross-kind take order breaks that tie with this sequence.
// Kept on globalThis so a module duplicated by the dev server's reload still draws from one
// counter; it is strictly increasing within the process and never reused.

const KEY = Symbol.for("ashlar.creationSeq");
type SeqHolder = { [KEY]?: number };

/** The next creation sequence number (1, 2, 3, ...), assigned once when an item is created. */
export function nextCreationSeq(): number {
  const holder = globalThis as SeqHolder;
  const next = (holder[KEY] ?? 0) + 1;
  holder[KEY] = next;
  return next;
}

/** Strict creation order: `a` was created before `b`. Equal milliseconds are ordered by the
 * sequence only when both carry one; otherwise they are not ordered (the caller keeps its
 * legacy precedence). */
export function createdBefore(a: { createdAt: number; createdSeq?: number }, b: { createdAt: number; createdSeq?: number }): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return typeof a.createdSeq === "number" && typeof b.createdSeq === "number" && a.createdSeq < b.createdSeq;
}
