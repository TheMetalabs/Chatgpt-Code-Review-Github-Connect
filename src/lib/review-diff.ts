/** Right-side line numbers GitHub will accept as pull-review comments. */

export function commentableRightLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file = "";
  let right = 0;
  for (const raw of String(diff || "").split("\n")) {
    const plusPlus = raw.match(/^\+\+\+ b\/(.+)$/);
    if (plusPlus) {
      file = plusPlus[1].trim();
      if (!map.has(file)) map.set(file, new Set());
      continue;
    }
    const dashed = raw.match(/^--- ([^\s]+)/);
    if (dashed && !raw.startsWith("--- a/") && !raw.startsWith("--- /dev/null")) {
      const name = dashed[1].replace(/^b\//, "").trim();
      if (name && name !== "/dev/null") {
        file = name;
        if (!map.has(file)) map.set(file, new Set());
      }
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      right = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("-") && !raw.startsWith("---")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      const set = map.get(file) ?? new Set<number>();
      set.add(right);
      map.set(file, set);
      right += 1;
    }
  }
  return map;
}

export function snapToCommentableLine(file: string, line: number, map: Map<string, Set<number>>): number | null {
  const set = map.get(file);
  if (!set || !set.size) return null;
  if (set.has(line)) return line;
  for (let d = 1; d <= 8; d += 1) {
    if (set.has(line + d)) return line + d;
    if (set.has(line - d)) return line - d;
  }
  return null;
}

export function isReviewLineError(text: string): boolean {
  return /pull_request_review_thread\.line must be part of the diff|line must be part of the diff|Path is invalid|could not comment/i.test(
    String(text || ""),
  );
}