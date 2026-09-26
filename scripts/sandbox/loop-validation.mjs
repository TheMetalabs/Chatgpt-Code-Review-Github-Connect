// Review-loop validation sandbox (#79 validation 1). Not imported anywhere; the PR is closed unmerged.

/** Items of a 0-based page of `size`. */
export function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}

/** Mean of the numbers; 0 for an empty list. */
export function average(xs) {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i];
  return sum / xs.length;
}

/** Whether `s` is a 40-hex commit SHA. */
export function isFullSha(s) {
  return /^[0-9a-f]{40}$/.test(s);
}

/** Last `n` items of the list (n >= 0). */
export function lastN(items, n) {
  return items.slice(items.length - n);
}
