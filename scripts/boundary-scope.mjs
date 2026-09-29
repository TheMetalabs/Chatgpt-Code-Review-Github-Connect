// Sub-file scopes for the local-LLM edit boundary (scripts/check-local-llm-boundary.mjs). A path-level
// allowlist cannot say "only this function of a shared file"; these helpers check a file's diff
// against such a scope, so an edit outside it (e.g. the frozen chat fix transport or loop control in
// review-loop-runtime.server.ts) still trips the boundary.

/** Hunks of a `git diff -U0` for one file: old/new start line and line count (1-based). */
export function hunkRanges(diff) {
  const out = [];
  for (const line of String(diff || "").split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    out.push({
      oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return out;
}

/** 1-based [first, last] lines of the top-level declaration whose line starts with `header`, through
 * the next line that is exactly "}" (the declaration's closing brace at column 0). null when absent. */
export function declarationSpan(text, header) {
  const lines = String(text || "").split("\n");
  const first = lines.findIndex((l) => l.startsWith(header));
  if (first < 0) return null;
  for (let i = first + 1; i < lines.length; i++) if (lines[i] === "}") return [first + 1, i + 1];
  return null;
}

const within = (span, a, b) => Boolean(span) && a >= span[0] && b <= span[1];

/** Every hunk of `diff` stays inside the declaration `header` in both the old and the new text.
 * Returns the hunks that do not (empty = confined). A pure insertion sits after old line `oldStart`,
 * a pure deletion after new line `newStart`; both must fall inside the span as well. */
export function hunksOutside(diff, oldText, newText, header) {
  const oldSpan = declarationSpan(oldText, header), newSpan = declarationSpan(newText, header);
  return hunkRanges(diff).filter((h) => {
    const oldOk = h.oldCount > 0 ? within(oldSpan, h.oldStart, h.oldStart + h.oldCount - 1) : within(oldSpan, h.oldStart, h.oldStart);
    const newOk = h.newCount > 0 ? within(newSpan, h.newStart, h.newStart + h.newCount - 1) : within(newSpan, h.newStart, h.newStart);
    return !(oldOk && newOk);
  });
}

/** Hunks of `diff` that remove or change existing lines (empty = the diff only adds lines). */
export function nonAdditiveHunks(diff) {
  return hunkRanges(diff).filter((h) => h.oldCount > 0);
}
